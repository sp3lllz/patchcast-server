import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import zlib from "node:zlib";
import type { Readable } from "node:stream";
import ipaddr from "ipaddr.js";

export const USER_AGENT = "PatchcastServer/0.7 (podcast sync server)";

export class FetchError extends Error {
  code: string;
  status?: number;
  constructor(code: string, message: string, status?: number) { super(message); this.code = code; this.status = status; }
}

/** True only for globally routable unicast addresses. */
export function isPublicAddress(ip: string): boolean {
  let a: ipaddr.IPv4 | ipaddr.IPv6;
  try { a = ipaddr.parse(ip.split("%")[0]); } catch { return false; }
  if (a.kind() === "ipv6") {
    const v6 = a as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) return isPublicAddress(v6.toIPv4Address().toString());
    // NAT64 (64:ff9b::/96) and 6to4 embed an IPv4 address that must be public too.
    const b = v6.toByteArray();
    if (v6.range() === "rfc6052") return isPublicAddress(b.slice(12).join("."));
    if (v6.range() === "6to4") return isPublicAddress(b.slice(2, 6).join("."));
    if (b[0] === 0 && b[1] === 0) return false; // ::/16 (unspecified, loopback, IPv4-compatible, …)
  }
  if (a.toString() === "168.63.129.16") return false; // Azure platform/metadata endpoint on a public-looking address
  return a.range() === "unicast";
}

export interface SafeFetchOptions {
  method?: "GET" | "HEAD" | "POST";
  /** Only sent to the first hop: use maxRedirects 0 with it. */
  body?: string;
  headers?: Record<string, string>;
  /** Whole-request limit (connect + redirects + body for buffered fetches). */
  timeoutMs?: number;
  maxRedirects?: number;
  allowHosts?: Set<string>;
  signal?: AbortSignal;
}

export interface SafeResponse { status: number; headers: http.IncomingHttpHeaders; url: string; body: http.IncomingMessage }

/** DNS lookup that refuses any non-public answer. Runs at connect time, so DNS rebinding can't slip past it. */
const guardedLookup: net.LookupFunction = (hostname, options, cb) => {
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, list) => {
    if (err) return (cb as any)(err);
    const addrs = list as dns.LookupAddress[];
    const bad = addrs.find((a) => !isPublicAddress(a.address));
    if (bad || !addrs.length) return (cb as any)(new FetchError("ssrf_blocked", `Blocked: ${hostname} resolves to a non-public address`));
    if ((options as any).all) (cb as any)(null, addrs);
    else (cb as any)(null, addrs[0].address, addrs[0].family);
  });
};

export function checkUrl(raw: string, allowHosts?: Set<string>): { url: URL; trusted: boolean } {
  let url: URL;
  try { url = new URL(raw); } catch { throw new FetchError("bad_url", "Invalid URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new FetchError("ssrf_blocked", `Blocked: ${url.protocol} is not http(s)`);
  if (url.username || url.password) throw new FetchError("ssrf_blocked", "Blocked: URLs with credentials are not fetched");
  const trusted = !!allowHosts && (allowHosts.has(url.host.toLowerCase()) || allowHosts.has(url.hostname.toLowerCase()));
  if (!trusted) {
    const h = url.hostname.replace(/^\[|\]$/g, "");
    // IP literals skip DNS (and so the guarded lookup); WHATWG URL already normalised 0x7f.1, 2130706433, etc.
    if (net.isIP(h) && !isPublicAddress(h)) throw new FetchError("ssrf_blocked", "Blocked: non-public address");
    if (/(^|\.)(localhost|local|internal|home\.arpa)\.?$/i.test(h)) throw new FetchError("ssrf_blocked", `Blocked: ${h}`);
  }
  return { url, trusted };
}

/** Opens a request, following redirects with every hop re-checked. The caller must consume or destroy `body`. */
export async function safeOpen(raw: string, o: SafeFetchOptions = {}): Promise<SafeResponse> {
  let current = raw;
  const deadline = Date.now() + (o.timeoutMs ?? 30_000);
  for (let hop = 0; hop <= (o.maxRedirects ?? 8); hop++) {
    const { url, trusted } = checkUrl(current, o.allowHosts);
    const res = await once(url, trusted, o, deadline);
    const status = res.statusCode ?? 0;
    if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
      res.destroy();
      let next: URL;
      try { next = new URL(res.headers.location, url); } catch { throw new FetchError("bad_url", "Invalid redirect"); }
      current = next.toString();
      continue;
    }
    return { status, headers: res.headers, url: url.toString(), body: res };
  }
  throw new FetchError("too_many_redirects", "Too many redirects");
}

function once(url: URL, trusted: boolean, o: SafeFetchOptions, deadline: number): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new FetchError("timeout", "Timed out"));
    const req = (url.protocol === "https:" ? https : http).request(url, {
      method: o.method ?? "GET",
      headers: { "user-agent": USER_AGENT, accept: "*/*", ...(o.body !== undefined ? { "content-length": String(Buffer.byteLength(o.body)) } : {}), ...o.headers },
      lookup: trusted ? undefined : guardedLookup,
      agent: false, // a fresh socket per request: no pooled connection can skip the lookup check
      signal: o.signal,
    });
    const timer = setTimeout(() => req.destroy(new FetchError("timeout", "Timed out")), remaining);
    req.on("response", (res) => { clearTimeout(timer); resolve(res); });
    req.on("error", (e: any) => {
      clearTimeout(timer);
      reject(e instanceof FetchError ? e : new FetchError(e.code ?? "network", describe(e, url)));
    });
    req.end(o.body);
  });
}

