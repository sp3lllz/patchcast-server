import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import { buildApp } from "../src/app.ts";

export async function makeApp(env: Record<string, string> = {}, extra: any = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pcs-"));
  const config = loadConfig({ DATA_DIR: dir, LOG_LEVEL: "silent", ...env });
  const ctx = await buildApp({ config, ...extra });
  await ctx.app.ready();
  return { ...ctx, config, dir, async stop() { await ctx.app.close(); rmSync(dir, { recursive: true, force: true }); } };
}
export type Ctx = Awaited<ReturnType<typeof makeApp>>;
export const PW = "correct horse battery";

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
  login(username = "patch", password = PW) { return this.req("POST", "/api/v1/auth/login", { username, password }); }
}
export class Device {
  token = ""; id = ""; ctx: Ctx;
  constructor(ctx: Ctx) { this.ctx = ctx; }
  async req(method: any, url: string, body?: any) {
    const r = await this.ctx.app.inject({ method, url: this.ctx.config.basePath + url, payload: body, headers: { authorization: `Bearer ${this.token}` } });
    return { status: r.statusCode, json: r.json() as any };
  }
  async login(name: string, username = "patch") {
    const r = await this.ctx.app.inject({ method: "POST", url: this.ctx.config.basePath + "/api/v1/auth/device", payload: { username, password: PW, deviceName: name }, remoteAddress: "203.0.113.9" });
    this.token = r.json().token; this.id = r.json().deviceId;
    return this;
  }
  push(body: any) { return this.req("POST", "/api/v1/sync", body); }
  pull(since = 0) { return this.req("GET", `/api/v1/sync?since=${since}`); }
}
export async function withAdmin(env = {}, extra = {}) {
  const ctx = await makeApp(env, extra);
  await ctx.auth.createUser("patch", PW, true);
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
