import * as crypto from "node:crypto";
import type { Db, Row } from "./db.ts";

export const SESSION_MS = 30 * 86_400_000;

export interface Principal {
  userId: number; username: string; isAdmin: boolean; deviceId: string; deviceName: string;
  via: "cookie" | "token"; csrf?: string; sessionHash?: string;
}

/**
 * Sessions and device tokens. Accounts are created only by OIDC sign-in (accounts.ts); `users.pw_hash` and
 * `users.pw_recovery_until` are left over from 0.7 and are never read.
 */
export class Auth {
  private db: Db;
  private secret: string;
  /** Sessions and tokens only count for accounts with an identity at this issuer, so password-only accounts from 0.7 are shut out. */
  private issuer: string;

  constructor(db: Db, secret: string, issuer: string) {
    this.db = db; this.secret = secret; this.issuer = issuer;
  }

  /** Tokens are high-entropy random values; a keyed hash is stored so a leaked DB alone can't be replayed. */
  hashToken(t: string) { return crypto.createHmac("sha256", this.secret).update("token:" + t).digest("base64url"); }
  sign(data: string) { return crypto.createHmac("sha256", this.secret).update("sig:" + data).digest("base64url").slice(0, 27); }
  verifySig(data: string, sig: string) { return safeEqual(this.sign(data), sig); }

  userCount() { return (this.db.get("SELECT COUNT(*) n FROM users") as Row).n as number; }

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

  createSession(userId: number, name: string, idToken: string | null = null): { id: string; csrf: string; deviceId: string } {
    const id = crypto.randomBytes(32).toString("base64url");
    const csrf = crypto.randomBytes(24).toString("base64url");
    const deviceId = crypto.randomUUID();
    const now = Date.now();
    this.db.tx(() => {
      this.db.run("DELETE FROM devices WHERE kind='web' AND id IN (SELECT device_id FROM sessions WHERE expires_at<?)", now);
      this.db.run("INSERT INTO devices(id,user_id,name,kind,created_at,last_seen) VALUES(?,?,?,'web',?,?)", deviceId, userId, name, now, now);
      this.db.run("INSERT INTO sessions(id_hash,user_id,device_id,csrf,created_at,expires_at,via,id_token) VALUES(?,?,?,?,?,?,?,?)",
        this.hashToken(id), userId, deviceId, csrf, now, now + SESSION_MS, "oidc", idToken ? this.seal(idToken) : null);
    });
    return { id, csrf, deviceId };
  }

  user(id: number): Row | null { return this.db.get("SELECT id,username,is_admin FROM users WHERE id=?", id) ?? null; }
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
      JOIN devices d ON d.id=s.device_id JOIN identities i ON i.user_id=s.user_id AND i.issuer=? WHERE s.id_hash=?`, this.issuer, this.hashToken(id));
    if (!r) return null;
    const now = Date.now();
    if (r.expires_at < now) { this.db.run("DELETE FROM devices WHERE id=?", r.device_id); return null; }
    if (r.expires_at - now < SESSION_MS / 2) this.db.run("UPDATE sessions SET expires_at=? WHERE id_hash=?", now + SESSION_MS, r.id_hash);
    this.touch(r.device_id, r.last_seen);
    return { userId: r.user_id, username: r.username, isAdmin: !!r.is_admin, deviceId: r.device_id, deviceName: r.dname, via: "cookie", csrf: r.csrf, sessionHash: r.id_hash };
  }

  byToken(token: string): Principal | null {
    const r = this.db.get(`SELECT d.*, u.username, u.is_admin FROM devices d JOIN users u ON u.id=d.user_id
      JOIN identities i ON i.user_id=d.user_id AND i.issuer=? WHERE d.token_hash=?`, this.issuer, this.hashToken(token));
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

/** Sliding-window per-address limiter for the sign-in endpoints, in memory and bounded. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  private windowMs: number;
  constructor(windowMs = 15 * 60_000) { this.windowMs = windowMs; }

  static ipKey(ip: string): string { // an IPv6 attacker owns at least a /64
    return ip.includes(":") && !ip.startsWith("::ffff:") ? ip.split(":").slice(0, 4).join(":") + "::/64" : ip.replace("::ffff:", "");
  }
  private recent(k: string, now: number) { return (this.hits.get(k) ?? []).filter((t) => now - t < this.windowMs); }

  /** Seconds to wait, or 0 if allowed. Counts the attempt up front so parallel requests can't race the check. */
  takeIp(kind: string, ip: string, max: number, now = Date.now()): number {
    const k = `${kind}:${RateLimiter.ipKey(ip)}`, r = this.recent(k, now);
    if (r.length >= max) return Math.ceil((r[r.length - max] + this.windowMs - now) / 1000);
    this.hits.set(k, [...r, now]);
    if (this.hits.size > 20_000) {
      for (const [x, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(x);
      while (this.hits.size > 20_000) this.hits.delete(this.hits.keys().next().value!);
    }
    return 0;
  }
  /** A successful attempt doesn't count against the address. */
  successIp(kind: string, ip: string) { this.hits.get(`${kind}:${RateLimiter.ipKey(ip)}`)?.pop(); }
}