function describe(e: any, url: URL): string {
  switch (e.code) {
    case "ENOTFOUND": case "EAI_AGAIN": return `Server not found (${url.hostname})`;
    case "ECONNREFUSED": return `Could not connect to ${url.host}`;
    case "ECONNRESET": return `Connection reset by ${url.host}`;
    default: return e.code ? `${e.code} (${url.hostname})` : `Request failed (${url.hostname})`;
  }
}

export interface Buffered { status: number; headers: http.IncomingHttpHeaders; url: string; bytes: Buffer }

/** Buffered fetch with size and time limits (decompressed size is limited too). */
export async function safeFetch(raw: string, o: SafeFetchOptions & { maxBytes: number; prefixOnly?: boolean }): Promise<Buffered> {
  const timeoutMs = o.timeoutMs ?? 30_000;
  const started = Date.now();
  const res = await safeOpen(raw, { ...o, timeoutMs, headers: { "accept-encoding": "gzip, br, deflate", ...o.headers } });
  const left = Math.max(1, timeoutMs - (Date.now() - started));
  const enc = (res.headers["content-encoding"] ?? "").toLowerCase();
  let stream: Readable = res.body;
  if (enc === "gzip" || enc === "x-gzip" || enc === "deflate") stream = res.body.pipe(zlib.createUnzip());
  else if (enc === "br") stream = res.body.pipe(zlib.createBrotliDecompress());
  return await new Promise<Buffered>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res.body.destroy();
      if (stream !== res.body) stream.destroy();
      if (err) reject(err);
      else resolve({ status: res.status, headers: res.headers, url: res.url, bytes: Buffer.concat(chunks) });
    };
    const timer = setTimeout(() => finish(new FetchError("timeout", "Timed out")), left);
    stream.on("data", (c: Buffer) => {
      if (settled) return;
      if (size + c.length > o.maxBytes) {
        if (o.prefixOnly) { chunks.push(c.subarray(0, o.maxBytes - size)); size = o.maxBytes; return finish(); }
        return finish(new FetchError("too_large", "Response too large"));
      }
      chunks.push(c); size += c.length;
    });
    stream.on("end", () => finish());
    res.body.on("aborted", () => finish(new FetchError("network", "Connection closed early")));
    const fail = (e: any) => finish(e instanceof FetchError ? e : new FetchError("network", `Read failed: ${e.code ?? e.message}`));
    res.body.on("error", fail);
    if (stream !== res.body) stream.on("error", fail);
  });
}

export class Semaphore {
  private waiting: (() => void)[] = [];
  private free: number;
  constructor(n: number) { this.free = n; }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((r) => this.waiting.push(r));
    try { return await fn(); } finally {
      const next = this.waiting.shift();
      if (next) next(); else this.free++;
    }
  }
}
