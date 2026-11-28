import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { Writable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { SignJWT } from "jose";
import { Browser, Device, TEST_OIDC, addUser, makeApp, withAdmin, type Ctx } from "./helpers.ts";
import { mockIdp, type Idp } from "./mock-idp.ts";
import { ConfigError, VERSION, loadConfig } from "../src/config.ts";
import { Db } from "../src/db.ts";
import pkg from "../package.json" with { type: "json" };
import { deriveUsername, safeReturnTo } from "../src/oidc.ts";

const PUBLIC = "http://pods.test";
const env = (idp: Idp, more: Record<string, string> = {}) => ({ PUBLIC_URL: PUBLIC, OIDC_ISSUER: idp.url, OIDC_CLIENT_ID: "client", OIDC_CLIENT_SECRET: "s:ecret", ...more });
const H = { host: "pods.test" };

/** A browser that keeps all cookies and talks to PUBLIC_URL. */
class Sso extends Browser {
  jar = new Map<string, string>();
  override async req(method: any, url: string, body?: any, headers: any = {}) {
    const r = await this.ctx.app.inject({ method, url: this.ctx.config.basePath + url, payload: body, remoteAddress: this.ip, headers: {
      ...H, ...(this.jar.size ? { cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}), ...(this.csrf && method !== "GET" ? { "x-csrf-token": this.csrf } : {}), ...headers } });
    for (const c of [r.headers["set-cookie"] ?? []].flat()) {
      const [k, v] = c.split(";")[0].split("=");
      if (/Max-Age=0/.test(c)) this.jar.delete(k); else this.jar.set(k, v);
    }
    let json: any = null;
    try { json = r.json(); } catch {}
    if (json?.csrf) { this.csrf = json.csrf; this.deviceId = json.deviceId; }
    return { status: r.statusCode, json, headers: r.headers, body: r.body };
  }
  async sso(idp: Idp, returnTo = "/") {
    const s = await this.req("GET", `/auth/oidc/login?returnTo=${encodeURIComponent(returnTo)}`);
    assert.equal(s.status, 302, s.body);
    const r = await this.req("GET", `/auth/oidc/callback?${idp.authorize(String(s.headers.location)).query}`);
    if (r.status === 302 && this.jar.has("patchcast_session")) await this.req("GET", "/api/v1/me");
    return r;
  }
  /** A session for an existing account without going through the provider. */
  override async login(username = "patch") {
    const u = this.ctx.db.get("SELECT id FROM users WHERE username=?", username)!;
    this.jar.set("patchcast_session", this.ctx.auth.createSession(u.id, "Test browser").id);
    return this.me();
  }
  me() { return this.req("GET", "/api/v1/me"); }
}

test("config: OIDC is required", () => {
  const dir = mkdtempSync(join(tmpdir(), "pcs-")), b = { DATA_DIR: dir, PUBLIC_URL: "https://pod.example.com" };
  const refused = (env: Record<string, string>, re: RegExp) => assert.throws(() => loadConfig(env), (e: any) => e instanceof ConfigError && re.test(e.message));
  refused(b, /^OIDC_ISSUER, OIDC_CLIENT_ID are not set\. .*signs in only with an OpenID Connect provider/);
  refused({ ...b, OIDC_ISSUER: "https://a.example" }, /^OIDC_CLIENT_ID is not set/);
  refused({ ...b, OIDC_CLIENT_ID: "x" }, /^OIDC_ISSUER is not set/);
  refused({ ...b, OIDC_ISSUER: " ", OIDC_CLIENT_ID: "x" }, /^OIDC_ISSUER is not set/); // compose passes blanks for unset variables
  const full = { ...b, OIDC_ISSUER: "https://auth.example.com/", OIDC_CLIENT_ID: "x" };
  refused({ ...full, PUBLIC_URL: "" }, /^PUBLIC_URL is not set/);
  refused({ ...full, PUBLIC_URL: "not a url" }, /PUBLIC_URL must be a URL/);
  refused({ ...full, OIDC_ISSUER: "ftp://x" }, /plain http/); refused({ ...full, OIDC_AUTO_CREATE: "maybe" }, /OIDC_AUTO_CREATE/);
  refused({ ...full, OIDC_CLIENT_SECRET_FILE: join(dir, "missing") }, /can't be read \(ENOENT\)/);
  const o = loadConfig(full).oidc;
  assert.deepEqual([o.issuer, o.scopes, o.providerName, o.autoCreate, o.allowedGroups, o.adminGroups, o.clientSecret], ["https://auth.example.com", "openid profile email groups", "Pocket ID", true, [], [], null]);
  assert.ok(!("passwordLogin" in o));
  const f = join(dir, "secret"); writeFileSync(f, "  from-file\n");
  assert.equal(loadConfig({ ...full, OIDC_CLIENT_SECRET_FILE: f }).oidc.clientSecret, "from-file");
  assert.throws(() => loadConfig({ ...full, OIDC_CLIENT_SECRET_FILE: f, OIDC_CLIENT_SECRET: "y" }));
  // Compose passes empty strings for unset variables.
  const e = loadConfig({ ...full, OIDC_AUTO_CREATE: "", OIDC_ALLOWED_GROUPS: " a, b ,", OIDC_SCOPES: "profile", OIDC_CLIENT_SECRET: "" }).oidc;
  assert.deepEqual([e.autoCreate, e.allowedGroups, e.scopes, e.clientSecret], [true, ["a", "b"], "openid profile", null]);
  // Password-era settings are reported, not used.
  assert.deepEqual(loadConfig({ ...full, ADMIN_USER: "patch", ADMIN_PASSWORD: "x", ALLOW_REGISTRATION: "true", OIDC_PASSWORD_LOGIN: "" }).ignored, ["ADMIN_USER", "ADMIN_PASSWORD", "ALLOW_REGISTRATION"]);
  assert.equal(VERSION, pkg.version, "config.version is the package version");
});

test("nothing is written to DATA_DIR when the configuration is refused", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "pcs-")), "data");
  assert.throws(() => loadConfig({ DATA_DIR: dir }));
  assert.equal(existsSync(dir), false);
});

