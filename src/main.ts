import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { buildApp } from "./app.ts";
import { passwordProblem, validateUsername } from "./auth.ts";

process.umask(0o077); // database and secrets are private to this user
const config = loadConfig();
const here = dirname(fileURLToPath(import.meta.url));
const { app, auth, db, feeds } = await buildApp({ config, webDir: process.env.WEB_DIR || join(here, "web") });

// Recovery: docker compose exec -T patchcast node /app/server.mjs set-password <user>   (new password on stdin)
if (process.argv[2] === "set-password") {
  const { readFileSync } = await import("node:fs");
  const password = readFileSync(0, "utf8").replace(/\r?\n$/, "");
  const problem = passwordProblem(password), user = db.get("SELECT id FROM users WHERE username=?", process.argv[3] ?? "");
  if (problem || !user) { console.error(problem ?? "No such user"); process.exit(1); }
  await auth.setPassword(user.id, password);
  // Recovery also works while OIDC_PASSWORD_LOGIN=false: that user may use the password for the next 24 hours.
  db.run("UPDATE users SET pw_recovery_until=? WHERE id=?", Date.now() + 86_400_000, user.id);
  console.log("Password changed; browser sessions of that user were signed out." + (config.oidc && !config.oidc.passwordLogin ? " Password sign-in is open to them for 24 hours." : ""));
  process.exit(0);
}

if (auth.userCount() === 0 && config.adminUser && config.adminPassword) {
  const username = validateUsername(config.adminUser), problem = passwordProblem(config.adminPassword);
  if (!username || problem) { app.log.error(problem ?? "ADMIN_USER is not a valid username"); process.exit(1); }
  await auth.createUser(username, config.adminPassword, true, true);
  app.log.info({ username }, "admin account created from ADMIN_USER / ADMIN_PASSWORD");
}
const token = auth.ensureSetupToken();
await app.listen({ port: config.port, host: config.host });
if (token) {
  // The one secret that has to reach the log: valid only until the first account exists, and not written to disk.
  console.log(`\n  Patchcast Sync: first-run setup\n  Open ${config.publicUrl ?? `http://localhost:${config.port}`}${config.basePath}/ and enter this setup token:\n\n      ${token}\n`);
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
