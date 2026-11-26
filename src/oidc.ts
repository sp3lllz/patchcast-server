import * as crypto from "node:crypto";
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from "jose";
import type { OidcConfig } from "./config.ts";
import { FetchError, safeFetch } from "./net.ts";

/** What went wrong, as a code that is safe to show and log. Never carries tokens, secrets or provider text. */
export class OidcError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

interface Metadata {
  issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; userinfo_endpoint?: string; end_session_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[]; id_token_signing_alg_values_supported?: string[]; authorization_response_iss_parameter_supported?: boolean;
}
export interface Identity {
  issuer: string; sub: string; preferredUsername: string | null; name: string | null; email: string | null; groups: string[]; idToken: string;
}

// Asymmetric algorithms only: "none" and the HMAC family can never be accepted.
const ALGS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA", "Ed25519"];
const METADATA_MS = 3600_000, SKEW_S = 60;

const random = (n = 32) => crypto.randomBytes(n).toString("base64url");
export const s256 = (v: string) => crypto.createHash("sha256").update(v).digest("base64url");
const str = (v: unknown, max = 200): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** Authorization Code + PKCE client for one configured provider. */
export class OidcClient {
  readonly cfg: OidcConfig;
  readonly redirectUri: string;
  private allowHosts: Set<string>;
  private meta: { value: Metadata; at: number } | null = null;
  private loading: Promise<Metadata> | null = null;
  private jwks: { uri: string; get: ReturnType<typeof createRemoteJWKSet> } | null = null;

  constructor(cfg: OidcConfig, redirectUri: string, extraHosts: Set<string>) {
    this.cfg = cfg; this.redirectUri = redirectUri;
    // The issuer the administrator configured may be on a private address; anything else its metadata names may not.
    this.allowHosts = new Set([...extraHosts, new URL(cfg.issuer).host.toLowerCase()]);
  }

  private async fetchJson(url: string, what: string, o: { method?: "POST"; body?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; json: any }> {
    try {
      const r = await safeFetch(url, { ...o, maxBytes: 512 * 1024, timeoutMs: 15_000, maxRedirects: 0, allowHosts: this.allowHosts, headers: { accept: "application/json", ...o.headers } });
      let json: any = null;
      try { json = JSON.parse(r.bytes.toString("utf8")); } catch { /* reported by the caller */ }
      return { status: r.status, json };
    } catch (e: any) {
      throw new OidcError("provider_unreachable", `${what}: ${e instanceof FetchError ? e.code : "network"}`);
    }
  }

  /** Discovery document, cached for an hour. A stale copy is used while the provider can't be reached. */
  async metadata(): Promise<Metadata> {
    if (this.meta && Date.now() - this.meta.at < METADATA_MS) return this.meta.value;
    this.loading ??= this.discover().finally(() => { this.loading = null; });
    try { return await this.loading; } catch (e) {
      if (this.meta && e instanceof OidcError && e.code === "provider_unreachable") return this.meta.value;
      throw e;
    }
  }
  private async discover(): Promise<Metadata> {
    const { status, json: m } = await this.fetchJson(`${this.cfg.issuer}/.well-known/openid-configuration`, "discovery");
    if (status !== 200 || !m || typeof m !== "object") throw new OidcError("provider_unreachable", `discovery: HTTP ${status}`);
    if (typeof m.issuer !== "string" || m.issuer.replace(/\/+$/, "") !== this.cfg.issuer) throw new OidcError("bad_provider", "discovery: issuer does not match OIDC_ISSUER");
    const secure = this.cfg.issuer.startsWith("https:");
    for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri", "userinfo_endpoint", "end_session_endpoint"]) {
      if (m[k] === undefined && (k === "userinfo_endpoint" || k === "end_session_endpoint")) continue;
      let u: URL;
      try { u = new URL(m[k]); } catch { throw new OidcError("bad_provider", `discovery: ${k} is missing or invalid`); }
      if (u.protocol !== "https:" && (secure || u.protocol !== "http:")) throw new OidcError("bad_provider", `discovery: ${k} is not https`);
    }
    this.meta = { value: m, at: Date.now() };
    return m;
  }

