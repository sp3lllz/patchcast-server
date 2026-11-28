import * as crypto from "node:crypto";
import { AuthError } from "./auth.ts";
import { Expiring } from "./oidc.ts";

/**
 * Device pairing for clients that can't open a sign-in browser or are painful to type on (Apple TV, set-top boxes),
 * in the style of the OAuth device authorization grant (RFC 8628):
 *   1. the device asks for a pairing: it gets a secret `pairCode` and a short `userCode` to show (plus a URL / QR code);
 *   2. the person opens the URL on a phone or computer, signs in, checks the device name and approves;
 *   3. the device polls with its `pairCode` and receives a normal device token, once.
 * Pending pairings live in memory only: a server restart simply makes the device start again.
 */
export const PAIR_MS = 10 * 60_000, PAIR_INTERVAL_S = 5;
/** 20 consonants: no vowels (no words), no 0/O, 1/I/L look-alikes. 20^8 ≈ 2.6e10 codes. */
export const ALPHABET = "BCDFGHJKMNPQRSTVWXZ2";
const CODE_LEN = 8;

export interface Pending {
  hash: string; userCode: string; deviceName: string; expires: number; created: number;
  lastPoll: number; approvedBy: number | null; denied: boolean;
}

export const formatUserCode = (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`;
/** What a person may type: any case, spaces or dashes. Anything that can't be a code becomes "". */
export function normalizeUserCode(v: unknown): string {
  if (typeof v !== "string" || v.length > 40) return "";
  const c = v.toUpperCase().replace(/[\s-]/g, "");
  return c.length === CODE_LEN && [...c].every((x) => ALPHABET.includes(x)) ? c : "";
}

export class Pairings {
  private byHash: Expiring<Pending>;
  private byCode: Expiring<Pending>;
  private now: () => number;
  private hash: (s: string) => string;

  constructor(hash: (s: string) => string, now: () => number = Date.now) {
    this.hash = hash; this.now = now;
    this.byHash = new Expiring<Pending>(2000, now);
    this.byCode = new Expiring<Pending>(2000, now);
  }

  start(deviceName: string): { pairCode: string; userCode: string; expiresIn: number; interval: number } {
    const pairCode = crypto.randomBytes(32).toString("base64url");
    let userCode = "";
    do userCode = Array.from(crypto.randomBytes(CODE_LEN), (b) => ALPHABET[b % ALPHABET.length]).join(""); // 256 % 20 bias is negligible here
    while (this.byCode.peek(userCode));
    const t = this.now();
    const p: Pending = { hash: this.hash(pairCode), userCode, deviceName, expires: t + PAIR_MS, created: t, lastPoll: 0, approvedBy: null, denied: false };
    this.byHash.set(p.hash, p);
    this.byCode.set(userCode, p);
    return { pairCode, userCode: formatUserCode(userCode), expiresIn: PAIR_MS / 1000, interval: PAIR_INTERVAL_S };
  }

  /** The pending pairing behind a code a person typed, or null (unknown, expired, already decided). */
  lookup(userCode: unknown): Pending | null {
    const c = normalizeUserCode(userCode);
    const p = c ? this.byCode.peek(c) : null;
    return p && p.approvedBy === null && !p.denied ? p : null;
  }

  decide(p: Pending, userId: number | null) {
    if (userId === null) p.denied = true; else p.approvedBy = userId;
    this.byCode.delete(p.userCode); // a code is used for one decision only
  }

  /** The device's poll. Returns the approving user once (the caller creates the device token), then forgets the pairing. */
  poll(pairCode: unknown): { status: "pending" } | { status: "approved"; userId: number; deviceName: string } {
    if (typeof pairCode !== "string" || !/^[\w-]{43}$/.test(pairCode)) throw new AuthError(400, "bad_request", "pairCode is required");
    const key = this.hash(pairCode), p = this.byHash.peek(key);
    if (!p) throw new AuthError(400, "expired", "This pairing code has expired. Start again for a new code.");
    const t = this.now();
    if (p.denied) { this.byHash.delete(key); throw new AuthError(403, "denied", "The pairing was declined."); }
    if (p.approvedBy !== null) { this.byHash.delete(key); return { status: "approved", userId: p.approvedBy, deviceName: p.deviceName }; }
    if (p.lastPoll && t - p.lastPoll < (PAIR_INTERVAL_S - 1) * 1000) {
      p.lastPoll = t;
      throw Object.assign(new AuthError(429, "slow_down", `Poll at most every ${PAIR_INTERVAL_S} seconds.`), { wait: PAIR_INTERVAL_S });
    }
    p.lastPoll = t;
    return { status: "pending" };
  }
}
