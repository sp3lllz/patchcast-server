import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { buildApp } from "./app.ts";

process.umask(0o077); // database and secrets are private to this user

if (process.argv[2] === "set-password") {
  console.error("Patchcast Sync: set-password was removed in 0.8.0. There are no passwords any more: everybody signs in with the OIDC provider (Pocket ID), which manages accounts and recovery.");
  process.exit(2);
}

let config: Config;
try { config = loadConfig(); } catch (e: any) {
  // Refuse to start, with a message an operator can act on (no stack trace for configuration mistakes).
  console.error(`Patchcast Sync can't start: ${e instanceof ConfigError ? e.message : e?.stack ?? e}`);
  process.exit(1);
}
const here = dirname(fileURLToPath(import.meta.url));
const { app, auth, feeds } = await buildApp({ config, webDir: process.env.WEB_DIR || join(here, "web") });

if (config.ignored.length)
  app.log.warn({ ignored: config.ignored }, "these settings were removed in 0.8.0 (no passwords) and are ignored: remove them from the environment, and the password from .env");
await app.listen({ port: config.port, host: config.host });
if (auth.userCount() === 0) {
  const o = config.oidc;
  app.log.warn(!o.autoCreate ? "no accounts yet, and OIDC_AUTO_CREATE=false: nobody can sign in until it is true for the first sign-in"
    : o.adminGroups.length ? `no accounts yet: the first person to sign in with ${o.providerName} who is in OIDC_ADMIN_GROUPS becomes the administrator`
    : `no accounts yet: the first person to sign in with ${o.providerName} becomes the administrator (set OIDC_ADMIN_GROUPS, or OIDC_AUTO_CREATE=false, afterwards)`);
}

const every = config.feedRefreshMinutes * 60_000;
const tick = () => void feeds.refreshAll(every * 0.9).catch((e) => app.log.error({ err: String(e?.message) }, "refresh run failed"));
const first = setTimeout(tick, 5_000), timer = setInterval(tick, every);

let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, async () => {
  if (stopping) return;
  stopping = true;
  clearTimeout(first); clearInterval(timer);
  app.log.info({ sig }, "shutting down");
  setTimeout(() => process.exit(0), 5_000).unref();
  await app.close();
  process.exit(0);
});
process.on("unhandledRejection", (e: any) => app.log.error({ err: String(e?.stack ?? e) }, "unhandled rejection"));