  private keys(uri: string) {
    if (this.jwks?.uri !== uri) {
      this.jwks = {
        uri,
        get: createRemoteJWKSet(new URL(uri), {
          cacheMaxAge: 600_000, cooldownDuration: 5_000, // an unknown key id (rotation) refetches, at most every 5 s
          [customFetch]: async (u: string) => {
            const r = await this.fetchJson(u, "jwks");
            return new Response(JSON.stringify(r.json ?? {}), { status: r.status, headers: { "content-type": "application/json" } });
          },
        }),
      };
    }
    return this.jwks.get;
  }

  async begin(): Promise<{ url: string; state: string; nonce: string; verifier: string }> {
    const m = await this.metadata();
    const state = random(), nonce = random(), verifier = random(48);
    const u = new URL(m.authorization_endpoint);
    for (const [k, v] of Object.entries({
      response_type: "code", client_id: this.cfg.clientId, redirect_uri: this.redirectUri, scope: this.cfg.scopes, state, nonce, code_challenge: s256(verifier), code_challenge_method: "S256",
    })) u.searchParams.set(k, v);
    return { url: u.toString(), state, nonce, verifier };
  }

  /** Redeems the code and returns the verified identity. `iss` is the authorization response's issuer parameter, if any. */
  async finish(code: string, iss: string | undefined, flow: { nonce: string; verifier: string }): Promise<Identity> {
    const m = await this.metadata();
    if (iss !== undefined ? iss !== m.issuer : m.authorization_response_iss_parameter_supported) throw new OidcError("bad_response", "authorization response issuer mismatch");
    const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: this.redirectUri, code_verifier: flow.verifier });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    const methods = m.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
    if (!this.cfg.clientSecret) form.set("client_id", this.cfg.clientId);
    else if (methods.includes("client_secret_basic") || !methods.includes("client_secret_post")) {
      const enc = (v: string) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
      headers.authorization = "Basic " + Buffer.from(`${enc(this.cfg.clientId)}:${enc(this.cfg.clientSecret)}`).toString("base64");
    } else { form.set("client_id", this.cfg.clientId); form.set("client_secret", this.cfg.clientSecret); }
    const t = await this.fetchJson(m.token_endpoint, "token", { method: "POST", body: form.toString(), headers });
    if (t.status !== 200 || typeof t.json?.id_token !== "string") {
      const reason = typeof t.json?.error === "string" && /^[a-z_]{1,40}$/.test(t.json.error) ? ` (${t.json.error})` : "";
      throw new OidcError("token_rejected", `token endpoint: HTTP ${t.status}${reason}`);
    }
    const claims = await this.verifyIdToken(t.json.id_token, m, flow.nonce, t.json.access_token);
    const missing = !str(claims.preferred_username) || !str(claims.name) || !str(claims.email) || claims.groups === undefined;
    const info = missing && m.userinfo_endpoint && typeof t.json.access_token === "string" ? await this.userinfo(m.userinfo_endpoint, t.json.access_token, claims.sub!) : {};
    const pick = (k: string) => (claims[k] !== undefined ? claims[k] : (info as any)[k]);
    const g = pick("groups");
    return {
      issuer: this.cfg.issuer, sub: claims.sub!, preferredUsername: str(pick("preferred_username")), name: str(pick("name"), 80), email: str(pick("email")),
      groups: (Array.isArray(g) ? g : typeof g === "string" ? [g] : []).filter((x): x is string => typeof x === "string"), idToken: t.json.id_token,
    };
  }

  private async verifyIdToken(token: string, m: Metadata, nonce: string, accessToken: unknown): Promise<JWTPayload> {
    const algorithms = m.id_token_signing_alg_values_supported?.filter((a) => ALGS.includes(a)) ?? ["RS256"];
    let claims: JWTPayload, alg: string;
    try {
      const r = await jwtVerify(token, this.keys(m.jwks_uri), {
        issuer: m.issuer, audience: this.cfg.clientId, algorithms, clockTolerance: SKEW_S, requiredClaims: ["sub", "exp", "iat", "nonce"],
      });
      claims = r.payload; alg = r.protectedHeader.alg;
    } catch (e: any) {
      if (e instanceof OidcError) throw e;
      throw new OidcError("bad_id_token", `ID token refused: ${e?.code ?? "invalid"}${typeof e?.claim === "string" ? ` (${e.claim})` : ""}`);
    }
    const bad = (why: string) => new OidcError("bad_id_token", `ID token refused: ${why}`);
    const now = Date.now() / 1000;
    if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255) throw bad("sub");
    if (claims.iat! > now + SKEW_S || claims.iat! < now - 3600) throw bad("iat");
    if (claims.nonce !== nonce) throw bad("nonce");
    if (claims.azp !== undefined ? claims.azp !== this.cfg.clientId : Array.isArray(claims.aud) && claims.aud.length > 1) throw bad("azp");
    if (claims.at_hash !== undefined && typeof accessToken === "string") {
      const bits = alg.slice(-3), h = ["256", "384", "512"].includes(bits) ? `sha${bits}` : "sha512"; // EdDSA (Ed25519) uses SHA-512
      const d = crypto.createHash(h).update(accessToken).digest();
      if (d.subarray(0, d.length / 2).toString("base64url") !== claims.at_hash) throw bad("at_hash");
    }
    return claims;
  }

  private async userinfo(url: string, accessToken: string, sub: string): Promise<Record<string, unknown>> {
    const r = await this.fetchJson(url, "userinfo", { headers: { authorization: `Bearer ${accessToken}` } });
    if (r.status !== 200 || !r.json) throw new OidcError("userinfo_failed", `userinfo: HTTP ${r.status}`);
    if (r.json.sub !== sub) throw new OidcError("bad_userinfo", "userinfo subject mismatch"); // OIDC Core 5.3.2
    return r.json;
  }

  /** RP-initiated logout URL, or null when the provider has none. */
  async logoutUrl(idToken: string | null, returnTo: string): Promise<string | null> {
    const m = await this.metadata();
    if (!m.end_session_endpoint) return null;
    const u = new URL(m.end_session_endpoint);
    if (idToken) u.searchParams.set("id_token_hint", idToken);
    u.searchParams.set("client_id", this.cfg.clientId);
    u.searchParams.set("post_logout_redirect_uri", returnTo);
    return u.toString();
  }
}