describe("the server process", () => {
  const main = new URL("../src/main.ts", import.meta.url).pathname;
  const run = (env: Record<string, string>, args: string[] = []) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", main, ...args],
    { env: { PATH: process.env.PATH, DATA_DIR: mkdtempSync(join(tmpdir(), "pcs-")), LOG_LEVEL: "info", ...env }, encoding: "utf8", timeout: 20_000 });

  test("refuses to start without OIDC, with a clear message and no stack trace", () => {
    for (const env of [{}, { OIDC_ISSUER: "https://auth.example.com", OIDC_CLIENT_ID: "x" }, { OIDC_ISSUER: "https://auth.example.com", PUBLIC_URL: "https://pod.example.com" }] as Record<string, string>[]) {
      const r = run(env);
      assert.equal(r.status, 1, JSON.stringify(env)); assert.match(r.stderr, /^Patchcast Sync can't start: .*(OIDC_CLIENT_ID|OIDC_ISSUER|PUBLIC_URL).* not set/);
      assert.doesNotMatch(r.stderr, /\n\s+at /, "no stack trace");
    }
  });
  test("set-password is gone", () => {
    const r = run({}, ["set-password", "patch"]);
    assert.equal(r.status, 2); assert.match(r.stderr, /removed in 0\.8\.0/);
  });
  test("starts with OIDC, announces the first-admin rule and ignores password settings", async () => {
    const port = String(20000 + Math.floor(Math.random() * 20000));
    const p = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", main], {
      env: { PATH: process.env.PATH, DATA_DIR: mkdtempSync(join(tmpdir(), "pcs-")), LOG_LEVEL: "info", PORT: port, HOST: "127.0.0.1", ...TEST_OIDC, ADMIN_USER: "patch", ADMIN_PASSWORD: "correct horse battery" } });
    let out = "";
    p.stdout.on("data", (c) => (out += c)); p.stderr.on("data", (c) => (out += c));
    try {
      let health: any = null;
      for (let i = 0; i < 100 && !health; i++) {
        await new Promise((r) => setTimeout(r, 100));
        health = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json(), () => null);
      }
      assert.deepEqual(health, { ok: true, version: VERSION });
      const info = await (await fetch(`http://127.0.0.1:${port}/api/v1/server-info`)).json();
      assert.deepEqual([info.passwordLogin, info.registrationOpen, info.setupRequired], [false, false, false]);
      assert.match(out, /the first person to sign in with Pocket ID becomes the administrator/);
      assert.match(out, /removed in 0\.8\.0.*ignored/); assert.match(out, /ADMIN_PASSWORD/);
      assert.doesNotMatch(out, /correct horse battery|setup token/i);
    } finally { p.kill("SIGTERM"); await new Promise((r) => p.once("exit", r)); }
  });
});

test("returnTo never leaves the site", () => {
  for (const v of ["//evil.com", "https://evil.com", "/\\evil.com", "/..//evil.com", "/.//evil.com", "/%2e//evil.com", "javascript:alert(1)", "/a\tb", "/a\r\nSet-Cookie: x", "", "evil", undefined, ["/a"], "/api/v1/me", "/auth/oidc/login", "/" + "a".repeat(600)]) assert.equal(safeReturnTo(v), "/", String(v));
  assert.equal(safeReturnTo("/podcast/3?x=1"), "/podcast/3?x=1"); assert.equal(safeReturnTo("/settings"), "/settings");
});

test("username derivation", () => {
  const none = () => false;
  assert.equal(deriveUsername({ preferredUsername: "patch", email: null }, none), "patch");
  assert.equal(deriveUsername({ preferredUsername: null, email: "jo.doe+x@example.com" }, none), "jo.doex");
  assert.equal(deriveUsername({ preferredUsername: "  <script>", email: null }, none), "script");
  assert.equal(deriveUsername({ preferredUsername: "Zoë Ünal", email: null }, none), "Zoe.Unal");
  assert.equal(deriveUsername({ preferredUsername: "日本", email: null }, none), "user");
  assert.equal(deriveUsername({ preferredUsername: "patch", email: null }, (u) => ["patch", "patch-2"].includes(u)), "patch-3");
  assert.ok(deriveUsername({ preferredUsername: "x".repeat(200), email: null }, none).length <= 40);
});

