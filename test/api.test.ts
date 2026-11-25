import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Browser, Device, PW, makeApp, rss, serve, withAdmin, type Ctx } from "./helpers.ts";
import { hashPassword, verifyPassword, LoginLimiter } from "../src/auth.ts";
import { loadConfig, normalizeBasePath, parseTrustProxy } from "../src/config.ts";

test("config parsing", () => {
  assert.equal(normalizeBasePath("podcasts/"), "/podcasts"); assert.equal(normalizeBasePath("/"), ""); assert.throws(() => normalizeBasePath("/a/../b")); assert.throws(() => normalizeBasePath("/a\"b"));
  assert.equal(parseTrustProxy("1"), 1); assert.equal(parseTrustProxy("true"), true); assert.equal(parseTrustProxy(""), false); assert.equal(parseTrustProxy("uniquelocal"), "uniquelocal");
  assert.throws(() => loadConfig({ DATA_DIR: "/tmp", PORT: "abc" })); assert.throws(() => loadConfig({ DATA_DIR: "/tmp", SESSION_SECRET: "short" }));
});

test("argon2id hashes", async () => {
  const h = await hashPassword(PW);
  assert.match(h, /^\$argon2id\$m=19456,t=2,p=1\$/);
  assert.equal(await verifyPassword(PW, h), true); assert.equal(await verifyPassword(PW + "x", h), false); assert.equal(await verifyPassword(PW, "junk"), false);
  assert.notEqual(h, await hashPassword(PW));
});

test("first-run setup needs the token and only works once", async () => {
  const ctx = await makeApp();
  try {
    const b = new Browser(ctx);
    assert.equal((await b.req("GET", "/api/v1/status")).json.setupRequired, true);
    assert.equal((await b.login()).status, 401);
    const token = ctx.auth.ensureSetupToken();
    assert.equal((await b.req("POST", "/api/v1/auth/setup", { token: "nope", username: "patch", password: PW })).status, 403);
    assert.equal((await b.req("POST", "/api/v1/auth/setup", { token, username: "patch", password: "short" })).status, 400);
    const r = await b.req("POST", "/api/v1/auth/setup", { token, username: "patch", password: PW });
    assert.equal(r.status, 200); assert.equal(r.json.user.isAdmin, true);
    assert.equal((await b.req("POST", "/api/v1/auth/setup", { token, username: "evil", password: PW })).status, 409);
    assert.equal((await b.req("POST", "/api/v1/auth/register", { username: "x1", password: PW })).status, 403);
    const secret = join(ctx.dir, "session-secret");
    assert.ok(existsSync(secret)); assert.equal(statSync(secret).mode & 0o777, 0o600);
  } finally { await ctx.stop(); }
});