// ------------------------------------------------------------ sign-in attempts and app codes (short-lived, in memory, single use)

export type FlowKind =
  | { kind: "web"; returnTo: string }
  | { kind: "app"; challenge: string; deviceName: string; appState: string | null };
export type Flow = FlowKind & { nonce: string; verifier: string; binding: string; expires: number };

/** Expiring map with a size limit (oldest entries go first). */
export class Expiring<T extends { expires: number }> {
  private m = new Map<string, T>();
  private max: number;
  private now: () => number;
  constructor(max: number, now: () => number = Date.now) { this.max = max; this.now = now; }
  set(k: string, v: T) {
    const t = this.now();
    if (this.m.size >= this.max) for (const [x, y] of this.m) if (y.expires <= t) this.m.delete(x);
    while (this.m.size >= this.max) this.m.delete(this.m.keys().next().value!);
    this.m.set(k, v);
  }
  peek(k: string): T | null { const v = this.m.get(k); return v && v.expires > this.now() ? v : null; }
  delete(k: string) { this.m.delete(k); }
}

export const FLOW_MS = 10 * 60_000, APP_CODE_MS = 2 * 60_000;
export const APP_REDIRECT = "patchcast://sync-callback";

/** A path inside this site, or "/". Anything that could leave the origin is dropped. */
export function safeReturnTo(v: unknown): string {
  if (typeof v !== "string" || v.length > 500 || !v.startsWith("/") || /[\\\x00-\x20\x7f]/.test(v)) return "/";
  let u: URL;
  try { u = new URL("http://x.invalid" + v); } catch { return "/"; }
  const p = u.pathname + u.search;
  if (u.origin !== "http://x.invalid" || p.startsWith("//") || /^\/(api|auth)(\/|$|\?)/i.test(p)) return "/";
  return p;
}

/** A valid local username derived from the provider's claims; `taken` decides uniqueness. */
export function deriveUsername(id: Pick<Identity, "preferredUsername" | "email">, taken: (u: string) => boolean): string {
  const clean = (v: string | null | undefined) => (v ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, ".").replace(/[^A-Za-z0-9_.@-]/g, "").replace(/^[^A-Za-z0-9]+/, "").slice(0, 34);
  let base = clean(id.preferredUsername);
  if (base.length < 2) base = clean(id.email?.split("@")[0]);
  if (base.length < 2) base = "user";
  for (let n = 1; ; n++) {
    const u = n === 1 ? base : `${base}-${n}`;
    if (!taken(u)) return u;
  }
}
