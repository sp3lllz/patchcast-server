import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export interface OidcConfig {
  /** Without trailing slash. */
  issuer: string;
  clientId: string;
  clientSecret: string | null;
  scopes: string;
  providerName: string;
  autoCreate: boolean;
  allowedGroups: string[];
  adminGroups: string[];
  passwordLogin: boolean;
}

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  /** "" or "/prefix" (no trailing slash). */
  basePath: string;
  publicUrl: string | null;
  trustProxy: boolean | number | string;
  /** null = default behaviour (only while there are no users). */
  allowRegistration: boolean;
  sessionSecret: string;
  feedRefreshMinutes: number;
  logLevel: string;
  adminUser: string | null;
  adminPassword: string | null;
  /** host or host:port entries exempt from the private-address block (LAN feeds; empty by default). */
  ssrfAllowHosts: Set<string>;
  /** null = OIDC is off. */
  oidc: OidcConfig | null;
  version: string;
}

const bool = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v ?? "");

export function normalizeBasePath(raw: string | undefined): string {
  const p = "/" + (raw ?? "").trim().split("/").filter(Boolean).join("/");
  if (!/^[\w\-./~]*$/.test(p) || p.includes("..")) throw new Error(`BASE_PATH "${raw}" contains unsupported characters`);
  return p === "/" ? "" : p;
}

export function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const v = (raw ?? "").trim();
  if (v === "" || /^(false|no|off|0)$/i.test(v)) return false;
  if (/^(true|yes|on)$/i.test(v)) return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v; // comma-separated IPs/CIDRs or the names loopback, linklocal, uniquelocal
}

const csv = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

function oidcConfig(env: NodeJS.ProcessEnv, publicUrl: string | null): OidcConfig | null {
  const issuer = (env.OIDC_ISSUER ?? "").trim().replace(/\/+$/, ""), clientId = (env.OIDC_CLIENT_ID ?? "").trim();
  if (!issuer || !clientId) return null;
  let u: URL;
  try { u = new URL(issuer); } catch { throw new Error("OIDC_ISSUER must be a URL"); }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error("OIDC_ISSUER must be a plain http(s) URL");
  // The redirect URI is fixed, and never derived from a request's Host header.
  if (!publicUrl) throw new Error("OIDC needs PUBLIC_URL (the redirect URI is PUBLIC_URL + BASE_PATH + /auth/oidc/callback)");
  let clientSecret = (env.OIDC_CLIENT_SECRET ?? "").trim() || null;
  if (env.OIDC_CLIENT_SECRET_FILE) {
    if (clientSecret) throw new Error("Set either OIDC_CLIENT_SECRET or OIDC_CLIENT_SECRET_FILE, not both");
    clientSecret = readFileSync(env.OIDC_CLIENT_SECRET_FILE, "utf8").trim();
    if (!clientSecret) throw new Error("OIDC_CLIENT_SECRET_FILE is empty");
  }
  const scopes = (env.OIDC_SCOPES || "openid profile email groups").trim().split(/[\s,]+/);
  if (!scopes.includes("openid")) scopes.unshift("openid");
  const flag = (name: string) => {
    const v = (env[name] ?? "").trim();
    if (v && !/^(1|true|yes|on|0|false|no|off)$/i.test(v)) throw new Error(`${name} must be true or false`);
    return v ? bool(v) : true;
  };
  return {
    issuer, clientId, clientSecret, scopes: scopes.join(" "), providerName: (env.OIDC_PROVIDER_NAME || "Pocket ID").trim().slice(0, 40),
    autoCreate: flag("OIDC_AUTO_CREATE"), allowedGroups: csv(env.OIDC_ALLOWED_GROUPS), adminGroups: csv(env.OIDC_ADMIN_GROUPS), passwordLogin: flag("OIDC_PASSWORD_LOGIN"),
  };
}

function secret(dataDir: string, env: string | undefined): string {
  if (env) {
    if (env.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
    return env;
  }
  const file = join(dataDir, "session-secret");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const s = randomBytes(48).toString("base64url");
  writeFileSync(file, s, { mode: 0o600 });
  chmodSync(file, 0o600);
  return s;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = env.DATA_DIR || "./data";
  mkdirSync(dataDir, { recursive: true });
  const int = (name: string, def: number, min: number, max: number) => {
    const raw = env[name];
    if (!raw) return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
    return n;
  };
  let publicUrl: string | null = null;
  if (env.PUBLIC_URL) {
    const u = new URL(env.PUBLIC_URL);
    if (!/^https?:$/.test(u.protocol)) throw new Error("PUBLIC_URL must be http(s)");
    publicUrl = u.origin;
  }
  return {
    port: int("PORT", 8080, 1, 65535),
    host: env.HOST || "0.0.0.0",
    dataDir,
    basePath: normalizeBasePath(env.BASE_PATH),
    publicUrl,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    allowRegistration: bool(env.ALLOW_REGISTRATION),
    sessionSecret: secret(dataDir, env.SESSION_SECRET),
    feedRefreshMinutes: int("FEED_REFRESH_MINUTES", 60, 5, 1440),
    logLevel: env.LOG_LEVEL || "info",
    adminUser: env.ADMIN_USER || null,
    adminPassword: env.ADMIN_PASSWORD || null,
    ssrfAllowHosts: new Set((env.SSRF_ALLOW_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)),
    oidc: oidcConfig(env, publicUrl),
    version: "0.7.0",
  };
}