describe("auth", () => {
  let ctx: Ctx, b: Browser;
  beforeEach(async () => { ctx = await withAdmin(); b = new Browser(ctx); });
  afterEach(() => ctx.stop());

  test("every API route needs authentication", async () => {
    for (const [m, u] of [["GET", "/me"], ["GET", "/sync?since=0"], ["POST", "/sync"], ["GET", "/events"], ["GET", "/library"], ["GET", "/podcasts/1"], ["GET", "/episodes/1"], ["GET", "/episodes/1/chapters"], ["GET", "/new"], ["GET", "/queue"], ["PUT", "/queue"],
      ["POST", "/episodes/played"], ["POST", "/episodes/1/progress"], ["GET", "/latest"], ["POST", "/subscriptions"], ["DELETE", "/subscriptions/1"], ["PATCH", "/subscriptions/1"], ["POST", "/refresh"], ["GET", "/search?q=x"], ["GET", "/export/opml"], ["POST", "/import/opml"],
      ["GET", "/export/history"], ["POST", "/import/history"], ["GET", "/art/x/y"], ["GET", "/chapter-art/1-0.jpg"], ["GET", "/audio/1"], ["GET", "/devices"], ["DELETE", "/devices/x"], ["GET", "/users"], ["POST", "/users"], ["DELETE", "/users/1"], ["POST", "/me/password"], ["POST", "/auth/logout"]])
      assert.equal((await b.req(m, `/api/v1${u}`, m === "GET" || m === "DELETE" ? undefined : {})).status, 401, `${m} ${u}`);
  });

  test("cookie flags, CSRF and cross-site protection", async () => {
    const r = await b.login();
    assert.equal(r.status, 200);
    const c = String(r.headers["set-cookie"]);
    assert.match(c, /HttpOnly/); assert.match(c, /SameSite=Strict/); assert.match(c, /Path=\//); assert.doesNotMatch(c, /Secure/);
    assert.equal((await b.req("GET", "/api/v1/me")).json.user.username, "patch");
    const good = b.csrf;
    b.csrf = ""; assert.equal((await b.req("POST", "/api/v1/refresh", {})).json.error, "csrf");
    b.csrf = "wrong"; assert.equal((await b.req("POST", "/api/v1/refresh", {})).json.error, "csrf");
    b.csrf = good;
    assert.equal((await b.req("POST", "/api/v1/refresh", {}, { origin: "https://evil.example" })).json.error, "bad_origin");
    assert.equal((await b.req("POST", "/api/v1/refresh", {}, { "sec-fetch-site": "cross-site" })).json.error, "cross_site");
    assert.equal((await b.req("POST", "/api/v1/refresh", {}, { origin: "http://localhost:80", host: "localhost:80" })).status, 200);
    assert.equal((await new Browser(ctx).req("POST", "/api/v1/auth/login", { username: "patch", password: PW }, { origin: "https://evil.example" })).status, 403, "login CSRF");
    assert.equal((await b.req("GET", "/api/v1/me", undefined, { origin: "https://evil.example" })).headers["access-control-allow-origin"], undefined, "no CORS");
  });

  test("security headers", async () => {
    const h = (await b.req("GET", "/api/v1/status")).headers;
    assert.match(String(h["content-security-policy"]), /script-src 'self';/); assert.match(String(h["content-security-policy"]), /frame-ancestors 'none'/);
    assert.equal(h["x-content-type-options"], "nosniff"); assert.equal(h["x-frame-options"], "DENY"); assert.equal(h["referrer-policy"], "no-referrer"); assert.equal(h["strict-transport-security"], undefined);
  });

  test("login is rate limited per IP + user without locking other addresses out", async () => {
    for (let i = 0; i < 5; i++) assert.equal((await b.login("patch", "wrong password!")).status, 401);
    const r = await b.login();
    assert.equal(r.status, 429); assert.ok(Number(r.headers["retry-after"]) > 0);
    assert.equal((await new Browser(ctx, "198.51.100.7").login()).status, 200);
    for (let i = 0; i < 15; i++) await b.login(`user${i}`, "wrong password!");
    assert.equal((await b.login("fresh-user", "wrong password!")).status, 429, "per-IP cap");
    const l = new LoginLimiter(1000);
    for (let i = 0; i < 5; i++) assert.equal(l.take("2001:db8:1:2::" + i, "u", 0), 0);
    assert.ok(l.take("2001:db8:1:2:ffff::1", "u", 10) > 0, "one IPv6 /64 is one attacker");
    assert.equal(l.take("2001:db8:1:2::9", "u", 1500), 0, "window expires");
  });

  test("successful logins don't count towards the limit", async () => {
    for (let i = 0; i < 12; i++) assert.equal((await new Browser(ctx).login()).status, 200);
  });

  test("device tokens: issued, usable, listed, revocable, not stored in clear", async () => {
    const d = await new Device(ctx).login("Pixel 9");
    assert.match(d.token, /^pct_/);
    assert.equal((await d.req("GET", "/api/v1/me")).json.deviceName, "Pixel 9");
    assert.equal(ctx.db.all("SELECT * FROM devices").some((r) => JSON.stringify(r).includes(d.token)), false);
    assert.equal((await d.req("POST", "/api/v1/users", { username: "x1", password: PW })).status, 403, "tokens can't administer");
    assert.equal((await d.req("POST", "/api/v1/me/password", { password: PW, newPassword: PW + "2" })).status, 403);
    await b.login();
    assert.equal((await d.req("DELETE", `/api/v1/devices/${b.deviceId}`)).status, 403, "can't revoke others");
    const list = (await b.req("GET", "/api/v1/devices")).json.devices;
    assert.deepEqual(list.map((x: any) => x.kind).sort(), ["app", "web"]);
    assert.equal((await b.req("DELETE", `/api/v1/devices/${d.id}`)).status, 200);
    assert.equal((await d.req("GET", "/api/v1/me")).status, 401);
    const d2 = await new Device(ctx).login("Other");
    assert.equal((await d2.req("POST", "/api/v1/auth/logout", {})).status, 200);
    assert.equal((await d2.req("GET", "/api/v1/me")).status, 401);
  });

  test("logout and password change end sessions", async () => {
    await b.login();
    const other = new Browser(ctx); await other.login();
    assert.equal((await b.req("POST", "/api/v1/me/password", { password: "nope nope nope", newPassword: PW + "2" })).status, 403);
    assert.equal((await b.req("POST", "/api/v1/me/password", { password: PW, newPassword: PW + "2" })).status, 200);
    assert.equal((await other.req("GET", "/api/v1/me")).status, 401);
    assert.equal((await b.req("GET", "/api/v1/me")).status, 200);
    const old = b.cookie;
    await b.req("POST", "/api/v1/auth/logout", {});
    b.cookie = old;
    assert.equal((await b.req("GET", "/api/v1/me")).status, 401, "server-side invalidation");
  });

  test("user administration", async () => {
    await b.login();
    const r = await b.req("POST", "/api/v1/users", { username: "sam", password: PW });
    assert.equal(r.status, 200);
    assert.equal((await b.req("POST", "/api/v1/users", { username: "SAM", password: PW })).status, 409);
    const s = new Browser(ctx); await s.login("sam");
    assert.equal((await s.req("GET", "/api/v1/users")).status, 403);
    assert.equal((await s.req("DELETE", "/api/v1/users/1")).status, 403);
    assert.equal((await b.req("DELETE", "/api/v1/users/1")).status, 400, "not yourself");
    assert.equal((await b.req("DELETE", `/api/v1/users/${r.json.id}`)).status, 200);
    assert.equal((await s.req("GET", "/api/v1/me")).status, 401);
  });
});

test("TRUST_PROXY: forwarded headers are honoured only when trusted", async () => {
  const hdr = { "x-forwarded-proto": "https", "x-forwarded-host": "pods.example", "x-forwarded-for": "198.51.100.5", origin: "https://pods.example" };
  const off = await withAdmin();
  const on = await withAdmin({ TRUST_PROXY: "uniquelocal" });
  try {
    const x = new Browser(off, "10.0.0.2");
    assert.equal((await x.req("POST", "/api/v1/auth/login", { username: "patch", password: PW }, hdr)).json.error, "bad_origin");
    const y = new Browser(on, "10.0.0.2");
    const r = await y.req("POST", "/api/v1/auth/login", { username: "patch", password: PW }, hdr);
    assert.equal(r.status, 200); assert.match(String(r.headers["set-cookie"]), /; Secure/); assert.ok(r.headers["strict-transport-security"]);
    const z = new Browser(on, "203.0.113.50"); // not a trusted proxy address
    assert.equal((await z.req("POST", "/api/v1/auth/login", { username: "patch", password: PW }, hdr)).json.error, "bad_origin");
  } finally { await off.stop(); await on.stop(); }
});

test("BASE_PATH: API, cookie path, index, manifest and redirect", async () => {
  const ctx = await withAdmin({ BASE_PATH: "/pods" }, { webDir: new URL("../web", import.meta.url).pathname });
  try {
    const b = new Browser(ctx);
    const r = await b.login();
    assert.match(String(r.headers["set-cookie"]), /Path=\/pods;/);
    const idx = await b.req("GET", "/");
    assert.match(idx.body, /\/pods\/app\.js/); assert.doesNotMatch(idx.body, /__BASE__/);
    assert.equal((await ctx.app.inject("/pods")).headers.location, "/pods/");
    assert.equal((await b.req("GET", "/manifest.webmanifest")).json.scope, "/pods/");
    assert.equal((await b.req("GET", "/podcast/3")).status, 200, "SPA route");
    assert.equal((await ctx.app.inject("/api/v1/status")).statusCode, 404);
    assert.equal((await ctx.app.inject("/healthz")).statusCode, 200);
    for (const p of ["/..%2fpackage.json", "/%2e%2e/package.json", "/..%2f..%2f..%2fetc%2fpasswd"]) assert.doesNotMatch((await b.req("GET", p)).body, /patchcast-server|root:/);
  } finally { await ctx.stop(); }
});

describe("library with a real HTTP feed host", () => {
  let ctx: Ctx, b: Browser, host: Awaited<ReturnType<typeof serve>>, body: string, hits: Record<string, number>, seen: http.IncomingHttpHeaders = {};
  const audio = Buffer.from(Array.from({ length: 1000 }, (_, i) => i & 255));
  const png = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(200, 1)]);
  beforeEach(async () => {
    hits = {};
    host = await serve((req, res) => {
      const p = req.url!.split("?")[0];
      hits[p] = (hits[p] ?? 0) + 1; seen = req.headers;
      if (p === "/feed") { if (req.headers["if-none-match"] === '"1"') { res.writeHead(304); return res.end(); } res.writeHead(200, { etag: '"1"', "content-type": "application/rss+xml" }); return res.end(body); }
      if (p === "/a.mp3") {
        const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
        if (!m) { res.writeHead(200, { "content-type": "audio/mpeg", "content-length": audio.length, "accept-ranges": "bytes" }); return res.end(audio); }
        const e = m[2] ? +m[2] : audio.length - 1, part = audio.subarray(+m[1], e + 1);
        res.writeHead(206, { "content-type": "audio/mpeg", "content-length": part.length, "content-range": `bytes ${m[1]}-${e}/${audio.length}` }); return res.end(part);
      }
      if (p === "/page") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html>secret"); }
      if (p === "/ch.json") return res.end(JSON.stringify({ chapters: [{ startTime: 0, title: "Intro" }, { startTime: 30, title: "Main", img: `${host.url}/art.png` }] }));
      if (p === "/art.png") return res.end(png);
      if (p === "/art.svg") return res.end("<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>");
      res.writeHead(404); res.end();
    });
    body = rss([
      { guid: "e1", url: `${host.url}/a.mp3`, extra: `<podcast:chapters url="${host.url}/ch.json" type="application/json"/><itunes:image href="${host.url}/art.png"/><description>&lt;p&gt;Notes at 12:34&lt;/p&gt;&lt;script&gt;x&lt;/script&gt;</description>` },
      { guid: "e2", url: `${host.url}/page`, extra: `<itunes:image href="${host.url}/art.svg"/>` },
    ]);
    ctx = await withAdmin({ SSRF_ALLOW_HOSTS: host.host });
    b = new Browser(ctx); await b.login();
  });
  afterEach(async () => { await ctx.stop(); await host.close(); });
  const sub = () => b.req("POST", "/api/v1/subscriptions", { url: `${host.url}/feed` });

  test("subscribe → library → episode notes → chapters → art", async () => {
    const s = await sub();
    assert.equal(s.status, 200, JSON.stringify(s.json)); assert.equal((await sub()).json.already, true);
    const lib = (await b.req("GET", "/api/v1/library")).json.podcasts;
    assert.deepEqual([lib[0].title, lib[0].total, lib[0].unplayed], ["Test Cast", 2, 2]);
    const pod = (await b.req("GET", `/api/v1/podcasts/${s.json.id}`)).json;
    const e1 = pod.episodes.find((e: any) => e.guid === "e1");
    assert.equal((await b.req("GET", `/api/v1/episodes/${e1.id}`)).json.notes, "<p>Notes at 12:34</p>");
    const ch = (await b.req("GET", `/api/v1/episodes/${e1.id}/chapters`)).json;
    assert.deepEqual([ch.source, ch.chapters.map((c: any) => c.title)], ["json", ["Intro", "Main"]]);
    await b.req("GET", `/api/v1/episodes/${e1.id}/chapters`); assert.equal(hits["/ch.json"], 1, "cached");
    const art = await b.req("GET", ch.chapters[1].image);
    assert.deepEqual([art.status, art.headers["content-type"]], [200, "image/png"]);
    const forged = ch.chapters[1].image.replace(/art\/[^/]+\//, `art/${"A".repeat(27)}/`);
    assert.equal((await b.req("GET", forged)).status, 403, "art URLs must be signed");
    const e2 = pod.episodes.find((e: any) => e.guid === "e2");
    assert.equal((await b.req("GET", e2.image)).status, 404, "SVG is not served as art");
    assert.equal((await b.req("GET", "/api/v1/new")).json.episodes.length, 2);
  });

  test("audio range proxy streams ranges, refuses non-audio and other users", async () => {
    const s = await sub();
    const eps = (await b.req("GET", `/api/v1/podcasts/${s.json.id}`)).json.episodes;
    const e1 = eps.find((e: any) => e.guid === "e1"), e2 = eps.find((e: any) => e.guid === "e2");
    const r = await ctx.app.inject({ url: `/api/v1/audio/${e1.id}`, headers: { cookie: b.cookie, range: "bytes=10-19" } });
    assert.equal(r.statusCode, 206); assert.equal(r.headers["content-range"], "bytes 10-19/1000"); assert.ok(r.rawPayload.equals(audio.subarray(10, 20)));
    assert.equal(seen.cookie, undefined, "our cookie is not forwarded"); assert.equal(seen.authorization, undefined);
    const full = await ctx.app.inject({ url: `/api/v1/audio/${e1.id}`, headers: { cookie: b.cookie } });
    assert.ok(full.rawPayload.equals(audio));
    const html = await b.req("GET", `/api/v1/audio/${e2.id}`);
    assert.equal(html.status, 502); assert.doesNotMatch(html.body, /secret/);
    await ctx.auth.createUser("sam", PW, false);
    const o = new Browser(ctx); await o.login("sam");
    assert.equal((await o.req("GET", `/api/v1/audio/${e1.id}`)).status, 404);
    assert.equal((await o.req("GET", `/api/v1/episodes/${e1.id}`)).status, 404);
  });

  test("SSRF: private feeds, art and audio are refused without the allow list", async () => {
    for (const url of ["http://127.0.0.1:1/feed", "http://localhost/feed", "http://169.254.169.254/latest", "http://[::1]/f", "http://192.168.1.1/f", "http://10.0.0.1/x"]) {
      const r = await b.req("POST", "/api/v1/subscriptions", { url });
      assert.ok([400, 502].includes(r.status), url); assert.ok(["ssrf_blocked", "bad_url"].includes(r.json.error), `${url} ${r.json.error}`);
    }
    const d = await new Device(ctx).login("X");
    await d.push({ subscriptions: [{ feedUrl: "http://127.0.0.1:9/evil" }] }); // a pushed subscription is stored, its fetch is blocked
    await new Promise((r) => setTimeout(r, 200));
    assert.match(ctx.db.get("SELECT error FROM feeds WHERE key='127.0.0.1:9/evil'")!.error, /Blocked/);
  });

  test("refresh is conditional, adds episodes, keeps state", async () => {
    const s = await sub();
    assert.equal(await ctx.feeds.refreshFeed(s.json.id), null); assert.equal(hits["/feed"], 2);
    const e1 = (await b.req("GET", `/api/v1/podcasts/${s.json.id}`)).json.episodes.find((e: any) => e.guid === "e1");
    await b.req("POST", "/api/v1/episodes/played", { ids: [e1.id], played: true });
    body = body.replace("<channel>", "<channel>").replace("</channel>", `<item><title>New</title><guid>e3</guid><enclosure url="${host.url}/a.mp3"/></item></channel>`);
    await b.req("POST", "/api/v1/refresh", { podcastId: s.json.id });
    const eps = (await b.req("GET", `/api/v1/podcasts/${s.json.id}`)).json.episodes;
    assert.equal(eps.length, 3); assert.equal(eps.find((e: any) => e.guid === "e1").played, true);
  });

  test("web actions reach devices: played, progress, queue, unsubscribe", async () => {
    const s = await sub();
    const d = await new Device(ctx).login("Phone");
    const eps = (await b.req("GET", `/api/v1/podcasts/${s.json.id}`)).json.episodes;
    const id = (g: string) => eps.find((e: any) => e.guid === g).id;
    let rev = (await d.pull()).json.rev;
    await b.req("PUT", "/api/v1/queue", { base: [], items: [id("e2"), id("e1")] });
    let p = (await d.pull(rev)).json; rev = p.rev;
    assert.deepEqual(p.queue.map((q: any) => q.guid), ["e2", "e1"]);
    await b.req("POST", `/api/v1/episodes/${id("e1")}/progress`, { positionMs: 1_421_000, durationMs: 5_000_000, playing: true });
    p = (await d.pull(rev)).json; rev = p.rev;
    assert.deepEqual([p.episodes[0].guid, p.episodes[0].positionMs, p.latest.positionMs], ["e1", 1_421_000, 1_421_000]);
    await b.req("POST", "/api/v1/episodes/played", { ids: [id("e2")], played: true });
    p = (await d.pull(rev)).json; rev = p.rev;
    assert.deepEqual([p.episodes[0].played, p.queue.map((q: any) => q.guid)], [true, ["e1"]]);
    await new Promise((r) => setTimeout(r, 5)); // "strictly newer"
    await b.req("POST", "/api/v1/episodes/played", { ids: [id("e2")], played: false });
    p = (await d.pull(rev)).json; rev = p.rev;
    assert.equal(p.episodes[0].played, false);
    await b.req("PATCH", `/api/v1/subscriptions/${s.json.id}`, { speed: 1.25 });
    await b.req("DELETE", `/api/v1/subscriptions/${s.json.id}`);
    p = (await d.pull(rev)).json;
    assert.deepEqual([p.subscriptions[0].deleted, p.subscriptions[0].settings.speed, p.queue], [true, 1.25, []]);
    // and the other way: the phone's progress is offered to the browser
    await d.push({ subscriptions: [{ feedUrl: `${host.url}/feed`, deleted: false }], episodes: [{ feedUrl: `${host.url}/feed`, guid: "e1", positionMs: 2_000_000 }] });
    const l = (await b.req("GET", "/api/v1/latest")).json.latest;
    assert.deepEqual([l.episode.guid, l.episode.positionMs, l.deviceName, l.mine], ["e1", 2_000_000, "Phone", false]);
  });

  test("history and OPML import/export round trip", async () => {
    const h = { format: "patchcast-history", version: 1, exportedAt: new Date(Date.now() - 1000).toISOString(), podcasts: [{ feedUrl: `${host.url}/feed`, title: "T", priority: 3, playbackSpeed: 1.2 }],
      episodes: [{ feedUrl: `${host.url}/feed`, guid: "e1", played: true, positionMs: 0, playedAt: 1000 }, { feedUrl: `${host.url}/feed`, guid: "e2", played: false, positionMs: 4242, lastPlayedAt: 2000 }, { junk: 1 }] };
    const r = (await b.req("POST", "/api/v1/import/history", h)).json;
    assert.deepEqual([r.subscribed, r.applied, r.skipped], [1, 2, 1]);
    const again = (await b.req("POST", "/api/v1/import/history", h)).json;
    assert.deepEqual([again.subscribed, again.applied], [0, 0]);
    const out = (await b.req("GET", "/api/v1/export/history")).json;
    assert.deepEqual(out.episodes.map((e: any) => [e.guid, e.played, e.positionMs]).sort(), [["e1", true, 0], ["e2", false, 4242]]);
    assert.deepEqual([out.podcasts[0].priority, out.podcasts[0].playbackSpeed], [3, 1.2]);
    assert.equal((await b.req("POST", "/api/v1/import/history", { format: "x" })).status, 422);
    await ctx.auth.createUser("sam", PW, false);
    const o = new Browser(ctx); await o.login("sam");
    const opml = (await b.req("GET", "/api/v1/export/opml")).body;
    const im = (await o.req("POST", "/api/v1/import/opml", opml, { "content-type": "text/xml" })).json;
    assert.deepEqual([im.imported, im.already, im.failed.length], [1, 0, 0]);
  });

  test("SSE delivers change and live progress events, and ends on revocation", async () => {
    const s = await sub();
    await ctx.app.listen({ port: 0, host: "127.0.0.1" });
    const port = (ctx.app.server.address() as AddressInfo).port;
    const d = await new Device(ctx).login("Phone");
    let text = "", ended = false;
    const req = http.get({ port, host: "127.0.0.1", path: "/api/v1/events", headers: { authorization: `Bearer ${d.token}` } }, (res) => {
      assert.match(String(res.headers["content-type"]), /text\/event-stream/);
      res.on("data", (c) => (text += c)); res.on("end", () => (ended = true));
    });
    const until = async (re: RegExp) => { for (let i = 0; i < 100 && !re.test(text); i++) await new Promise((r) => setTimeout(r, 20)); assert.match(text, re); };
    await until(/event: hello/);
    const e1 = (await b.req("GET", `/api/v1/podcasts/${s.json.id}`)).json.episodes[0];
    await b.req("POST", `/api/v1/episodes/${e1.id}/progress`, { positionMs: 1000, playing: true });
    await until(/event: change/); await until(/event: progress\ndata: .*"positionMs":1000.*"playing":true/);
    await b.req("DELETE", `/api/v1/devices/${d.id}`);
    for (let i = 0; i < 100 && !ended; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(ended, true);
    req.destroy();
  });
});

test("no secrets in logs", async () => {
  let out = "";
  const ctx = await withAdmin({ LOG_LEVEL: "trace" }, { logger: undefined });
  const orig = process.stdout.write;
  try {
    (process.stdout as any).write = (c: any, ...r: any[]) => { out += c; return orig.call(process.stdout, "", ...r); };
    const b = new Browser(ctx);
    await b.login("patch", "super-secret-wrong-pw");
    await b.login();
    const d = await new Device(ctx).login("Phone");
    await d.pull();
    assert.equal(out.includes("super-secret-wrong-pw") || out.includes(PW) || out.includes(d.token) || out.includes(b.cookie.split("=")[1]) || out.includes(b.csrf), false);
  } finally { (process.stdout as any).write = orig; await ctx.stop(); }
});
