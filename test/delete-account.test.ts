import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Browser, Device, withAdmin, addUser, type Ctx } from "./helpers.ts";

const FEED = "https://example.com/feed";
const tables = ["devices", "sessions", "identities", "subscriptions", "episode_state", "queue_items", "pushes", "user_settings", "ratings"];

describe("delete my account (feature 8)", () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await withAdmin(); });
  afterEach(() => ctx.stop());
  const count = (uid: number) => Object.fromEntries(tables.map((t) => [t, (ctx.db.get(`SELECT COUNT(*) n FROM ${t} WHERE user_id=?`, uid) as any).n]));

  test("an app deletes its user: everything for that user is gone, other users untouched, the token stops working", async () => {
    const sam = addUser(ctx, "sam");
    const d = await new Device(ctx).login("Sam's phone", "sam");
    const other = await new Device(ctx).login("Patch's phone", "patch");
    for (const x of [d, other]) await x.push({ pushId: "p", subscriptions: [{ feedUrl: FEED, title: "X" }], episodes: [{ feedUrl: FEED, guid: "1", positionMs: 5000 }],
      queue: { base: [], items: [{ feedUrl: FEED, guid: "1" }] }, settings: [{ key: "skipBackSec", value: 15 }], ratings: [{ feedUrl: FEED, rating: 1 }] });
    assert.ok(Object.values(count(sam)).some((n) => n > 0));
    assert.equal((await d.req("DELETE", "/api/v1/me", { confirm: "wrong" })).status, 400, "needs the user name");
    assert.equal((await d.req("DELETE", "/api/v1/me", {})).status, 400);
    const r = await d.req("DELETE", "/api/v1/me", { confirm: "Sam" });
    assert.equal(r.status, 200); assert.equal(r.json.deleted, true);
    assert.deepEqual(Object.values(count(sam)).filter((n) => n > 0), [], JSON.stringify(count(sam)));
    assert.equal(ctx.db.get("SELECT 1 FROM users WHERE id=?", sam), undefined);
    assert.equal((await d.pull()).status, 401, "token revoked");
    assert.equal((await other.pull()).json.episodes.length, 1, "other user untouched");
  });

  test("the last administrator can't delete themselves while others exist; the sole user can", async () => {
    addUser(ctx, "sam");
    const admin = await new Device(ctx).login("Patch's phone", "patch");
    const r = await admin.req("DELETE", "/api/v1/me", { confirm: "patch" });
    assert.equal(r.status, 409); assert.equal(r.json.error, "last_admin");
    ctx.db.run("DELETE FROM users WHERE username='sam'");
    assert.equal((await admin.req("DELETE", "/api/v1/me", { confirm: "patch" })).status, 200, "alone on the server: allowed");
  });

  test("a browser needs a recent sign-in and CSRF; its cookie is cleared", async () => {
    addUser(ctx, "sam");
    const w = new Browser(ctx); await w.login("sam");
    assert.equal((await w.req("DELETE", "/api/v1/me", { confirm: "sam" }, { "x-csrf-token": "nope" })).status, 403, "CSRF");
    ctx.db.run("UPDATE sessions SET created_at=created_at-16*60000");
    const old = await w.req("DELETE", "/api/v1/me", { confirm: "sam" });
    assert.deepEqual([old.status, old.json.error], [403, "reauth_required"]);
    await w.login("sam");
    const ok = await w.req("DELETE", "/api/v1/me", { confirm: "sam" });
    assert.equal(ok.status, 200);
    assert.match(String(ok.headers["set-cookie"]), /patchcast_session=;/);
    assert.equal((await w.req("GET", "/api/v1/me")).status, 401);
  });
});
