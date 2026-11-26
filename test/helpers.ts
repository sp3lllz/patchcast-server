import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import { buildApp } from "../src/app.ts";

/** Every server needs an OIDC provider (0.8). Tests that don't sign in through it never contact this one. */
export const TEST_OIDC = { PUBLIC_URL: "http://localhost", OIDC_ISSUER: "https://auth.example.com", OIDC_CLIENT_ID: "client" };

export async function makeApp(env: Record<string, string> = {}, extra: any = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pcs-"));
  const config = loadConfig({ DATA_DIR: dir, LOG_LEVEL: "silent", ...TEST_OIDC, ...env });
  const ctx = await buildApp({ config, ...extra });
  await ctx.app.ready();
  return { ...ctx, config, dir, async stop() { await ctx.app.close(); rmSync(dir, { recursive: true, force: true }); } };
}
export type Ctx = Awaited<ReturnType<typeof makeApp>>;

/** An account as an OIDC sign-in would leave it: a user row plus its identity at the configured issuer. */
export function addUser(ctx: Ctx, username: string, isAdmin = false, sub = `${username}-sub`): number {
  const now = Date.now();
  const id = Number(ctx.db.run("INSERT INTO users(username,pw_hash,is_admin,created_at) VALUES(?,'',?,?)", username, isAdmin ? 1 : 0, now).lastInsertRowid);
  ctx.db.run("INSERT INTO identities(issuer,sub,user_id,linked_at) VALUES(?,?,?,?)", ctx.config.oidc.issuer, sub, id, now);
  return id;
}
const userId = (ctx: Ctx, username: string) => {
  const u = ctx.db.get("SELECT id FROM users WHERE username=?", username);
  if (!u) throw new Error(`no test user ${username}`);
  return u.id as number;
};

export class Browser {
  cookie = ""; csrf = ""; deviceId = ""; ctx: Ctx; ip: string;
  constructor(ctx: Ctx, ip = "203.0.113.1") { this.ctx = ctx; this.ip = ip; }
  async req(method: any, url: string, body?: any, headers: any = {}) {
    const r = await this.ctx.app.inject({ method, url: this.ctx.config.basePath + url, payload: body, remoteAddress: this.ip,
      headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...(this.csrf && method !== "GET" ? { "x-csrf-token": this.csrf } : {}), ...headers } });
    const c = r.headers["set-cookie"];
    if (c) this.cookie = String(c).split(";")[0];
    let json: any = null;
    try { json = r.json(); } catch {}
    if (json?.csrf) { this.csrf = json.csrf; this.deviceId = json.deviceId; }
    return { status: r.statusCode, json, headers: r.headers, body: r.body };
  }
  /** A browser session for an existing account, as the OIDC callback would start it (the flow itself is tested in oidc.test.ts). */
  async login(username = "patch") {
    const s = this.ctx.auth.createSession(userId(this.ctx, username), "Test browser");
    this.cookie = `patchcast_session=${s.id}`;
    return this.req("GET", "/api/v1/me");
  }
}
export class Device {
  token = ""; id = ""; ctx: Ctx;
  constructor(ctx: Ctx) { this.ctx = ctx; }
  async req(method: any, url: string, body?: any) {
    const r = await this.ctx.app.inject({ method, url: this.ctx.config.basePath + url, payload: body, headers: { authorization: `Bearer ${this.token}` } });
    return { status: r.statusCode, json: r.json() as any };
  }
  /** A device token for an existing account, as /auth/oidc/exchange would issue it. */
  async login(name: string, username = "patch") {
    const d = this.ctx.auth.createDevice(userId(this.ctx, username), name);
    this.token = d.token; this.id = d.deviceId;
    return this;
  }
  push(body: any) { return this.req("POST", "/api/v1/sync", body); }
  pull(since = 0) { return this.req("GET", `/api/v1/sync?since=${since}`); }
}
export async function withAdmin(env = {}, extra = {}) {
  const ctx = await makeApp(env, extra);
  addUser(ctx, "patch", true);
  return ctx;
}
export async function serve(handler: http.RequestListener) {
  const s = http.createServer(handler);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  return { port, url: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, close: () => { s.closeAllConnections(); return new Promise((r) => s.close(r)); } };
}
export function rss(items: { guid: string; title?: string; url?: string; extra?: string; date?: string }[], title = "Test Cast") {
  return `<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:psc="http://podlove.org/simple-chapters"><channel><title>${title}</title>` +
    items.map((i) => `<item><title>${i.title ?? i.guid}</title><guid>${i.guid}</guid><pubDate>${i.date ?? new Date().toUTCString()}</pubDate><enclosure url="${i.url ?? `https://cdn.example.com/${i.guid}.mp3`}" type="audio/mpeg" length="5"/>${i.extra ?? ""}</item>`).join("") + "</channel></rss>";
}
