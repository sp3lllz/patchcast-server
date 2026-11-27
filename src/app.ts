import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import sanitizeHtml from "sanitize-html";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, extname, sep } from "node:path";
import type { Config } from "./config.ts";
import { Db, type Row } from "./db.ts";
import { Auth, AuthError, RateLimiter, SESSION_MS, safeEqual, type Principal } from "./auth.ts";
import { Events } from "./events.ts";
import { Feeds } from "./feeds.ts";
import { SyncStore, SyncError, cleanSettings, settingOut, stateOut, subOut, type EpisodeChange } from "./sync.ts";
import { FetchError, Semaphore, safeFetch, safeOpen, USER_AGENT } from "./net.ts";
import { FeedParseError, httpUrl, stripTags } from "./feed.ts";
import { feedKey, normalizeFeedUrl } from "./urls.ts";
import { Accounts } from "./accounts.ts";
import { OidcClient } from "./oidc.ts";
import { oidcRoutes } from "./oidc-routes.ts";
import { parseOpml, writeOpml } from "./opml.ts";

const COOKIE = "patchcast_session";
type Req = FastifyRequest & { principal?: Principal };

export interface AppOptions { config: Config; db?: Db; webDir?: string; now?: () => number; logger?: any; /** Where the default logger writes (tests). */ logStream?: NodeJS.WritableStream }