test("database from 0.6.0 is upgraded in place", () => {
  const dir = mkdtempSync(join(tmpdir(), "pcs-")), path = join(dir, "patchcast.db");
  Db.open(dir).close();
  // Turn it back into a version 1 file.
  const raw = new DatabaseSync(path);
  raw.exec("ALTER TABLE feeds DROP COLUMN funding; ALTER TABLE feeds DROP COLUMN persons; ALTER TABLE episodes DROP COLUMN persons; ALTER TABLE episodes DROP COLUMN transcripts; ALTER TABLE episodes DROP COLUMN transcript; ALTER TABLE episodes DROP COLUMN transcript_source; DROP TABLE ratings; DROP TABLE meta; DROP TABLE user_settings; DROP TABLE identities; ALTER TABLE users DROP COLUMN display_name; ALTER TABLE users DROP COLUMN pw_recovery_until; ALTER TABLE sessions DROP COLUMN via; ALTER TABLE sessions DROP COLUMN id_token; PRAGMA user_version=1; INSERT INTO users(username,pw_hash,is_admin,created_at) VALUES('patch','h',1,1)");
  raw.close();
  const db = Db.open(dir);
  assert.equal(db.get("SELECT pw_recovery_until r FROM users WHERE username='patch'")!.r, 0); assert.equal(db.all("SELECT * FROM identities").length, 0);
  db.close();
});

