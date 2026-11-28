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
}

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  /** "" or "/prefix" (no trailing slash). */
  basePath: string;
  publicUrl: string | null;
  trustProxy: boolean | number | string;
  sessionSecret: string;
  feedRefreshMinutes: number;
  logLevel: string;
  /** host or host:port entries exempt from the private-address block (LAN feeds; empty by default). */
  ssrfAllowHosts: Set<string>;
  /** Signing in is only possible through this provider (0.8: there are no passwords). */
  oidc: OidcConfig;
  /** Variables from 0.7 that are set but no longer do anything (reported at start). */
  ignored: string[];
  version: string;
}

export const VERSION = "0.11.0";
/** Password-era settings that 0.8 ignores. */
export const REMOVED_ENV = ["ADMIN_USER", "ADMIN_PASSWORD", "ALLOW_REGISTRATION", "OIDC_PASSWORD_LOGIN"];

/** A configuration the server can't start with. The message is meant for the operator, verbatim. */
export class ConfigError extends Error {}

const bool = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v ?? "");

export function normalizeBasePath(raw: string | undefined): string {
  const p = "/" + (raw ?? "").trim().split("/").filter(Boolean).join("/");
  if (!/^[\w\-./~]*$/.test(p) || p.includes("..")) throw new ConfigError(`BASE_PATH "${raw}" contains unsupported characters`);
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

function oidcConfig(env: NodeJS.ProcessEnv, publicUrl: string | null): OidcConfig {
  const issuer = (env.OIDC_ISSUER ?? "").trim().replace(/\/+$/, ""), clientId = (env.OIDC_CLIENT_ID ?? "").trim();
  const missing = [!issuer && "OIDC_ISSUER", !clientId && "OIDC_CLIENT_ID", !publicUrl && "PUBLIC_URL"].filter(Boolean);
  if (missing.length)
    throw new ConfigError(`${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} not set. Patchcast Sync signs in only with an OpenID Connect provider such as Pocket ID ` +
      "(there are no passwords since 0.8): set OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET (unless the client is public) and PUBLIC_URL. See \"Pocket ID setup\" in README.md.");
  let u: URL;
  try { u = new URL(issuer); } catch { throw new ConfigError("OIDC_ISSUER must be a URL"); }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash) throw new ConfigError("OIDC_ISSUER must be a plain http(s) URL");
  let clientSecret = (env.OIDC_CLIENT_SECRET ?? "").trim() || null;
  if (env.OIDC_CLIENT_SECRET_FILE) {
    if (clientSecret) throw new ConfigError("Set either OIDC_CLIENT_SECRET or OIDC_CLIENT_SECRET_FILE, not both");
    try { clientSecret = readFileSync(env.OIDC_CLIENT_SECRET_FILE, "utf8").trim(); } catch (e: any) { throw new ConfigError(`OIDC_CLIENT_SECRET_FILE can't be read (${e?.code ?? "error"})`); }
    if (!clientSecret) throw new ConfigError("OIDC_CLIENT_SECRET_FILE is empty");
  }
  const scopes = (env.OIDC_SCOPES || "openid profile email groups").trim().split(/[\s,]+/);
  if (!scopes.includes("openid")) scopes.unshift("openid");
  const flag = (name: string) => {
    const v = (env[name] ?? "").trim();
    if (v && !/^(1|true|yes|on|0|false|no|off)$/i.test(v)) throw new ConfigError(`${name} must be true or false`);
    return v ? bool(v) : true;
  };
  return {
    issuer, clientId, clientSecret, scopes: scopes.join(" "), providerName: (env.OIDC_PROVIDER_NAME || "Pocket ID").trim().slice(0, 40),
    autoCreate: flag("OIDC_AUTO_CREATE"), allowedGroups: csv(env.OIDC_ALLOWED_GROUPS), adminGroups: csv(env.OIDC_ADMIN_GROUPS),
  };
}

function secret(dataDir: string, env: string | undefined): string {
  if (env) {
    if (env.length < 32) throw new ConfigError("SESSION_SECRET must be at least 32 characters");
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
  const int = (name: string, def: number, min: number, max: number) => {
    const raw = env[name];
    if (!raw) return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${name} must be an integer from ${min} to ${max}`);
    return n;
  };
  let publicUrl: string | null = null;
  if (env.PUBLIC_URL) {
    let u: URL;
    try { u = new URL(env.PUBLIC_URL); } catch { throw new ConfigError("PUBLIC_URL must be a URL such as https://pods.example.com"); }
    if (!/^https?:$/.test(u.protocol)) throw new ConfigError("PUBLIC_URL must be http(s)");
    publicUrl = u.origin;
  }
  const oidc = oidcConfig(env, publicUrl); // checked before anything is written to DATA_DIR
  mkdirSync(dataDir, { recursive: true });
  return {
    port: int("PORT", 8080, 1, 65535),
    host: env.HOST || "0.0.0.0",
    dataDir,
    basePath: normalizeBasePath(env.BASE_PATH),
    publicUrl,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    sessionSecret: secret(dataDir, env.SESSION_SECRET),
    feedRefreshMinutes: int("FEED_REFRESH_MINUTES", 60, 5, 1440),
    logLevel: env.LOG_LEVEL || "info",
    ssrfAllowHosts: new Set((env.SSRF_ALLOW_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)),
    oidc,
    ignored: REMOVED_ENV.filter((k) => (env[k] ?? "").trim() !== ""),
    version: VERSION,
  };
}
