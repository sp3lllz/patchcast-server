import * as crypto from "node:crypto";
import type { Db, Row } from "./db.ts";
import { Semaphore } from "./net.ts";

// argon2id with the OWASP baseline (19 MiB, t=2, p=1), from OpenSSL via node:crypto.
const ARGON = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 };
const hashing = new Semaphore(3); // bounds memory/CPU an attacker can tie up

function derive(password: string, nonce: Buffer, p = ARGON): Promise<Buffer> {
  return hashing.run(() => new Promise((resolve, reject) => {
    (crypto as any).argon2("argon2id", { message: Buffer.from(password.normalize("NFKC")), nonce, ...p },
      (e: Error | null, out: Buffer) => (e ? reject(e) : resolve(out)));
  }));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const out = await derive(password, salt);
  return `$argon2id$m=${ARGON.memory},t=${ARGON.passes},p=${ARGON.parallelism}$${salt.toString("base64url")}$${out.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const m = /^\$argon2id\$m=(\d+),t=(\d+),p=(\d+)\$([\w-]+)\$([\w-]+)$/.exec(stored);
  if (!m) return false;
  const want = Buffer.from(m[5], "base64url");
  const got = await derive(password, Buffer.from(m[4], "base64url"),
    { memory: +m[1], passes: +m[2], parallelism: +m[3], tagLength: want.length });
  return crypto.timingSafeEqual(want, got);
}

export const SESSION_MS = 30 * 86_400_000;

export interface Principal {
  userId: number; username: string; isAdmin: boolean; deviceId: string; deviceName: string;
  via: "cookie" | "token"; csrf?: string; sessionHash?: string;
}

export function validateUsername(u: unknown): string | null {
  if (typeof u !== "string") return null;
  const v = u.trim();
  return /^[A-Za-z0-9][\w.@-]{1,39}$/.test(v) ? v : null;
}
export function passwordProblem(p: unknown): string | null {
  if (typeof p !== "string" || p.length < 10) return "Password must be at least 10 characters";
  if (p.length > 256) return "Password is too long";
  return null;
}

export class Auth {
  private db: Db;
  private secret: string;
  private dummy: Promise<string>;
  setupToken: string | null = null;

  constructor(db: Db, secret: string) {
    this.db = db; this.secret = secret;
    this.dummy = hashPassword(crypto.randomBytes(12).toString("hex"));
  }

  /** Tokens are high-entropy random values; a keyed hash is stored so a leaked DB alone can't be replayed. */
  hashToken(t: string) { return crypto.createHmac("sha256", this.secret).update("token:" + t).digest("base64url"); }
  sign(data: string) { return crypto.createHmac("sha256", this.secret).update("sig:" + data).digest("base64url").slice(0, 27); }
  verifySig(data: string, sig: string) { return safeEqual(this.sign(data), sig); }

  userCount() { return (this.db.get("SELECT COUNT(*) n FROM users") as Row).n as number; }

  ensureSetupToken(): string | null {
    if (this.userCount() > 0) { this.setupToken = null; return null; }
    this.setupToken ??= crypto.randomBytes(18).toString("base64url");
    return this.setupToken;
  }

  async createUser(username: string, password: string, isAdmin: boolean, onlyIfFirst = false): Promise<number> {
    const hash = await hashPassword(password);
    return this.db.tx(() => {
      if (onlyIfFirst && this.userCount() > 0) throw new AuthError(409, "setup_done", "Setup has already been completed");
      if (this.db.get("SELECT 1 FROM users WHERE username=?", username)) throw new AuthError(409, "user_exists", "That username is taken");
      return Number(this.db.run("INSERT INTO users(username,pw_hash,is_admin,created_at) VALUES(?,?,?,?)",
        username, hash, isAdmin ? 1 : 0, Date.now()).lastInsertRowid);
    });
  }

  async checkLogin(username: string, password: string): Promise<Row | null> {
    const u = this.db.get("SELECT * FROM users WHERE username=?", username);
    const ok = await verifyPassword(password, u?.pw_hash || await this.dummy); // same work either way
    return u?.pw_hash && ok ? u : null;
  }

  async setPassword(userId: number, password: string, keepSession?: string) {
    const hash = await hashPassword(password);
    this.db.tx(() => {
      this.db.run("UPDATE users SET pw_hash=? WHERE id=?", hash, userId);
      this.db.run("DELETE FROM devices WHERE user_id=? AND kind='web' AND id NOT IN (SELECT device_id FROM sessions WHERE id_hash=?)", userId, keepSession ?? "");
    });
  }

  /** Encrypts small secrets that must be readable again (the ID token kept as a logout hint). */
  seal(s: string): string {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", this.sealKey(), iv);
    return Buffer.concat([iv, c.update(s, "utf8"), c.final(), c.getAuthTag()]).toString("base64url");
  }
  unseal(s: string): string | null {
    try {
      const b = Buffer.from(s, "base64url"), d = crypto.createDecipheriv("aes-256-gcm", this.sealKey(), b.subarray(0, 12));
      d.setAuthTag(b.subarray(-16));
      return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString("utf8");
    } catch { return null; }
  }
  private sealKey() { return crypto.createHmac("sha256", this.secret).update("seal").digest(); }

  createSession(userId: number, name: string, via: "password" | "oidc" = "password", idToken: string | null = null): { id: string; csrf: string; deviceId: string } {
    const id = crypto.randomBytes(32).toString("base64url");
    const csrf = crypto.randomBytes(24).toString("base64url");
    const deviceId = crypto.randomUUID();
    const now = Date.now();
    this.db.tx(() => {
      this.db.run("DELETE FROM devices WHERE kind='web' AND id IN (SELECT device_id FROM sessions WHERE expires_at<?)", now);
      this.db.run("INSERT INTO devices(id,user_id,name,kind,created_at,last_seen) VALUES(?,?,?,'web',?,?)", deviceId, userId, name, now, now);
      this.db.run("INSERT INTO sessions(id_hash,user_id,device_id,csrf,created_at,expires_at,via,id_token) VALUES(?,?,?,?,?,?,?,?)",
        this.hashToken(id), userId, deviceId, csrf, now, now + SESSION_MS, via, idToken ? this.seal(idToken) : null);
    });
    return { id, csrf, deviceId };
  }

  user(id: number): Row | null { return this.db.get("SELECT * FROM users WHERE id=?", id) ?? null; }
  sessionAlive(idHash: string, userId: number): boolean {
    return !!this.db.get("SELECT 1 FROM sessions WHERE id_hash=? AND user_id=? AND expires_at>?", idHash, userId, Date.now());
  }

  createDevice(userId: number, name: string): { token: string; deviceId: string } {
    const token = "pct_" + crypto.randomBytes(32).toString("base64url");
    const deviceId = crypto.randomUUID();
    const now = Date.now();
    this.db.run("INSERT INTO devices(id,user_id,name,kind,token_hash,created_at,last_seen) VALUES(?,?,?,'app',?,?,?)",
      deviceId, userId, name, this.hashToken(token), now, now);
    return { token, deviceId };
  }

  private touch(deviceId: string, lastSeen: number) {
    const now = Date.now();
    if (now - lastSeen > 30_000) this.db.run("UPDATE devices SET last_seen=? WHERE id=?", now, deviceId);
  }

  bySession(id: string): Principal | null {
    const r = this.db.get(`SELECT s.*, u.username, u.is_admin, d.name dname, d.last_seen FROM sessions s JOIN users u ON u.id=s.user_id
      JOIN devices d ON d.id=s.device_id WHERE s.id_hash=?`, this.hashToken(id));
    if (!r) return null;
    const now = Date.now();
    if (r.expires_at < now) { this.db.run("DELETE FROM devices WHERE id=?", r.device_id); return null; }
    if (r.expires_at - now < SESSION_MS / 2) this.db.run("UPDATE sessions SET expires_at=? WHERE id_hash=?", now + SESSION_MS, r.id_hash);
    this.touch(r.device_id, r.last_seen);
    return { userId: r.user_id, username: r.username, isAdmin: !!r.is_admin, deviceId: r.device_id, deviceName: r.dname, via: "cookie", csrf: r.csrf, sessionHash: r.id_hash };
  }

  byToken(token: string): Principal | null {
    const r = this.db.get(`SELECT d.*, u.username, u.is_admin FROM devices d JOIN users u ON u.id=d.user_id WHERE d.token_hash=?`, this.hashToken(token));
    if (!r) return null;
    this.touch(r.id, r.last_seen);
    return { userId: r.user_id, username: r.username, isAdmin: !!r.is_admin, deviceId: r.id, deviceName: r.name, via: "token" };
  }
}

export class AuthError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Sliding-window failure limiter, in memory and bounded. */
export class LoginLimiter {
  private hits = new Map<string, number[]>();
  private windowMs: number;
  constructor(windowMs = 15 * 60_000) { this.windowMs = windowMs; }

  static ipKey(ip: string): string { // an IPv6 attacker owns at least a /64
    return ip.includes(":") && !ip.startsWith("::ffff:") ? ip.split(":").slice(0, 4).join(":") + "::/64" : ip.replace("::ffff:", "");
  }
  private keys(ip: string, user: string): [string, number][] {
    const i = LoginLimiter.ipKey(ip);
    return [[`iu:${i}|${user.toLowerCase().slice(0, 64)}`, 5], [`i:${i}`, 20], [`u:${user.toLowerCase().slice(0, 64)}`, 100]];
  }
  private recent(k: string, now: number) { return (this.hits.get(k) ?? []).filter((t) => now - t < this.windowMs); }

  /** Seconds to wait, or 0 if allowed. Counts the attempt up front so parallel guesses can't race the check. */
  take(ip: string, user: string, now = Date.now()): number { return this.takeKeys(this.keys(ip, user), now); }
  /** Per-address budget for one kind of request, independent of the password limits. */
  takeIp(kind: string, ip: string, max: number, now = Date.now()): number { return this.takeKeys([[`${kind}:${LoginLimiter.ipKey(ip)}`, max]], now); }
  successIp(kind: string, ip: string) { this.hits.get(`${kind}:${LoginLimiter.ipKey(ip)}`)?.pop(); }
  private takeKeys(ks: [string, number][], now: number): number {
    for (const [k, max] of ks) {
      const r = this.recent(k, now);
      if (r.length >= max) return Math.ceil((r[r.length - max] + this.windowMs - now) / 1000);
    }
    for (const [k] of ks) this.hits.set(k, [...this.recent(k, now), now]);
    if (this.hits.size > 20_000) {
      for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
      while (this.hits.size > 20_000) this.hits.delete(this.hits.keys().next().value!);
    }
    return 0;
  }
  success(ip: string, user: string) {
    for (const [k] of this.keys(ip, user)) {
      if (k.startsWith("iu:")) this.hits.delete(k);
      else this.hits.get(k)?.pop();
    }
  }
}