describe("oidc", () => {
  let idp: Idp, ctx: Ctx, b: Sso;
  const start = async (more: Record<string, string> = {}, extra: any = {}) => { if (ctx) await ctx.stop(); ctx = await withAdmin(env(idp, more), extra); b = new Sso(ctx); };
  beforeEach(async () => { idp = await mockIdp(); ctx = undefined as any; await start(); });
  afterEach(async () => { await ctx.stop(); await idp.close(); });
  const users = () => ctx.db.all("SELECT username,is_admin,pw_hash,display_name FROM users ORDER BY id");

  test("server-info: the provider is advertised and passwords are off, also before the first account", async () => {
    const want = { name: "Patchcast Sync", version: VERSION, api: 1, setupRequired: false, registrationOpen: false, passwordLogin: false, oidc: { enabled: true, providerName: "Pocket ID" } };
    assert.deepEqual((await b.req("GET", "/api/v1/server-info")).json, want);
    assert.deepEqual((await b.req("GET", "/api/v1/status")).json, want);
    const empty = await makeApp(env(idp, { OIDC_PROVIDER_NAME: "Example ID" }));
    try {
      assert.deepEqual((await new Browser(empty).req("GET", "/api/v1/server-info")).json, { ...want, oidc: { enabled: true, providerName: "Example ID" } });
    } finally { await empty.stop(); }
  });

  test("password routes are gone: 404 signed in or not, and nothing is created", async () => {
    const pw = { username: "patch", password: "correct horse battery", token: "x", deviceName: "x", newPassword: "another long password" };
    const routes: [string, string][] = [["POST", "/api/v1/auth/login"], ["POST", "/api/v1/auth/register"], ["POST", "/api/v1/auth/setup"], ["POST", "/api/v1/auth/device"],
      ["POST", "/api/v1/me/password"], ["POST", "/api/v1/users"], ["POST", "/api/v1/me/oidc/link"], ["DELETE", "/api/v1/me/oidc/link"], ["GET", "/api/v1/auth/login"]];
    const before = ctx.db.all("SELECT * FROM users").length;
    for (const [m, u] of routes) assert.equal((await b.req(m, u, m === "GET" || m === "DELETE" ? undefined : pw)).status, 404, `${m} ${u} signed out`);
    await b.login();
    for (const [m, u] of routes) {
      const r = await b.req(m, u, m === "GET" || m === "DELETE" ? undefined : pw);
      assert.equal(r.status, 404, `${m} ${u} as admin`); assert.equal(r.json.error, "not_found");
    }
    assert.equal(ctx.db.all("SELECT * FROM users").length, before);
    assert.equal(ctx.db.get("SELECT pw_hash FROM users WHERE username='patch'")!.pw_hash, "");
  });

  test("login: request parameters, auto-create, cookie flags, second login re-uses the user", async () => {
    const s = await b.req("GET", "/auth/oidc/login?returnTo=/settings");
    const a = idp.authorize(String(s.headers.location));
    assert.equal(a.params.get("redirect_uri"), `${PUBLIC}/auth/oidc/callback`); assert.equal(a.params.get("response_type"), "code"); assert.equal(a.params.get("code_challenge_method"), "S256");
    assert.equal(a.params.get("scope"), "openid profile email groups"); assert.ok(a.params.get("nonce")!.length >= 40); assert.ok(a.state.length >= 40);
    assert.match(String(s.headers["set-cookie"]), /HttpOnly; SameSite=Lax; Max-Age=600$/); assert.match(String(s.headers["set-cookie"]), /Path=\/auth\/oidc;/);
    const r = await b.req("GET", `/auth/oidc/callback?${a.query}`);
    assert.equal(r.status, 302); assert.equal(r.headers.location, "/settings");
    assert.ok([r.headers["set-cookie"]].flat().some((c) => /^patchcast_session=.*HttpOnly; SameSite=Strict/.test(String(c))));
    assert.equal((await b.me()).json.user.username, "alice"); assert.equal((await b.me()).json.user.isAdmin, false);
    assert.deepEqual({ ...users()[1] }, { username: "alice", is_admin: 0, pw_hash: "", display_name: "Alice A" });
    const again = new Sso(ctx);
    idp.user.preferred_username = "renamed"; // same sub = same account
    await again.sso(idp);
    assert.equal((await again.me()).json.user.username, "alice"); assert.equal(users().length, 2);
  });

  test("identity is (issuer, sub): the same username or email never takes over an account", async () => {
    idp.user = { sub: "evil", preferred_username: "patch", email: "patch@example.com", name: "P", groups: [] };
    await b.sso(idp);
    assert.equal((await b.me()).json.user.username, "patch-2"); assert.equal((await b.me()).json.user.isAdmin, false);
  });

  test("OIDC_AUTO_CREATE=false", async () => {
    await start({ OIDC_AUTO_CREATE: "false" });
    const r = await b.sso(idp);
    assert.equal(r.status, 403); assert.match(r.body, /No account/); assert.equal(users().length, 1); assert.equal((await b.me()).status, 401);
  });

  test("groups: allow, deny, admin promotion and demotion, last admin kept", async () => {
    await start({ OIDC_ALLOWED_GROUPS: "podcasts,family", OIDC_ADMIN_GROUPS: "admins" });
    idp.user.groups = ["other"];
    let r = await b.sso(idp);
    assert.equal(r.status, 403); assert.match(r.body, /group/); assert.equal(users().length, 1);
    delete idp.user.groups;
    assert.equal((await b.sso(idp)).status, 403);
    idp.user.groups = ["family", "admins"];
    await b.sso(idp); assert.equal((await b.me()).json.user.isAdmin, true);
    idp.user.groups = ["family"];
    await b.sso(idp); assert.equal((await b.me()).json.user.isAdmin, false);
    idp.user.groups = ["family", "admins"]; await b.sso(idp);
    ctx.db.run("DELETE FROM users WHERE username='patch'");
    idp.user.groups = ["family"];
    await b.sso(idp); assert.equal((await b.me()).json.user.isAdmin, true, "the last admin is never demoted");
  });

  test("claims missing from the ID token come from userinfo, whose sub must match", async () => {
    idp.idTokenOnly = ["sub"];
    await b.sso(idp);
    assert.equal((await b.me()).json.user.username, "alice"); assert.equal(idp.hits["/userinfo"], 1);
    idp.userinfoSub = "someone-else";
    assert.equal((await new Sso(ctx).sso(idp)).status, 502);
  });

  describe("first administrator", () => {
    const fresh = async (more: Record<string, string> = {}) => { await ctx.stop(); ctx = await makeApp(env(idp, more)); b = new Sso(ctx); };
    const as = (sub: string, groups: string[] = []) => { idp.user = { sub, preferred_username: sub, name: sub, email: `${sub}@example.com`, groups }; };

    test("without OIDC_ADMIN_GROUPS the very first sign-in becomes administrator, nobody after it", async () => {
      await fresh();
      as("owner"); assert.equal((await b.sso(idp)).status, 302);
      assert.deepEqual((await b.me()).json.user, { id: 1, username: "owner", isAdmin: true });
      as("guest"); const g = new Sso(ctx); await g.sso(idp);
      assert.equal((await g.me()).json.user.isAdmin, false);
      as("owner"); const again = new Sso(ctx); await again.sso(idp);
      assert.equal((await again.me()).json.user.isAdmin, true, "stays admin");
      assert.deepEqual(users().map((u) => [u.username, u.is_admin]), [["owner", 1], ["guest", 0]]);
    });

    test("with OIDC_ADMIN_GROUPS only a member may be first; then others are ordinary users", async () => {
      await fresh({ OIDC_ADMIN_GROUPS: "admins" });
      as("guest", ["podcasts"]);
      const r = await b.sso(idp);
      assert.equal(r.status, 403); assert.match(r.body, /no administrator yet/); assert.equal(ctx.auth.userCount(), 0); assert.equal((await b.me()).status, 401);
      as("owner", ["admins"]); await b.sso(idp);
      assert.equal((await b.me()).json.user.isAdmin, true);
      as("guest", ["podcasts"]); const g = new Sso(ctx); await g.sso(idp);
      assert.equal((await g.me()).json.user.isAdmin, false);
    });

    test("the app is told setup_first, and gets nothing", async () => {
      await fresh({ OIDC_ADMIN_GROUPS: "admins" });
      as("guest");
      const challenge = createHash("sha256").update("v".repeat(43)).digest("base64url");
      const s = await b.req("GET", "/auth/oidc/app?" + new URLSearchParams({ code_challenge: challenge, redirect_uri: "patchcast://sync-callback", state: "app-state-1" }));
      const r = await b.req("GET", `/auth/oidc/callback?${idp.authorize(String(s.headers.location)).query}`);
      assert.equal(r.headers.location, "patchcast://sync-callback?error=setup_first&state=app-state-1"); assert.equal(ctx.auth.userCount(), 0);
    });

    test("OIDC_AUTO_CREATE=false creates nobody, not even the first", async () => {
      await fresh({ OIDC_AUTO_CREATE: "false" });
      as("owner", ["admins"]);
      const r = await b.sso(idp);
      assert.equal(r.status, 403); assert.match(r.body, /No account here/); assert.equal(ctx.auth.userCount(), 0);
    });

    test("an empty server in a not-allowed group still turns people away", async () => {
      await fresh({ OIDC_ALLOWED_GROUPS: "family" });
      as("stranger", ["other"]);
      assert.equal((await b.sso(idp)).status, 403); assert.equal(ctx.auth.userCount(), 0);
      as("owner", ["family"]); await b.sso(idp);
      assert.equal((await b.me()).json.user.isAdmin, true);
    });
  });

  test("upgrade from 0.7: linked accounts keep their sessions and tokens; password-only accounts are shut out", async () => {
    // Accounts as 0.7 left them: 'patch' is linked (made by withAdmin); 'old' has only a password; 'moved' is linked to another issuer.
    ctx.db.run("UPDATE users SET pw_hash='$argon2id$v' WHERE username='patch'");
    const old = Number(ctx.db.run("INSERT INTO users(username,pw_hash,is_admin,created_at,pw_recovery_until) VALUES('old','$argon2id$x',1,1,?)", Date.now() + 86_400_000).lastInsertRowid);
    const moved = addUser(ctx, "moved"); ctx.db.run("UPDATE identities SET issuer='https://old-idp.example' WHERE user_id=?", moved);
    const session = (username: string) => { const x = new Sso(ctx); return x.login(username).then(() => x); };
    const linked = await session("patch"); ctx.db.run("UPDATE sessions SET via='password'");
    const linkedDev = await new Device(ctx).login("Old phone", "patch");
    assert.equal((await linked.me()).status, 200); assert.equal((await linkedDev.pull()).status, 200);
    for (const u of ["old", "moved"]) {
      assert.equal((await (await session(u)).me()).status, 401, `${u}: browser session`);
      assert.equal((await (await new Device(ctx).login("Phone", u)).pull()).status, 401, `${u}: device token`);
    }
    // Nothing is deleted or rewritten: the admin sees them and decides.
    assert.equal(ctx.db.get("SELECT pw_hash FROM users WHERE id=?", old)!.pw_hash, "$argon2id$x");
    const list = (await linked.req("GET", "/api/v1/users")).json.users;
    assert.deepEqual(list.map((u: any) => [u.username, u.oidc]), [["patch", true], ["old", false], ["moved", false]]);
    assert.equal((await linked.req("DELETE", `/api/v1/users/${old}`)).status, 200);
    // Signing in with the provider still finds 'patch' by (issuer, sub), whatever its password column says.
    idp.user = { ...idp.user, sub: "patch-sub" }; const x = new Sso(ctx); await x.sso(idp);
    assert.deepEqual((await x.me()).json.user, { id: 1, username: "patch", isAdmin: true });
  });

  test("account page: identity from the provider, nothing about passwords or unlinking", async () => {
    await b.sso(idp);
    const acc = (await b.req("GET", "/api/v1/me/account")).json;
    assert.deepEqual(Object.keys(acc).sort(), ["displayName", "identity", "isAdmin", "oidc", "sessionVia", "username"]);
    assert.deepEqual([acc.username, acc.sessionVia, acc.identity.email, acc.oidc.providerName], ["alice", "oidc", "alice@example.com", "Pocket ID"]);
  });

  describe("hostile responses", () => {
    const refused = async (status = 502) => {
      const r = await b.sso(idp);
      assert.equal(r.status, status, r.body); assert.equal((await b.me()).status, 401); assert.equal(users().length, 1);
      assert.doesNotMatch(r.body, /eyJ|s:ecret/);
    };
    const now = () => Math.floor(Date.now() / 1000);
    const cases: [string, () => void][] = [
      ["wrong issuer", () => { idp.claims = { iss: "https://evil.example" }; }],
      ["wrong audience", () => { idp.claims = { aud: "other" }; }],
      ["several audiences without azp", () => { idp.claims = { aud: ["client", "other"] }; }],
      ["foreign azp", () => { idp.claims = { aud: ["client", "other"], azp: "other" }; }],
      ["foreign azp with a single audience", () => { idp.claims = { azp: "other" }; }],
      ["wrong nonce", () => { idp.claims = { nonce: "x" }; }],
      ["no nonce", () => { idp.claims = { nonce: undefined }; }],
      ["expired", () => { idp.claims = { iat: now() - 600, exp: now() - 120 }; }],
      ["no exp", () => { idp.claims = { exp: undefined }; }],
      ["issued in the future", () => { idp.claims = { iat: now() + 600, exp: now() + 900 }; }],
      ["issued long ago", () => { idp.claims = { iat: now() - 7200 }; }],
      ["no sub", () => { idp.claims = { sub: undefined }; }],
      ["not yet valid", () => { idp.claims = { nbf: now() + 600 }; }],
      ["wrong at_hash", () => { idp.claims = { at_hash: "AAAAAAAAAAAAAAAAAAAAAA" }; }],
      ["tampered payload", () => { idp.sign = async (c) => { const t = (await new SignJWT(c).setProtectedHeader({ alg: "RS256", kid: idp.key.kid }).sign(idp.key.privateKey)).split("."); t[1] = Buffer.from(JSON.stringify({ ...c, sub: "admin" })).toString("base64url"); return t.join("."); }; }],
      ["tampered signature", () => { idp.sign = async (c) => { const t = await new SignJWT(c).setProtectedHeader({ alg: "RS256", kid: idp.key.kid }).sign(idp.key.privateKey); return t.slice(0, -10) + (t.at(-10) === "A" ? "B" : "A") + t.slice(-9); }; }],
      ["signed by a key that isn't published", () => { const pub = idp.published; const kid = idp.key.kid; idp.rotate(); idp.published = pub; idp.key.kid = kid; }],
      ["alg none", () => { idp.sign = async (c) => `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(c)).toString("base64url")}.`; }],
      ["HS256 with the public key or client secret", () => { idp.sign = async (c) => { const x = `${Buffer.from(JSON.stringify({ alg: "HS256", kid: idp.key.kid })).toString("base64url")}.${Buffer.from(JSON.stringify(c)).toString("base64url")}`; return `${x}.${createHmac("sha256", "s:ecret").update(x).digest("base64url")}`; }; }],
      ["HS256 even if the provider advertises it", () => { idp.meta = { id_token_signing_alg_values_supported: ["HS256", "none"] }; idp.sign = async (c) => new SignJWT(c).setProtectedHeader({ alg: "HS256" }).sign(Buffer.from("s:ecret".repeat(8))); }],
      ["not a JWT", () => { idp.sign = async () => "garbage"; }],
    ];
    for (const [name, set] of cases) test(name, async () => { set(); await refused(); });
    test("small clock skew is tolerated; correct azp and at_hash accepted", async () => {
      idp.claims = { iat: now() + 30, exp: now() + 300, aud: ["client"], azp: "client", at_hash: createHash("sha256").update("at").digest().subarray(0, 16).toString("base64url") };
      assert.equal((await b.sso(idp)).status, 302); assert.equal((await b.me()).status, 200);
    });
    test("discovery naming another issuer, or an internal host, is refused", async () => {
      idp.meta = { issuer: "https://evil.example" };
      assert.equal((await b.req("GET", "/auth/oidc/login")).status, 502);
      await start(); idp.meta = { token_endpoint: "http://169.254.169.254/latest" };
      await refused();
      await start(); idp.meta = { jwks_uri: "http://127.0.0.1:1/jwks" };
      await refused();
    });
  });

  test("key rotation: a new signing key is picked up", async () => {
    await b.sso(idp); assert.equal((await b.me()).status, 200);
    const t0 = Date.now(); idp.rotate();
    while (Date.now() - t0 < 5_100) await new Promise((r) => setTimeout(r, 200)); // jwks cooldown
    const x = new Sso(ctx);
    await x.sso(idp); assert.equal((await x.me()).status, 200); assert.equal(idp.hits["/jwks"], 2); assert.equal(idp.hits["/.well-known/openid-configuration"], 1);
  });

  test("state: forged, missing, foreign browser, replayed, expired", async () => {
    for (const q of ["", "code=x", "state=x", `code=x&state=${randomBytes(32).toString("base64url")}`, "state=a&state=b&code=x", "error=access_denied&state=x"]) {
      const r = await b.req("GET", `/auth/oidc/callback?${q}`);
      assert.equal(r.status, 400, q); assert.match(r.body, /expired/i);
    }
    const s = await b.req("GET", "/auth/oidc/login"), a = idp.authorize(String(s.headers.location));
    const victim = new Sso(ctx, "203.0.113.2");
    assert.equal((await victim.req("GET", `/auth/oidc/callback?${a.query}`)).status, 400, "login CSRF: not this browser's attempt");
    victim.jar.set([...b.jar.keys()][0], "forged");
    assert.equal((await victim.req("GET", `/auth/oidc/callback?${a.query}`)).status, 400);
    const jar = new Map(b.jar);
    assert.equal((await b.req("GET", `/auth/oidc/callback?${a.query}`)).status, 302);
    b.jar = jar;
    assert.equal((await b.req("GET", `/auth/oidc/callback?${a.query}`)).status, 400, "replay");
    let t = Date.now(); await start({}, { now: () => t });
    const s2 = await b.req("GET", "/auth/oidc/login"); t += 11 * 60_000;
    assert.equal((await b.req("GET", `/auth/oidc/callback?${idp.authorize(String(s2.headers.location)).query}`)).status, 400, "expired");
  });

  test("wrong or missing iss parameter, stolen code, provider error, two tabs", async () => {
    const go = async () => idp.authorize(String((await b.req("GET", "/auth/oidc/login")).headers.location));
    let a = await go();
    assert.equal((await b.req("GET", `/auth/oidc/callback?code=${a.code}&state=${a.state}&iss=https://evil.example`)).status, 502);
    a = await go();
    assert.equal((await b.req("GET", `/auth/oidc/callback?code=${a.code}&state=${a.state}`)).status, 502);
    a = await go(); const other = await go();
    assert.equal((await b.req("GET", `/auth/oidc/callback?code=${other.code}&state=${a.state}&iss=${idp.url}`)).status, 502, "code from another attempt: PKCE");
    a = await go();
    const d = await b.req("GET", `/auth/oidc/callback?error=access_denied&error_description=%3Cscript%3Ealert(1)%3C/script%3E&state=${a.state}`);
    assert.equal(d.status, 403); assert.match(d.body, /cancelled/); assert.doesNotMatch(d.body, /alert/);
    const t1 = await go(), t2 = await go();
    assert.equal((await b.req("GET", `/auth/oidc/callback?${t1.query}`)).status, 302); assert.equal((await b.req("GET", `/auth/oidc/callback?${t2.query}`)).status, 302);
  });

  test("provider down; callback rate limit", async () => {
    idp.down = true;
    const r = await b.req("GET", "/auth/oidc/login");
    assert.equal(r.status, 502); assert.match(r.body, /can&#39;t be reached/);
    idp.down = false;
    for (let i = 0; i < 20; i++) assert.equal((await b.req("GET", "/auth/oidc/callback?state=x&code=y")).status, 400);
    assert.equal((await b.req("GET", "/auth/oidc/callback?state=x&code=y")).status, 429);
    assert.equal((await new Sso(ctx, "203.0.113.77").sso(idp)).status, 302, "other addresses are unaffected");
  });

  test("logout: local by default, RP-initiated on request", async () => {
    await b.sso(idp);
    assert.equal((await b.req("POST", "/api/v1/auth/logout", {})).json.endSessionUrl, null);
    await b.sso(idp);
    assert.doesNotMatch(String(ctx.db.get("SELECT id_token t FROM sessions")!.t), /eyJ/, "ID token is encrypted at rest");
    const u = new URL((await b.req("POST", "/api/v1/auth/logout", { provider: true })).json.endSessionUrl);
    assert.equal(u.origin + u.pathname, `${idp.url}/logout`); assert.match(u.searchParams.get("id_token_hint")!, /^eyJ/); assert.equal(u.searchParams.get("post_logout_redirect_uri"), `${PUBLIC}/`);
    assert.equal((await b.me()).status, 401);
    await b.login(); ctx.db.run("UPDATE sessions SET via='password'");
    assert.equal((await b.req("POST", "/api/v1/auth/logout", { provider: true })).json.endSessionUrl, null, "session from 0.7 without an ID token");
  });

  test("moves to PUBLIC_URL once; base path is kept", async () => {
    const r = await b.req("GET", "/auth/oidc/login?returnTo=/library", undefined, { host: "192.168.1.5:8080" });
    assert.equal(r.headers.location, `${PUBLIC}/auth/oidc/login?returnTo=%2Flibrary&h=1`);
    await start({ BASE_PATH: "/podcasts" });
    const s = await b.req("GET", "/auth/oidc/login?returnTo=/library");
    const a = idp.authorize(String(s.headers.location));
    assert.equal(a.params.get("redirect_uri"), `${PUBLIC}/podcasts/auth/oidc/callback`); assert.match(String(s.headers["set-cookie"]), /Path=\/podcasts\/auth\/oidc;/);
    assert.equal((await b.req("GET", `/auth/oidc/callback?${a.query}`)).headers.location, "/podcasts/library");
  });

  test("nothing secret reaches the log", async () => {
    let log = "";
    const stream = new Writable({ write(c, _e, cb) { log += c; cb(); } });
    await ctx.stop();
    ctx = await withAdmin(env(idp), { logger: { level: "trace", stream, serializers: { req: (r: any) => ({ method: r.method, path: r.url.split("?")[0] }), res: (r: any) => ({ status: r.statusCode }) } } });
    b = new Sso(ctx);
    const s = await b.req("GET", "/auth/oidc/login"), a = idp.authorize(String(s.headers.location));
    await b.req("GET", `/auth/oidc/callback?${a.query}`);
    idp.claims = { nonce: "x" }; await new Sso(ctx).sso(idp);
    const jwt = await idp.idToken("n");
    assert.match(log, /oidc sign-in/); assert.match(log, /ID token refused: nonce/);
    for (const x of ["s:ecret", a.code, a.state, jwt.slice(0, 30), "eyJ", b.jar.get("patchcast_session")!, "alice"]) assert.ok(!log.includes(x), `log contains ${x.slice(0, 6)}…`);
  });

  describe("app", () => {
    const verifier = randomBytes(48).toString("base64url"), challenge = createHash("sha256").update(verifier).digest("base64url");
    const url = (o: Record<string, string> = {}) => "/auth/oidc/app?" + new URLSearchParams({ device_name: "S26", code_challenge: challenge, redirect_uri: "patchcast://sync-callback", state: "app-state-1", ...o });
    const signIn = async () => {
      const s = await b.req("GET", url()); assert.equal(s.status, 302, s.body);
      const r = await b.req("GET", `/auth/oidc/callback?${idp.authorize(String(s.headers.location)).query}`);
      assert.equal(r.status, 302); assert.match(String(r.headers.location), /^patchcast:\/\/sync-callback\?/);
      return new URL(String(r.headers.location)).searchParams;
    };
    const exchange = (code: string, v = verifier, ip = "203.0.113.50") => new Sso(ctx, ip).req("POST", "/api/v1/auth/oidc/exchange", { code, code_verifier: v });

    test("code for a named, revocable device token; single use", async () => {
      const p = await signIn();
      assert.equal(p.get("state"), "app-state-1"); assert.ok(!b.jar.has("patchcast_session"), "no browser session is created");
      const r = await exchange(p.get("code")!);
      assert.equal(r.status, 200, r.body); assert.match(r.json.token, /^pct_/); assert.equal(r.json.user.username, "alice");
      const d = new Device(ctx); d.token = r.json.token;
      assert.equal((await d.pull()).status, 200);
      assert.equal((await exchange(p.get("code")!)).status, 401, "replay");
      const web = new Sso(ctx); await web.sso(idp);
      const dev = (await web.req("GET", "/api/v1/devices")).json.devices.find((x: any) => x.kind === "app"); assert.equal(dev.name, "S26");
      assert.equal((await web.req("DELETE", `/api/v1/devices/${dev.id}`)).status, 200); assert.equal((await d.pull()).status, 401);
    });
    test("wrong verifier burns the code; expired code; other origins refused", async () => {
      let code = (await signIn()).get("code")!;
      assert.equal((await exchange(code, randomBytes(48).toString("base64url"))).status, 401); assert.equal((await exchange(code)).status, 401);
      assert.equal((await exchange("x")).status, 400);
      code = (await signIn()).get("code")!;
      assert.equal((await b.req("POST", "/api/v1/auth/oidc/exchange", { code, code_verifier: verifier }, { origin: "https://evil.example" })).status, 403);
      let t = Date.now(); await start({}, { now: () => t });
      code = (await signIn()).get("code")!; t += 121_000;
      assert.equal((await exchange(code)).status, 401);
    });
    test("exchange is rate limited", async () => {
      for (let i = 0; i < 20; i++) assert.equal((await exchange(randomBytes(32).toString("base64url"))).status, 401);
      assert.equal((await exchange(randomBytes(32).toString("base64url"))).status, 429);
    });
    test("only the exact redirect URI, with PKCE", async () => {
      for (const o of [{ redirect_uri: "https://evil.example" }, { redirect_uri: "patchcast://sync-callback.evil" }, { redirect_uri: "patchcast://sync-callback/x" }, { redirect_uri: "patchcast://evil" }, { redirect_uri: "PATCHCAST://sync-callback" }, { redirect_uri: "" },
        { code_challenge: "" }, { code_challenge: "short" }, { code_challenge_method: "plain" }, { state: "a b" }] as Record<string, string>[]) {
        const r = await b.req("GET", url(o));
        assert.equal(r.status, 400, JSON.stringify(o)); assert.equal(r.headers.location, undefined);
      }
    });
    test("denied, not in the group and provider failures go back to the app", async () => {
      let s = await b.req("GET", url()); let a = idp.authorize(String(s.headers.location));
      let r = await b.req("GET", `/auth/oidc/callback?error=access_denied&state=${a.state}`);
      assert.equal(r.headers.location, "patchcast://sync-callback?error=access_denied&state=app-state-1");
      idp.claims = { nonce: "x" };
      assert.equal((await signIn()).get("error"), "failed"); idp.claims = {};
      await start({ OIDC_ALLOWED_GROUPS: "family" });
      assert.equal((await signIn()).get("error"), "not_allowed");
      idp.down = true; await start();
      assert.match(String((await b.req("GET", url())).headers.location), /error=provider_unreachable/);
    });
    test("a user deleted between callback and exchange gets nothing", async () => {
      const code = (await signIn()).get("code")!;
      ctx.db.run("DELETE FROM users WHERE username='alice'");
      assert.equal((await exchange(code)).status, 401);
    });
  });
});
