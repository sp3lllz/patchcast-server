import * as crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.ts";
import type { Accounts } from "./accounts.ts";
import { AuthError, safeEqual, type Auth, type LoginLimiter } from "./auth.ts";
import { APP_CODE_MS, APP_REDIRECT, Expiring, FLOW_MS, OidcError, s256, safeReturnTo, type Flow, type FlowKind, type OidcClient } from "./oidc.ts";

export interface OidcDeps {
  config: Config; auth: Auth; accounts: Accounts; client: OidcClient | null; limiter: LoginLimiter;
  secure: (req: FastifyRequest) => boolean;
  sameOrigin: (req: FastifyRequest) => void;
  deviceName: (v: unknown, fallback: string) => string;
  startSession: (req: FastifyRequest, reply: FastifyReply, userId: number, via: "oidc", idToken: string) => unknown;
  deviceCreated: (userId: number) => void;
  now?: () => number;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const first = (v: unknown) => (typeof v === "string" ? v : "");
const COOKIE = "patchcast_oidc_";

export function oidcRoutes(r: FastifyInstance, d: OidcDeps) {
  const { config, auth, limiter } = d, base = config.basePath, now = d.now ?? Date.now;
  const flows = new Expiring<Flow>(2000, now);
  const codes = new Expiring<{ userId: number; challenge: string; deviceName: string; expires: number }>(2000, now);
  const provider = config.oidc?.providerName ?? "";
  const client = () => { if (!d.client) throw new OidcError("disabled", "OIDC is not configured"); return d.client; };

  // One cookie per attempt, so two tabs don't disturb each other. Lax (not Strict): it must come back on the provider's redirect.
  const cookieName = (state: string) => COOKIE + state.slice(0, 10);
  const setCookie = (req: FastifyRequest, reply: FastifyReply, state: string, value: string, maxAge: number) =>
    reply.header("set-cookie", `${cookieName(state)}=${value}; Path=${base}/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${d.secure(req) ? "; Secure" : ""}`);
  const cookie = (req: FastifyRequest, name: string) => {
    for (const part of (req.headers.cookie ?? "").split(";")) {
      const i = part.indexOf("=");
      if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
    }
    return "";
  };

  const MESSAGES: Record<string, [number, string, string]> = {
    disabled: [404, "Single sign-on is off", "This server has no single sign-on provider configured."],
    access_denied: [403, "Sign-in cancelled", `${provider} reported that the sign-in was cancelled or denied.`],
    not_allowed: [403, "Not allowed", `Your ${provider} account isn't in a group that may use this server. Ask its administrator.`],
    no_account: [403, "No account here", `No account on this server is linked to your ${provider} identity. Sign in with your password and link it under Settings, or ask the administrator.`],
    setup_first: [403, "Not set up yet", "This server has no administrator yet. Open its start page and complete the setup first."],
    linked_elsewhere: [409, "Already linked", `This ${provider} identity already belongs to another account on this server.`],
    already_linked: [409, "Already linked", `Your account is linked to a different ${provider} identity. Unlink that one first.`],
    expired: [400, "Sign-in expired", "This sign-in took too long, was already completed, or was started in another browser. Please try again."],
    bad_request: [400, "Invalid request", "The sign-in request was not valid."],
    rate_limited: [429, "Too many attempts", "Please wait a few minutes and try again."],
    provider_unreachable: [502, "Provider unavailable", `${provider} can't be reached right now. Please try again later.`],
    failed: [502, "Sign-in failed", `The answer from ${provider} could not be verified. Please try again; the server log says more.`],
  };
  const page = (reply: FastifyReply, code: string, back: [string, string] = ["/", "Back to Patchcast"]) => {
    const [status, title, text] = MESSAGES[code] ?? MESSAGES.failed;
    return reply.code(status).header("content-type", "text/html; charset=utf-8").header("cache-control", "no-store").send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · Patchcast</title>` +
      `<link rel="stylesheet" href="${base}/style.css?v=${config.version}"></head><body><main class="signin"><form><img src="${base}/icon.svg" alt=""><h1>${esc(title)}</h1>` +
      `<p class="sub">${esc(text)}</p><a class="btn primary wide" href="${base}${back[0]}">${esc(back[1])}</a></form></main></body></html>`);
  };
  const toApp = (reply: FastifyReply, flow: { appState: string | null }, params: Record<string, string>) => {
    const u = new URLSearchParams(params);
    if (flow.appState) u.set("state", flow.appState);
    return reply.header("cache-control", "no-store").redirect(`${APP_REDIRECT}?${u}`, 302);
  };
  const codeOf = (req: FastifyRequest, e: unknown): string => {
    if (!(e instanceof OidcError)) throw e;
    req.log.warn({ ip: req.ip, code: e.code, reason: e.message }, "oidc sign-in failed");
    return e.code;
  };

  const begin = async (req: FastifyRequest, reply: FastifyReply, kind: FlowKind): Promise<string> => {
    const b = await client().begin();
    const binding = crypto.randomBytes(32).toString("base64url");
    flows.set(b.state, { ...kind, nonce: b.nonce, verifier: b.verifier, binding: s256(binding), expires: now() + FLOW_MS });
    setCookie(req, reply, b.state, binding, FLOW_MS / 1000);
    return b.url;
  };
  /** The callback arrives on PUBLIC_URL, so the cookie has to be set there too. Moves over once; `h` stops loops behind a misconfigured proxy. */
  const onPublicUrl = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!config.publicUrl || `${req.protocol}://${req.host}` === config.publicUrl || (req.query as any).h === "1") return true;
    const u = new URL(config.publicUrl + req.url);
    u.searchParams.set("h", "1");
    if (u.origin !== config.publicUrl) { void page(reply, "bad_request"); return false; }
    void reply.redirect(u.toString(), 302);
    return false;
  };
  const start = async (req: FastifyRequest, reply: FastifyReply, kind: FlowKind) => {
    if (limiter.takeIp("oidc-start", req.ip, 60)) return page(reply, "rate_limited");
    try { return reply.header("cache-control", "no-store").redirect(await begin(req, reply, kind), 302); } catch (e) {
      const code = codeOf(req, e);
      return kind.kind === "app" && code !== "disabled" ? toApp(reply, kind, { error: code === "provider_unreachable" ? code : "failed" }) : page(reply, code);
    }
  };

  r.get("/auth/oidc/login", async (req, reply) => {
    if (!onPublicUrl(req, reply)) return reply;
    return start(req, reply, { kind: "web", returnTo: safeReturnTo((req.query as any).returnTo) });
  });

  r.get("/auth/oidc/app", async (req, reply) => {
    if (!d.client) return page(reply, "disabled");
    const q = req.query as Record<string, unknown>;
    const challenge = first(q.code_challenge), state = first(q.state);
    // Errors found before the redirect target is known to be the app's own are never redirected.
    if (q.redirect_uri !== APP_REDIRECT || !/^[\w-]{43}$/.test(challenge) || (q.code_challenge_method !== undefined && q.code_challenge_method !== "S256") || (q.state !== undefined && !/^[\w-]{8,128}$/.test(state)))
      return page(reply, "bad_request");
    if (!onPublicUrl(req, reply)) return reply;
    return start(req, reply, { kind: "app", challenge, deviceName: d.deviceName(q.device_name, "Phone"), appState: state || null });
  });

  r.get("/auth/oidc/callback", async (req, reply) => {
    if (!d.client) return page(reply, "disabled");
    if (limiter.takeIp("oidc-callback", req.ip, 20)) return page(reply, "rate_limited");
    const q = req.query as Record<string, unknown>, state = first(q.state);
    const flow = state ? flows.peek(state) : null;
    const got = state ? cookie(req, cookieName(state)) : "";
    if (!flow || !got || !safeEqual(s256(got), flow.binding)) {
      req.log.warn({ ip: req.ip, code: "expired", reason: flow ? "not bound to this browser" : "unknown state" }, "oidc sign-in failed");
      return page(reply, "expired");
    }
    flows.delete(state); // single use, whatever happens next
    setCookie(req, reply, state, "", 0);
    const fail = (code: string) => (flow.kind === "app" ? toApp(reply, flow, { error: MESSAGES[code] ? code : "failed" }) : page(reply, code, flow.kind === "link" ? ["/settings", "Back to Settings"] : ["/", "Back to sign-in"]));
    if (q.error !== undefined) {
      req.log.warn({ ip: req.ip, code: "provider_error", reason: /^[a-z_]{1,40}$/.test(first(q.error)) ? q.error : "?" }, "oidc sign-in failed");
      return fail(["access_denied", "login_required", "interaction_required", "consent_required"].includes(first(q.error)) ? "access_denied" : "failed");
    }
    const code = first(q.code);
    if (!code || code.length > 4096) return fail("bad_request");
    try {
      const id = await client().finish(code, q.iss === undefined ? undefined : first(q.iss), flow);
      limiter.successIp("oidc-callback", req.ip);
      if (flow.kind === "link") {
        if (!auth.sessionAlive(flow.sessionHash, flow.userId)) return fail("expired");
        d.accounts.link(flow.userId, id);
        req.log.info({ userId: flow.userId }, "oidc identity linked");
        return reply.redirect(`${base}/settings`, 302);
      }
      const { userId, created } = d.accounts.signIn(id);
      if (auth.userCount() > 0) auth.setupToken = null;
      req.log.info({ userId, created, for: flow.kind }, "oidc sign-in");
      if (flow.kind === "app") {
        const c = crypto.randomBytes(32).toString("base64url");
        codes.set(auth.hashToken(c), { userId, challenge: flow.challenge, deviceName: flow.deviceName, expires: now() + APP_CODE_MS });
        return toApp(reply, flow, { code: c });
      }
      d.startSession(req, reply, userId, "oidc", id.idToken);
      return reply.redirect(base + flow.returnTo, 302);
    } catch (e) { return fail(codeOf(req, e)); }
  });

  /** The app trades its one-time code and PKCE verifier for a device token. */
  r.post("/api/v1/auth/oidc/exchange", async (req, reply) => {
    d.sameOrigin(req); // native apps send neither Origin nor Sec-Fetch-Site
    if (!d.client) throw new AuthError(404, "oidc_disabled", "Single sign-on is off on this server");
    const wait = limiter.takeIp("oidc-exchange", req.ip, 20);
    if (wait) throw Object.assign(new AuthError(429, "rate_limited", `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.`), { wait });
    const b = (req.body ?? {}) as any, code = first(b.code), verifier = first(b.code_verifier);
    if (!/^[\w-]{43}$/.test(code) || !/^[\w.~-]{43,128}$/.test(verifier)) throw new AuthError(400, "bad_request", "code and code_verifier are required");
    const key = auth.hashToken(code), c = codes.peek(key);
    codes.delete(key); // a wrong verifier burns the code
    const user = c && safeEqual(s256(verifier), c.challenge) ? auth.user(c.userId) : null;
    if (!c || !user) throw new AuthError(401, "bad_code", "The sign-in code is wrong or has expired. Please sign in again.");
    limiter.successIp("oidc-exchange", req.ip);
    const dev = auth.createDevice(user.id, c.deviceName);
    reply.header("cache-control", "no-store");
    d.deviceCreated(user.id);
    return { token: dev.token, deviceId: dev.deviceId, user: { id: user.id, username: user.username, isAdmin: !!user.is_admin }, version: config.version };
  });

  return {
    /** Starts linking for a signed-in browser; answers with the provider URL to open. */
    beginLink: async (req: FastifyRequest, reply: FastifyReply, userId: number, sessionHash: string) => {
      if (limiter.takeIp("oidc-start", req.ip, 60)) throw new AuthError(429, "rate_limited", "Too many attempts. Try again later.");
      if (`${req.protocol}://${req.host}` !== config.publicUrl) throw new AuthError(400, "wrong_address", `Open ${config.publicUrl}${base}/ to link your account`);
      try { return { url: await begin(req, reply, { kind: "link", userId, sessionHash }) }; } catch (e) {
        const [status, , text] = MESSAGES[codeOf(req, e)] ?? MESSAGES.failed;
        throw new AuthError(status, "oidc", text);
      }
    },
  };
}