export async function buildApp(o: AppOptions) {
  const { config } = o;
  const db = o.db ?? Db.open(config.dataDir);
  const auth = new Auth(db, config.sessionSecret, config.oidc.issuer);
  const events = new Events();
  const sync = new SyncStore(db, (userId, rev, deviceId) => events.send(userId, "change", { rev, deviceId }), o.now);
  const limiter = new RateLimiter();
  const audioSlots = new Map<number, number>();
  const base = config.basePath;
  const accounts = new Accounts(db, config);
  const oidc = new OidcClient(config.oidc, `${config.publicUrl}${base}/auth/oidc/callback`, config.ssrfAllowHosts);

  const app: FastifyInstance = Fastify({
    trustProxy: config.trustProxy as any,
    bodyLimit: 1024 * 1024,
    routerOptions: { maxParamLength: 8192 },
    logger: o.logger ?? {
      level: config.logLevel,
      ...(o.logStream ? { stream: o.logStream } : {}),
      // Never log headers, bodies, query strings or client-supplied URLs beyond the path.
      serializers: {
        req: (r: FastifyRequest) => ({ method: r.method, path: r.url.split("?")[0].replace(/\/art\/.*/, "/art/…"), ip: r.ip, proto: r.protocol, host: r.host }),
        res: (r: any) => ({ status: r.statusCode }),
      },
      redact: ["req.headers", "password", "token", "*.password", "*.token"],
    },
  });
  const feeds = new Feeds(db, config.dataDir, app.log as any, config.ssrfAllowHosts);
  feeds.onFeedChanged = (feedId, key) => {
    for (const s of db.all("SELECT user_id FROM subscriptions WHERE feed_key=? AND deleted=0", key)) events.send(s.user_id, "feed", { feedId });
  };

  // ------------------------------------------------------------ errors, headers
  app.setErrorHandler((err: any, req, reply) => {
    if (err.wait) reply.header("retry-after", err.wait);
    if (err instanceof AuthError || err instanceof SyncError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err instanceof FetchError) return reply.code(err.code === "bad_url" ? 400 : 502).send({ error: err.code, message: err.message });
    if (err instanceof FeedParseError) return reply.code(422).send({ error: "bad_feed", message: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.code ?? "bad_request", message: err.message });
    req.log.error({ err: { message: err.message, stack: err.stack } }, "request failed");
    return reply.code(500).send({ error: "internal", message: "Internal error" });
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: "not_found", message: "Not found" }));

  app.addHook("onRequest", async (req, reply) => {
    reply.headers({
      "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' https: http:; " +
        "connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer",
      "cross-origin-opener-policy": "same-origin", "cross-origin-resource-policy": "same-origin",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
    });
    if (req.protocol === "https") reply.header("strict-transport-security", "max-age=31536000");
    // No Access-Control-* headers are ever sent: the API is same-origin for browsers, bearer tokens for apps.
  });

  // ------------------------------------------------------------ auth plumbing
  const cookieOf = (req: FastifyRequest): string | null => {
    for (const part of (req.headers.cookie ?? "").split(";")) {
      const i = part.indexOf("=");
      if (part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
    }
    return null;
  };
  const secure = (req: FastifyRequest) => req.protocol === "https" || !!config.publicUrl?.startsWith("https:");
  const setCookie = (req: FastifyRequest, reply: FastifyReply, value: string, maxAge: number) =>
    reply.header("set-cookie", `${COOKIE}=${value}; Path=${base || "/"}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure(req) ? "; Secure" : ""}`);

  /** Cross-site requests are refused outright, whatever credentials they carry. */
  const sameOrigin = (req: FastifyRequest) => {
    const site = req.headers["sec-fetch-site"];
    if (site && site !== "same-origin" && site !== "none") throw new AuthError(403, "cross_site", "Cross-site request refused");
    const origin = req.headers.origin;
    if (origin && origin !== `${req.protocol}://${req.host}` && origin !== config.publicUrl)
      throw new AuthError(403, "bad_origin", "Origin does not match this server (check TRUST_PROXY / PUBLIC_URL)");
  };

  const authenticate = async (req: Req) => {
    const h = req.headers.authorization;
    let p: Principal | null = null;
    if (h) {
      const m = /^Bearer (pct_[\w-]{20,100})$/.exec(h);
      p = m ? auth.byToken(m[1]) : null;
    } else {
      const c = cookieOf(req);
      p = c ? auth.bySession(c) : null;
      if (p && req.method !== "GET" && req.method !== "HEAD") {
        sameOrigin(req);
        const t = req.headers["x-csrf-token"];
        if (typeof t !== "string" || !safeEqual(t, p.csrf!)) throw new AuthError(403, "csrf", "Missing or invalid CSRF token");
      }
    }
    if (!p) throw new AuthError(401, "unauthorized", "Sign in required");
    req.principal = p;
  };
  const adminOnly = async (req: Req) => { if (!req.principal!.isAdmin) throw new AuthError(403, "forbidden", "Administrators only"); };
  // Account management needs an interactive browser session; a leaked device token can't manage users.
  const cookieOnly = async (req: Req) => { if (req.principal!.via !== "cookie") throw new AuthError(403, "forbidden", "Use the web client for this"); };

  const me = (p: Principal) => ({ user: { id: p.userId, username: p.username, isAdmin: p.isAdmin }, deviceId: p.deviceId, deviceName: p.deviceName, csrf: p.csrf, version: config.version });
  const browserName = (ua = "") => {
    const b = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
    const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
    return os ? `${b} on ${os}` : b;
  };
  const deviceName = (v: unknown, fallback: string) => (typeof v === "string" ? v.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 60) : "") || fallback;

  // ------------------------------------------------------------ URLs handed to the client
  const b64 = (s: string) => Buffer.from(s).toString("base64url");
  /** Art goes through us: signed, so the endpoint can't be used to fetch arbitrary URLs. */
  const artUrl = (u: string | null | undefined): string | null => {
    if (!u) return null;
    if (u.startsWith("chapter:")) return `${base}/api/v1/chapter-art/${u.slice(8)}`;
    return httpUrl(u) ? `${base}/api/v1/art/${auth.sign("art:" + u)}/${b64(u)}` : null;
  };
  const audioProxy = (id: number) => `${base}/api/v1/audio/${id}`;

  const ep = (e: Row) => ({
    id: e.id, feedId: e.feed_id, feedUrl: e.feed_url, guid: e.guid, title: e.title, podcast: e.podcast, audioUrl: e.audio_url, audioProxy: audioProxy(e.id),
    mime: e.mime, size: e.size, durationMs: e.duration_ms ?? e.s_duration ?? null, pubDate: e.pub_date, image: artUrl(e.image ?? e.embedded_art ?? e.feed_image),
    podcastImage: artUrl(e.feed_image), link: e.link, number: e.number, type: e.type, played: !!e.played, positionMs: e.position_ms ?? 0,
    positionAt: e.position_at ?? 0, lastPlayedAt: e.last_played_at ?? null, completedAt: e.completed_at ?? null,
  });
  const EP = `SELECT e.id,e.feed_id,e.guid,e.title,e.audio_url,e.mime,e.size,e.duration_ms,e.pub_date,e.image,e.embedded_art,e.link,e.number,e.type,
    f.title podcast, f.image feed_image, f.url feed_url, f.key feed_key, s.played, s.position_ms, s.position_at, s.last_played_at, s.completed_at, s.duration_ms s_duration
    FROM episodes e JOIN feeds f ON f.id=e.feed_id LEFT JOIN episode_state s ON s.user_id=? AND s.feed_key=f.key AND s.guid=e.guid`;
  const num = (v: any, name = "id") => { const n = Number(v); if (!Number.isSafeInteger(n) || n <= 0) throw new AuthError(400, "bad_request", `Invalid ${name}`); return n; };
  const ids = (v: any, max = 5000): number[] => {
    if (!Array.isArray(v) || v.length > max) throw new AuthError(400, "bad_request", "Expected a list of ids");
    return v.map((x) => num(x));
  };
  /** Episodes are only visible to users subscribed to (or with state in / queueing) their feed. */
  const feedOf = (userId: number, feedId: number): Row => {
    const f = db.get("SELECT f.*, s.settings, s.deleted, s.title s_title FROM feeds f JOIN subscriptions s ON s.feed_key=f.key AND s.user_id=? WHERE f.id=?", userId, feedId);
    if (!f) throw new AuthError(404, "not_found", "Podcast not found");
    return f;
  };
  const episodeOf = (userId: number, id: number): Row => {
    const e = db.get(`${EP} WHERE e.id=? AND EXISTS(SELECT 1 FROM subscriptions x WHERE x.user_id=? AND x.feed_key=f.key)`, userId, id, userId);
    if (!e) throw new AuthError(404, "not_found", "Episode not found");
    return e;
  };
  const ref = (e: Row) => ({ feedUrl: e.feed_url as string, guid: e.guid as string, enclosureUrl: e.audio_url as string, title: e.title as string, pubDate: e.pub_date as number | null });

  // ------------------------------------------------------------ public routes
  await app.register(async (r) => {
    r.get("/healthz", { logLevel: "silent" }, async () => { db.get("SELECT 1"); return { ok: true, version: config.version }; });

    // passwordLogin, registrationOpen and setupRequired are always false since 0.8. They stay in the answer because
    // installed apps read them: passwordLogin: false makes them hide their password form.
    const info = () => ({
      name: "Patchcast Sync", version: config.version, api: 1, setupRequired: false, registrationOpen: false, passwordLogin: false,
      oidc: { enabled: true, providerName: config.oidc.providerName },
    });
    r.get("/api/v1/status", async () => info());
    r.get("/api/v1/server-info", async () => info());

    const startSession = (req: Req, reply: FastifyReply, userId: number, idToken: string | null = null) => {
      const s = auth.createSession(userId, browserName(req.headers["user-agent"]), idToken);
      setCookie(req, reply, s.id, SESSION_MS / 1000);
      reply.header("cache-control", "no-store");
      return me(auth.bySession(s.id)!);
    };
    oidcRoutes(r, { config, auth, accounts, client: oidc, limiter, secure, sameOrigin, deviceName, startSession, deviceCreated: (u) => events.send(u, "devices", {}), now: o.now });

    // ---------------------------------------------------------- everything below needs a signed-in user
    await r.register(async (a) => {
      a.addHook("onRequest", authenticate);
      a.addHook("onSend", async (_req, reply, payload) => { if (!reply.getHeader("cache-control")) reply.header("cache-control", "no-store"); return payload; });
      const P = (req: FastifyRequest) => (req as Req).principal!;

      a.get("/api/v1/me", async (req) => me(P(req)));
      a.post("/api/v1/auth/logout", async (req, reply) => {
        const p = P(req);
        const s = p.sessionHash ? db.get("SELECT via,id_token FROM sessions WHERE id_hash=?", p.sessionHash) : undefined;
        db.run("DELETE FROM devices WHERE id=?", p.deviceId);
        events.drop((c) => c.deviceId === p.deviceId);
        if (p.via === "cookie") setCookie(req, reply, "", 0);
        // Optional "sign out of the provider too". The local session is gone either way.
        let endSessionUrl: string | null = null;
        if (s?.via === "oidc" && (req.body as any)?.provider === true)
          endSessionUrl = await oidc.logoutUrl(s.id_token ? auth.unseal(s.id_token) : null, `${config.publicUrl}${base}/`).catch(() => null);
        return { ok: true, endSessionUrl };
      });
      a.get("/api/v1/me/account", { preHandler: cookieOnly }, async (req) => accounts.describe(P(req)));

      // ---- devices
      a.get("/api/v1/devices", async (req) => ({
        devices: db.all("SELECT id,name,kind,created_at createdAt,last_seen lastSeen FROM devices WHERE user_id=? ORDER BY last_seen DESC", P(req).userId)
          .map((d) => ({ ...d, current: d.id === P(req).deviceId })),
      }));
      a.patch("/api/v1/devices/:id", async (req) => {
        const n = deviceName((req.body as any)?.name, "");
        if (!n) throw new AuthError(400, "bad_request", "Name is required");
        const r = db.run("UPDATE devices SET name=? WHERE id=? AND user_id=?", n, (req.params as any).id, P(req).userId);
        if (!r.changes) throw new AuthError(404, "not_found", "Device not found");
        return { ok: true };
      });
      a.delete("/api/v1/devices/:id", async (req) => {
        const p = P(req), id = (req.params as any).id;
        if (p.via === "token" && id !== p.deviceId) throw new AuthError(403, "forbidden", "A device can only revoke itself");
        const r = db.run("DELETE FROM devices WHERE id=? AND user_id=?", id, p.userId);
        if (!r.changes) throw new AuthError(404, "not_found", "Device not found");
        events.drop((c) => c.deviceId === id);
        events.send(p.userId, "devices", {});
        return { ok: true };
      });

      // ---- users (admin)
      const admin = { preHandler: [adminOnly, cookieOnly] };
      // Accounts are created by signing in; there is no "create user". `oidc: false` marks an account left over from
      // 0.7 that has no identity at this provider and so can't sign in any more.
      a.get("/api/v1/users", admin, async () => ({
        autoCreate: config.oidc.autoCreate, providerName: config.oidc.providerName,
        users: db.all(`SELECT id,username,display_name displayName,is_admin isAdmin,created_at createdAt,EXISTS(SELECT 1 FROM identities i WHERE i.user_id=u.id AND i.issuer=?) oidc,
          (SELECT email FROM identities i WHERE i.user_id=u.id AND i.issuer=?) email,(SELECT last_login_at FROM identities i WHERE i.user_id=u.id AND i.issuer=?) lastLoginAt,
          (SELECT COUNT(*) FROM subscriptions s WHERE s.user_id=u.id AND deleted=0) podcasts FROM users u ORDER BY id`, config.oidc.issuer, config.oidc.issuer, config.oidc.issuer)
          .map((u) => ({ ...u, isAdmin: !!u.isAdmin, oidc: !!u.oidc })),
      }));
      a.delete("/api/v1/users/:id", admin, async (req) => {
        const id = num((req.params as any).id);
        if (id === P(req).userId) throw new AuthError(400, "bad_request", "You can't delete your own account");
        if (!db.run("DELETE FROM users WHERE id=?", id).changes) throw new AuthError(404, "not_found", "User not found");
        events.drop((c) => c.userId === id);
        return { ok: true };
      });

      // ---- sync API
      a.get("/api/v1/sync", async (req) => {
        const q = req.query as any;
        const since = Number(q.since ?? 0);
        if (!Number.isSafeInteger(since) || since < 0) throw new AuthError(400, "bad_request", "since must be a non-negative integer");
        const p = P(req);
        const out = sync.pull(p.userId, since, { limit: q.limit ? num(q.limit, "limit") : undefined, feedUrl: typeof q.feed === "string" ? q.feed : undefined });
        const latest = sync.latest(p.userId);
        return { ...out, latest: latest ? stateOut(latest) : null, deviceId: p.deviceId };
      });
      a.post("/api/v1/sync", { bodyLimit: 8 * 1024 * 1024 }, async (req) => {
        const p = P(req), b = req.body as any;
        const known = new Set(Array.isArray(b?.subscriptions) ? db.all("SELECT feed_key FROM subscriptions WHERE user_id=? AND deleted=0", p.userId).map((s) => s.feed_key) : []);
        const res = sync.push(p.userId, p.deviceId, b);
        if (b?.live && typeof b.live === "object" && !res.duplicate) broadcastLive(p, b.live);
        // Newly pushed subscriptions are fetched straight away so the web client has their episodes.
        for (const s of Array.isArray(b?.subscriptions) ? b.subscriptions : []) {
          const key = feedKey(String(s.feedUrl ?? ""));
          if (s.deleted || known.has(key)) continue;
          const f = db.get("SELECT id FROM feeds WHERE key=? AND fetched_at IS NULL", key);
          if (f) void feeds.refreshFeed(f.id);
        }
        return res;
      });
      const broadcastLive = (p: Principal, l: any) => {
        if (typeof l.feedUrl !== "string") return;
        const r = sync.resolve(l);
        const e = db.get("SELECT e.id FROM episodes e JOIN feeds f ON f.id=e.feed_id WHERE f.key=? AND e.guid=?", r.feedKey, r.guid);
        events.send(p.userId, "progress", {
          deviceId: p.deviceId, deviceName: p.deviceName, feedUrl: r.feedUrl, guid: r.guid, enclosureUrl: r.enclosureUrl, episodeId: e?.id ?? null, title: r.title,
          positionMs: Math.max(0, Math.round(Number(l.positionMs) || 0)), durationMs: Number(l.durationMs) || null, playing: !!l.playing, at: Date.now(),
        });
      };
      a.get("/api/v1/events", { logLevel: "warn" }, (req, reply) => {
        const p = P(req);
        reply.hijack();
        const res = reply.raw;
        res.writeHead(200, { ...(reply.getHeaders() as any), "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", "x-accel-buffering": "no", connection: "keep-alive" });
        res.write(`retry: 5000\nevent: hello\ndata: ${JSON.stringify({ rev: sync.rev(p.userId), deviceId: p.deviceId })}\n\n`);
        if (!events.add(p.userId, p.deviceId, res)) res.end();
      });

      // ---- library
      a.get("/api/v1/library", async (req) => {
        const u = P(req).userId;
        const rows = db.all(`SELECT s.*, f.id feed_id, f.title f_title, f.author, f.image, f.error, f.fetched_at,
          (SELECT COUNT(*) FROM episodes e WHERE e.feed_id=f.id) total,
          (SELECT COUNT(*) FROM episodes e JOIN episode_state st ON st.user_id=s.user_id AND st.feed_key=f.key AND st.guid=e.guid AND st.played=1 WHERE e.feed_id=f.id) played
          FROM subscriptions s JOIN feeds f ON f.key=s.feed_key WHERE s.user_id=? AND s.deleted=0`, u);
        return {
          podcasts: rows.map((r) => ({
            id: r.feed_id, feedUrl: r.feed_url, title: r.f_title ?? r.title ?? r.feed_url, author: r.author, image: artUrl(r.image), error: r.error, fetchedAt: r.fetched_at,
            total: r.total, unplayed: r.total - r.played, settings: JSON.parse(r.settings), addedAt: r.added_at,
            releases: db.all("SELECT pub_date p, type t FROM episodes WHERE feed_id=? AND pub_date IS NOT NULL ORDER BY pub_date DESC LIMIT 40", r.feed_id).map((x) => [x.p, x.t]),
          })).sort((x, y) => x.title.localeCompare(y.title, "en", { sensitivity: "base" })),
        };
      });
      a.get("/api/v1/podcasts/:id", async (req) => {
        const u = P(req).userId, f = feedOf(u, num((req.params as any).id));
        return {
          id: f.id, feedUrl: f.url, title: f.title ?? f.s_title ?? f.url, author: f.author, description: notes(f.description), image: artUrl(f.image), link: f.link,
          error: f.error, fetchedAt: f.fetched_at, subscribed: !f.deleted, settings: JSON.parse(f.settings),
          episodes: db.all(`${EP} WHERE e.feed_id=? ORDER BY e.pub_date DESC, e.id DESC`, u, f.id).map(ep),
        };
      });
      a.get("/api/v1/episodes/:id", async (req) => {
        const u = P(req).userId, e = episodeOf(u, num((req.params as any).id));
        const d = db.get("SELECT description FROM episodes WHERE id=?", e.id)!;
        const st = sync.state(u, e.feed_key, e.guid);
        return { ...ep(e), notes: notes(d.description), lastDevice: st?.position_device ? { id: st.position_device, name: st.dname } : null };
      });
      a.get("/api/v1/episodes/:id/chapters", async (req) => {
        const e = episodeOf(P(req).userId, num((req.params as any).id));
        const list = await feeds.chapters(e.id);
        const fresh = db.get("SELECT image, embedded_art, chapters_source FROM episodes WHERE id=?", e.id)!;
        return { source: fresh.chapters_source ?? "none", chapters: list.map((c) => ({ ...c, image: artUrl(c.image), url: httpUrl(c.url) })), image: artUrl(fresh.image ?? fresh.embedded_art ?? e.feed_image) };
      });
      a.get("/api/v1/new", async (req) => {
        const u = P(req).userId, days = Math.min(Math.max(Number((req.query as any).days) || 14, 1), 365);
        return {
          episodes: db.all(`${EP} JOIN subscriptions sub ON sub.user_id=? AND sub.feed_key=f.key AND sub.deleted=0
            WHERE e.pub_date>? AND COALESCE(s.played,0)=0 AND COALESCE(json_extract(sub.settings,'$.exclude'),0)=0
            ORDER BY COALESCE(json_extract(sub.settings,'$.priority'),1000000), e.pub_date DESC LIMIT 300`, u, u, Date.now() - days * 86_400_000).map(ep),
        };
      });
      a.get("/api/v1/queue", async (req) => {
        const u = P(req).userId;
        let hidden = 0;
        const items = sync.queue(u).flatMap((q) => {
          const e = db.get(`${EP} WHERE f.key=? AND e.guid=?`, u, q.feed_key, q.guid);
          if (!e) { hidden++; return []; }
          return [{ ...ep(e), auto: !!q.auto }];
        });
        return { items, hidden };
      });
      a.put("/api/v1/queue", async (req) => {
        const p = P(req), b = (req.body ?? {}) as any;
        const toRef = (id: number) => ref(episodeOf(p.userId, id));
        const auto = new Set(ids(b.auto ?? []));
        const res = sync.push(p.userId, p.deviceId, { queue: { base: ids(b.base ?? []).map(toRef), items: ids(b.items).map((id) => ({ ...toRef(id), auto: auto.has(id) })) } });
        return { rev: res.rev, changed: res.queue };
      });
      a.post("/api/v1/episodes/played", async (req) => {
        const p = P(req), b = (req.body ?? {}) as any;
        if (typeof b.played !== "boolean") throw new AuthError(400, "bad_request", "played must be true or false");
        const now = Date.now();
        const res = sync.push(p.userId, p.deviceId, {
          episodes: ids(b.ids).map((id) => ({ ...ref(episodeOf(p.userId, id)), played: b.played, explicitUnplayed: !b.played, playedChangedAt: now, ...(b.played ? {} : { positionMs: 0, positionChangedAt: now }) } as EpisodeChange)),
        });
        return { rev: res.rev, changed: res.episodes };
      });
      a.post("/api/v1/episodes/:id/progress", { logLevel: "warn" }, async (req) => {
        const p = P(req), b = (req.body ?? {}) as any, e = episodeOf(p.userId, num((req.params as any).id));
        const position = Math.max(0, Math.round(Number(b.positionMs) || 0));
        const res = sync.push(p.userId, p.deviceId, {
          pushId: b.pushId, clientTime: b.clientTime,
          episodes: [{ ...ref(e), ...(b.finished ? { played: true, playedChangedAt: b.changedAt } : { positionMs: position, positionChangedAt: b.changedAt }), durationMs: b.durationMs }],
        });
        if (!res.duplicate) broadcastLive(p, { ...ref(e), positionMs: position, durationMs: b.durationMs, playing: b.playing });
        return { rev: res.rev };
      });
      // 0.10.0: play history (scroll up on Up Next). Most recently played first; what is in the queue is left out.
      a.get("/api/v1/history", async (req) => {
        const u = P(req).userId, limit = Math.min(Math.max(Number((req.query as any).limit) || 50, 1), 200);
        return {
          episodes: db.all(`${EP} WHERE s.last_played_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM queue_items q WHERE q.user_id=s.user_id AND q.feed_key=s.feed_key AND q.guid=s.guid AND q.deleted=0)
            ORDER BY s.last_played_at DESC, e.id DESC LIMIT ?`, u, limit).map(ep),
        };
      });
      a.get("/api/v1/latest", async (req) => {
        const p = P(req), s = sync.latest(p.userId);
        if (!s) return { latest: null };
        const e = db.get(`${EP} WHERE f.key=? AND e.guid=?`, p.userId, s.feed_key, s.guid);
        return { latest: e ? { episode: ep(e), deviceId: s.position_device, deviceName: s.dname, at: s.position_at, mine: s.position_device === p.deviceId } : null };
      });

      // ---- settings that follow the user (0.10.0)
      a.get("/api/v1/settings", async (req) => ({ settings: sync.settings(P(req).userId).map(settingOut) }));
      a.put("/api/v1/settings", async (req) => {
        const p = P(req), b = (req.body ?? {}) as any;
        if (typeof b.values !== "object" || !b.values || Array.isArray(b.values)) throw new AuthError(400, "bad_request", "values must be an object of key: value");
        const changedAt = Date.now();
        const res = sync.push(p.userId, p.deviceId, { settings: Object.entries(b.values).map(([key, value]) => ({ key, value, changedAt })) });
        return { rev: res.rev, changed: res.settings, settings: sync.settings(p.userId).map(settingOut) };
      });

      // ---- subscriptions
      const subscribe = async (p: Principal, raw: string) => {
        const url = normalizeFeedUrl(raw);
        if (!url) throw new AuthError(400, "bad_url", "Invalid feed URL");
        const already = db.get("SELECT 1 FROM subscriptions WHERE user_id=? AND feed_key=? AND deleted=0", p.userId, feedKey(url));
        const f = await feeds.addFeed(url);
        if (!already) sync.push(p.userId, p.deviceId, { subscriptions: [{ feedUrl: url, title: f.title, deleted: false, changedAt: Date.now() }] });
        return { id: f.id as number, title: f.title as string, already: !!already };
      };
      a.post("/api/v1/subscriptions", async (req) => {
        const u = (req.body as any)?.url;
        if (typeof u !== "string" || u.length > 4096) throw new AuthError(400, "bad_url", "Invalid feed URL");
        return subscribe(P(req), u);
      });
      a.delete("/api/v1/subscriptions/:id", async (req) => {
        const p = P(req), f = feedOf(p.userId, num((req.params as any).id));
        return { rev: sync.push(p.userId, p.deviceId, { subscriptions: [{ feedUrl: f.url, deleted: true, changedAt: Date.now() }] }).rev };
      });
      a.patch("/api/v1/subscriptions/:id", async (req) => {
        const p = P(req), f = feedOf(p.userId, num((req.params as any).id));
        sync.push(p.userId, p.deviceId, { subscriptions: [{ feedUrl: f.url, settings: cleanSettings((req.body ?? {}) as any), settingsChangedAt: Date.now() }] });
        const s = db.get("SELECT * FROM subscriptions WHERE user_id=? AND feed_key=?", p.userId, f.key)!;
        return subOut(s);
      });
      const refreshSem = new Semaphore(2);
      a.post("/api/v1/refresh", async (req) => {
        const p = P(req), id = (req.body as any)?.podcastId;
        if (id) { const err = await feeds.refreshFeed(feedOf(p.userId, num(id)).id, true); return { error: err }; }
        await refreshSem.run(() => feeds.refreshAll(60_000, p.userId));
        return { error: null };
      });
      a.get("/api/v1/search", async (req) => {
        const q = String((req.query as any).q ?? "").trim().slice(0, 200);
        if (!q) return { results: [] };
        const u = new URL("https://itunes.apple.com/search");
        u.search = new URLSearchParams({ media: "podcast", entity: "podcast", limit: "30", term: q }).toString();
        const r = await safeFetch(u.toString(), { maxBytes: 4 * 1024 * 1024, timeoutMs: 15_000 });
        if (r.status !== 200) throw new FetchError("http", `Search failed (HTTP ${r.status})`);
        const list = JSON.parse(r.bytes.toString("utf8")).results ?? [];
        return { results: list.filter((x: any) => httpUrl(x.feedUrl)).map((x: any) => ({ title: x.collectionName ?? x.trackName, author: x.artistName, feedUrl: x.feedUrl, image: artUrl(x.artworkUrl100), genre: x.primaryGenreName })) };
      });

      // ---- import / export
      a.addContentTypeParser(["text/xml", "application/xml", "text/x-opml", "text/plain", "application/octet-stream"], { parseAs: "string", bodyLimit: 32 * 1024 * 1024 }, (_q, body, done) => done(null, body));
      a.get("/api/v1/export/opml", async (req, reply) => {
        const rows = db.all("SELECT s.feed_url, COALESCE(f.title,s.title,s.feed_url) t, f.link FROM subscriptions s LEFT JOIN feeds f ON f.key=s.feed_key WHERE s.user_id=? AND s.deleted=0 ORDER BY t COLLATE NOCASE", P(req).userId);
        reply.header("content-type", "text/x-opml; charset=utf-8").header("content-disposition", 'attachment; filename="patchcast-subscriptions.opml"');
        return writeOpml(rows.map((r) => ({ title: r.t, url: r.feed_url, link: r.link })));
      });
      a.post("/api/v1/import/opml", { bodyLimit: 8 * 1024 * 1024 }, async (req) => {
        const p = P(req);
        if (typeof req.body !== "string") throw new AuthError(400, "bad_request", "Send the OPML file as text/xml");
        const seen = new Set<string>();
        const items = parseOpml(req.body).filter((i) => { const n = normalizeFeedUrl(i.url); const k = n && feedKey(n); return k && !seen.has(k) && seen.add(k); });
        if (!items.length) throw new AuthError(422, "bad_opml", "No podcasts found in that file");
        let imported = 0, already = 0;
        const failed: { title: string; reason: string }[] = [];
        await Promise.all(items.map(async (i) => {
          try { (await subscribe(p, i.url)).already ? already++ : imported++; }
          catch (e: any) { failed.push({ title: i.title ?? i.url, reason: e.message }); }
        }));
        return { imported, already, failed };
      });
      a.get("/api/v1/export/history", async (req, reply) => {
        const u = P(req).userId;
        const pods = db.all("SELECT * FROM subscriptions WHERE user_id=? AND deleted=0", u).map((s) => {
          const c = JSON.parse(s.settings);
          return { feedUrl: s.feed_url, title: s.title, priority: c.priority, autoQueue: c.autoQueue ?? undefined, playbackSpeed: c.speed ?? undefined };
        });
        const eps = db.all("SELECT * FROM episode_state WHERE user_id=? AND (played=1 OR position_ms>0)", u).map((e) => ({
          feedUrl: e.feed_url, guid: e.guid, enclosureUrl: e.enclosure_url ?? undefined, title: e.title ?? undefined, pubDate: e.pub_date ?? undefined,
          played: !!e.played, positionMs: e.position_ms, playedAt: e.completed_at ?? undefined, lastPlayedAt: e.last_played_at ?? undefined,
        }));
        reply.header("content-disposition", 'attachment; filename="patchcast-history.json"');
        return { format: "patchcast-history", version: 1, exportedAt: new Date().toISOString(), podcasts: pods, episodes: eps };
      });
      a.post("/api/v1/import/history", { bodyLimit: 32 * 1024 * 1024 }, async (req) => {
        const p = P(req), h = req.body as any;
        if (h?.format !== "patchcast-history") throw new AuthError(422, "bad_history", "Not a Patchcast history file");
        if (h.version !== 1) throw new AuthError(422, "bad_history", `Unsupported history version ${h.version}`);
        const pods: any[] = Array.isArray(h.podcasts) ? h.podcasts : [], eps: any[] = Array.isArray(h.episodes) ? h.episodes : [];
        const exported = Date.parse(h.exportedAt) || 0;
        const subs = pods.filter((x) => typeof x?.feedUrl === "string" && normalizeFeedUrl(x.feedUrl)).map((x) => ({
          feedUrl: x.feedUrl, title: x.title, deleted: false, changedAt: Date.now(), settingsChangedAt: exported,
          settings: { ...(x.priority != null ? { priority: x.priority } : {}), ...(x.autoQueue != null ? { autoQueue: x.autoQueue } : {}), ...(x.playbackSpeed != null ? { speed: Math.round(x.playbackSpeed * 100) / 100 } : {}) },
        }));
        const before = new Set(db.all("SELECT feed_key FROM subscriptions WHERE user_id=? AND deleted=0", p.userId).map((s) => s.feed_key));
        let applied = 0, bad = 0;
        for (let i = 0; i < subs.length; i += 1000) sync.push(p.userId, p.deviceId, { subscriptions: subs.slice(i, i + 1000) });
        for (let i = 0; i < eps.length; i += 1000) {
          const batch = eps.slice(i, i + 1000).flatMap((e): EpisodeChange[] => {
            if (typeof e?.feedUrl !== "string" || (!e.guid && !e.enclosureUrl)) { bad++; return []; }
            const t = e.lastPlayedAt ?? e.playedAt ?? 0;
            return [{ ...e, played: e.played === true ? true : undefined, playedChangedAt: e.playedAt ?? t, completedAt: e.playedAt ?? null, positionMs: e.played ? undefined : e.positionMs, positionChangedAt: t }];
          });
          applied += sync.push(p.userId, p.deviceId, { episodes: batch }).episodes;
        }
        const added = subs.filter((s) => !before.has(feedKey(s.feedUrl)));
        for (const s of added) { const f = db.get("SELECT id FROM feeds WHERE key=? AND fetched_at IS NULL", feedKey(normalizeFeedUrl(s.feedUrl)!)); if (f) void feeds.refreshFeed(f.id); }
        return { podcasts: subs.length, subscribed: added.length, episodes: eps.length, applied, skipped: bad };
      });

      // ---- media
      const sendFile = (reply: FastifyReply, f: { path: string; mime: string } | null) => {
        if (!f) return reply.code(404).header("cache-control", "private, max-age=300").send({ error: "not_found", message: "No image" });
        return reply.header("content-type", f.mime).header("cache-control", "private, max-age=604800").header("content-length", statSync(f.path).size).send(createReadStream(f.path));
      };
      a.get("/api/v1/art/:sig/:url", { logLevel: "warn" }, async (req, reply) => {
        const { sig, url } = req.params as any;
        const u = Buffer.from(url, "base64url").toString("utf8");
        if (!auth.verifySig("art:" + u, sig)) throw new AuthError(403, "bad_signature", "Bad signature");
        return sendFile(reply, await feeds.art(u));
      });
      a.get("/api/v1/chapter-art/:name", { logLevel: "warn" }, async (req, reply) => {
        const name = (req.params as any).name as string;
        const id = Number(/^(\d+)-/.exec(name)?.[1]);
        if (id) episodeOf(P(req).userId, id);
        return sendFile(reply, feeds.chapterFile(name));
      });

      /** Range-proxy fallback: streams bytes straight through, never stored. Only for episodes the user can see. */
      a.get("/api/v1/audio/:id", async (req, reply) => {
        const p = P(req), e = episodeOf(p.userId, num((req.params as any).id));
        if ((audioSlots.get(p.userId) ?? 0) >= 4) throw new AuthError(429, "busy", "Too many proxied streams");
        const range = req.headers.range;
        if (range && !/^bytes=\d*-\d*$/.test(range)) throw new AuthError(416, "bad_range", "Unsupported range");
        audioSlots.set(p.userId, (audioSlots.get(p.userId) ?? 0) + 1);
        const release = once(() => audioSlots.set(p.userId, Math.max(0, (audioSlots.get(p.userId) ?? 1) - 1)));
        const abort = new AbortController();
        req.raw.socket.once("close", () => abort.abort());
        try {
          const up = await safeOpen(e.audio_url, { timeoutMs: 30_000, allowHosts: config.ssrfAllowHosts, signal: abort.signal,
            headers: { "user-agent": USER_AGENT, "accept-encoding": "identity", ...(range ? { range } : {}) } });
          const type = String(up.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
          const okType = /^(audio|video)\//.test(type) || ["application/octet-stream", "binary/octet-stream", "application/ogg", "", "application/x-mpegurl"].includes(type);
          const len = Number(up.headers["content-length"] ?? 0);
          if (![200, 206, 416].includes(up.status) || !okType || len > 4 * 1024 ** 3) {
            up.body.destroy();
            throw new FetchError("http", `Audio host answered HTTP ${up.status}${okType ? "" : ` (${type})`}`, up.status);
          }
          const idle = setTimeout(() => up.body.destroy(), 120_000), total = setTimeout(() => up.body.destroy(), 6 * 3600_000);
          let sent = 0;
          up.body.on("data", (c: Buffer) => { idle.refresh(); sent += c.length; if (sent > 4 * 1024 ** 3) up.body.destroy(); });
          const done = () => { clearTimeout(idle); clearTimeout(total); release(); };
          up.body.on("close", done); up.body.on("error", done);
          reply.raw.on("close", () => up.body.destroy());
          reply.code(up.status);
          for (const h of ["content-length", "content-range", "accept-ranges", "last-modified", "etag"]) if (up.headers[h]) reply.header(h, up.headers[h]);
          reply.header("content-type", /^(audio|video)\//.test(type) ? type : /^(audio|video)\//.test(e.mime ?? "") ? e.mime : "audio/mpeg").header("cache-control", "private, no-store");
          return reply.send(up.body);
        } catch (err) { release(); throw err; }
      });
    });

    // ---------------------------------------------------------- web client
    const webDir = o.webDir;
    if (webDir && existsSync(webDir)) {
      const types: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".html": "text/html", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon" };
      const html = readFileSync(join(webDir, "index.html"), "utf8").replaceAll("__BASE__", base).replaceAll("__VERSION__", config.version);
      const index = (reply: FastifyReply) => reply.header("content-type", "text/html; charset=utf-8").header("cache-control", "no-cache").send(html);
      r.get("/", async (req, reply) => (base && !req.url.split("?")[0].endsWith("/") ? reply.redirect(`${base}/`, 308) : index(reply)));
      r.get("/manifest.webmanifest", async (_q, reply) => reply.header("content-type", types[".webmanifest"]).header("cache-control", "no-cache").send({
        name: "Patchcast", short_name: "Patchcast", id: `${base}/`, start_url: `${base}/`, scope: `${base}/`, display: "standalone", background_color: "#141218", theme_color: "#2B1A4F",
        description: "Podcasts, in sync with your phone.",
        icons: [192, 512].flatMap((s) => [{ src: `${base}/icon-${s}.png`, sizes: `${s}x${s}`, type: "image/png" }, { src: `${base}/icon-maskable-${s}.png`, sizes: `${s}x${s}`, type: "image/png", purpose: "maskable" }])
          .concat([{ src: `${base}/icon.svg`, sizes: "any", type: "image/svg+xml" }] as any),
      }));
      r.get("/*", async (req, reply) => {
        const rel = decodeURIComponent((req.params as any)["*"]);
        if (/^(api|auth)\//.test(rel)) return reply.code(404).send({ error: "not_found", message: "Not found" });
        const path = normalize(join(webDir, rel));
        if (path.startsWith(webDir + sep) && !rel.includes("\0") && existsSync(path) && statSync(path).isFile() && !path.endsWith("index.html")) {
          return reply.header("content-type", (types[extname(path)] ?? "application/octet-stream") + (/\.(js|css|svg)$/.test(path) ? "; charset=utf-8" : ""))
            .header("cache-control", "no-cache").send(readFileSync(path));
        }
        if (extname(rel)) return reply.code(404).send({ error: "not_found", message: "Not found" });
        return index(reply); // client-side routes
      });
    }
  }, { prefix: base });
  if (base) app.get("/healthz", { logLevel: "silent" }, async () => ({ ok: true })); // container healthcheck path is prefix-independent

  app.addHook("preClose", async () => { feeds.close(); events.close(); });
  app.addHook("onClose", async () => db.close());

  return { app, db, auth, sync, feeds, events };
}

function once(fn: () => void) { let done = false; return () => { if (!done) { done = true; fn(); } }; }

/** Show notes: safe subset of HTML, no images/styles/scripts, links open in a new tab. Plain text keeps its line breaks. */
export function notes(html: string | null): string {
  if (!html) return "";
  const isHtml = /<\s*[a-zA-Z][^>]*>/.test(html);
  const src = isHtml ? html : html.replace(/&(?!#?\w+;)/g, "&amp;").replace(/</g, "&lt;").replace(/(https?:\/\/[^\s<>"]+)/g, '<a href="$1">$1</a>').replace(/\r?\n/g, "<br>");
  return sanitizeHtml(src, {
    allowedTags: ["p", "br", "a", "b", "strong", "i", "em", "u", "s", "ul", "ol", "li", "blockquote", "code", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "span", "div", "sub", "sup", "table", "thead", "tbody", "tr", "td", "th"],
    allowedAttributes: { a: ["href", "target", "rel"] },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    transformTags: {
      a: (_t, at) => ({ tagName: "a", attribs: { ...(at.href ? { href: at.href } : {}), target: "_blank", rel: "noopener noreferrer nofollow" } }),
      h1: "h3", h2: "h3",
    },
  });
}
export { stripTags };
