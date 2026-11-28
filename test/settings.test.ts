import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Db } from "../src/db.ts";
import { Browser, Device, withAdmin, addUser, type Ctx } from "./helpers.ts";

const FEED = "https://example.com/feed";

describe("settings sync (0.10.0)", () => {
  let ctx: Ctx, a: Device, b: Device, clock: number;
  const T0 = 1_800_000_000_000;
  beforeEach(async () => {
    clock = T0;
    ctx = await withAdmin({}, { now: () => clock });
    a = await new Device(ctx).login("Pixel"); b = await new Device(ctx).login("iPad");
  });
  afterEach(() => ctx.stop());
  const values = async (d: Device = b, since = 0) => Object.fromEntries((await d.pull(since)).json.settings.map((s: any) => [s.key, s.value]));

  test("a setting pushed by one device is pulled by another, with who and when", async () => {
    const r = await a.push({ clientTime: clock, settings: [{ key: "skipBackSec", value: 15, changedAt: clock }, { key: "themeMode", value: "DARK", changedAt: clock }] });
    assert.equal(r.status, 200); assert.equal(r.json.settings, 2);
    const p = (await b.pull()).json;
    assert.deepEqual(p.settings.map((s: any) => [s.key, s.value, s.deviceId, s.changedAt]).sort(), [["skipBackSec", 15, a.id, T0], ["themeMode", "DARK", a.id, T0]]);
    // Incremental: nothing new since.
    assert.deepEqual((await b.pull(p.rev)).json.settings, []);
  });

  test("newest change per key wins, ties keep the stored value, keys are independent", async () => {
    await a.push({ clientTime: clock, settings: [{ key: "defaultSpeed", value: 1.5, changedAt: clock }, { key: "skipForwardSec", value: 45, changedAt: clock }] });
    clock += 60_000;
    // Older change (an offline device catching up) loses.
    await b.push({ clientTime: clock, settings: [{ key: "defaultSpeed", value: 1.2, changedAt: T0 - 1000 }] });
    assert.equal((await values()).defaultSpeed, 1.5);
    // Same time: stored wins.
    await b.push({ clientTime: clock, settings: [{ key: "defaultSpeed", value: 1.2, changedAt: T0 }] });
    assert.equal((await values()).defaultSpeed, 1.5);
    // Newer wins, the other key untouched.
    await b.push({ clientTime: clock, settings: [{ key: "defaultSpeed", value: 1.2, changedAt: clock }] });
    assert.deepEqual([(await values()).defaultSpeed, (await values()).skipForwardSec], [1.2, 45]);
  });

  test("client clock error is corrected and future times are capped", async () => {
    // Device clock is an hour fast: its change 'now' is the server's now.
    await a.push({ clientTime: clock + 3_600_000, settings: [{ key: "skipBackSec", value: 20, changedAt: clock + 3_600_000 }] });
    clock += 1000;
    await b.push({ clientTime: clock, settings: [{ key: "skipBackSec", value: 30, changedAt: clock }] });
    assert.equal((await values()).skipBackSec, 30, "the later real change wins despite the other device's fast clock");
  });

  test("null resets to the default and the reset syncs; force mode makes this device win", async () => {
    await a.push({ clientTime: clock, settings: [{ key: "themeMode", value: "LIGHT", changedAt: clock }] });
    clock += 1000;
    await a.push({ clientTime: clock, settings: [{ key: "themeMode", value: null, changedAt: clock }] });
    const s = (await b.pull()).json.settings.find((x: any) => x.key === "themeMode");
    assert.equal(s.value, null);
    await b.push({ clientTime: clock, mode: "force", settings: [{ key: "themeMode", value: "DARK", changedAt: 1 }] });
    assert.equal((await values(a)).themeMode, "DARK");
  });

  test("known keys are validated; unknown keys are kept for newer apps; the whole push is refused on a bad value", async () => {
    for (const bad of [{ key: "skipBackSec", value: 0 }, { key: "skipBackSec", value: "10" }, { key: "themeMode", value: "PINK" }, { key: "defaultSpeed", value: 9 },
      { key: "", value: 1 }, { key: "9lives", value: 1 }, { key: "x".repeat(65), value: 1 }, { key: "future.thing", value: "y".repeat(5000) }]) {
      const r = await a.push({ episodes: [{ feedUrl: FEED, guid: "1", positionMs: 1000 }], settings: [bad] });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.deepEqual((await b.pull()).json.episodes, [], "nothing stored from refused pushes");
    const ok = await a.push({ settings: [{ key: "future.sortOrder", value: { library: "title" } }] });
    assert.equal(ok.status, 200);
    assert.deepEqual((await values())["future.sortOrder"], { library: "title" });
    assert.equal((await a.push({ settings: "nope" })).status, 400);
    assert.equal((await a.push({ settings: Array.from({ length: 201 }, (_, i) => ({ key: `k${i}`, value: 1 })) })).status, 400);
  });

  test("settings are private to their user", async () => {
    addUser(ctx, "sam");
    const s = await new Device(ctx).login("Sam's phone", "sam");
    await a.push({ settings: [{ key: "skipBackSec", value: 25 }] });
    assert.deepEqual((await s.pull()).json.settings, []);
    assert.deepEqual((await s.req("GET", "/api/v1/settings")).json.settings, []);
  });

  test("a repeated pushId doesn't apply settings twice; feed= pulls leave settings out; paging includes them", async () => {
    const body = { pushId: "p-1", clientTime: clock, settings: [{ key: "skipBackSec", value: 12, changedAt: clock }] };
    const first = (await a.push(body)).json, again = (await a.push(body)).json;
    assert.equal(again.duplicate, true); assert.equal(again.rev, first.rev);
    await a.push({ subscriptions: [{ feedUrl: FEED, title: "X" }] });
    assert.equal((await b.req("GET", `/api/v1/sync?since=0&feed=${encodeURIComponent(FEED)}`)).json.settings.length, 0);
    const got: string[] = []; let since = 0;
    for (let i = 0; i < 10; i++) { const r = (await b.req("GET", `/api/v1/sync?since=${since}&limit=1`)).json; got.push(...r.settings.map((x: any) => x.key), ...r.subscriptions.map(() => "sub")); since = r.rev; if (!r.hasMore) break; }
    assert.deepEqual(got.sort(), ["skipBackSec", "sub"]);
  });

  test("an 0.9 app that knows nothing about settings still syncs (backwards compatible)", async () => {
    await a.push({ settings: [{ key: "skipBackSec", value: 25 }] });
    const old = await b.push({ pushId: "x", clientTime: clock, episodes: [{ feedUrl: FEED, guid: "1", positionMs: 3000, positionChangedAt: clock }], subscriptions: [{ feedUrl: FEED, title: "X", settings: { speed: 1.3 }, settingsChangedAt: clock }] });
    assert.equal(old.status, 200);
    const p = (await b.pull()).json;
    assert.equal(p.episodes[0].positionMs, 3000);
    assert.equal(p.subscriptions[0].settings.speed, 1.3);
  });

  test("per-podcast settings: download, retention and timeout overrides sync; bad values are dropped", async () => {
    await a.push({ subscriptions: [{ feedUrl: FEED, title: "X", settings: { autoDownload: false, retentionMode: "KEEP_LATEST", retentionKeep: 5, newTimeoutDays: 0, speed: 1.5 }, settingsChangedAt: clock }] });
    clock += 1000;
    await a.push({ subscriptions: [{ feedUrl: FEED, settings: { retentionMode: "BOGUS", retentionKeep: 0, newTimeoutDays: null }, settingsChangedAt: clock }] });
    const s = (await b.pull()).json.subscriptions[0].settings;
    assert.deepEqual([s.autoDownload, s.retentionMode, s.retentionKeep, s.newTimeoutDays, s.speed], [false, "KEEP_LATEST", 5, null, 1.5]);
  });

  test("web player: GET/PUT /settings with the browser session, change event to apps", async () => {
    const w = new Browser(ctx); await w.login();
    assert.deepEqual((await w.req("GET", "/api/v1/settings")).json.settings, []);
    const r = await w.req("PUT", "/api/v1/settings", { values: { skipForwardSec: 60, themeMode: "DARK" } });
    assert.equal(r.status, 200); assert.equal(r.json.changed, 2);
    assert.deepEqual(Object.fromEntries(r.json.settings.map((s: any) => [s.key, s.value])), { skipForwardSec: 60, themeMode: "DARK" });
    assert.equal((await values()).skipForwardSec, 60);
    assert.equal((await w.req("PUT", "/api/v1/settings", { values: { skipForwardSec: -1 } })).status, 400);
    assert.equal((await w.req("PUT", "/api/v1/settings", { values: [1] })).status, 400);
    assert.equal((await w.req("PUT", "/api/v1/settings", { values: { skipForwardSec: 30 } }, { "x-csrf-token": "wrong" })).status, 403);
  });
});

test("a 0.9.0 database (user_version 2) upgrades to the settings store and keeps its data", () => {
  const dir = mkdtempSync(join(tmpdir(), "pcs-mig-"));
  try {
    const path = join(dir, "patchcast.db");
    // Build exactly what 0.9.0 left behind: the first two migrations only.
    const old = new Db(path);
    old.run("INSERT INTO users(username,pw_hash,is_admin,created_at) VALUES('patch','',1,1)");
    old.run("INSERT INTO subscriptions(user_id,feed_key,feed_url,added_at,changed_at,rev,updated_at) VALUES(1,'example.com/feed','https://example.com/feed',1,1,1,1)");
    old.close();
    const raw = new DatabaseSync(path);
    raw.exec("DROP INDEX feeds_guid; ALTER TABLE feeds DROP COLUMN guid; ALTER TABLE feeds DROP COLUMN funding; ALTER TABLE feeds DROP COLUMN persons; ALTER TABLE episodes DROP COLUMN persons; ALTER TABLE episodes DROP COLUMN transcripts; ALTER TABLE episodes DROP COLUMN transcript; ALTER TABLE episodes DROP COLUMN transcript_source; DROP TABLE ratings; DROP TABLE meta; DROP TABLE user_settings; PRAGMA user_version=2");
    raw.close();
    const db = new Db(path);
    assert.equal((db.get("PRAGMA user_version") as any).user_version, 9);
    assert.ok(Number((db.get("SELECT value FROM meta WHERE key='auto_finish_since'") as any).value) > 1_700_000_000_000, "rollout time recorded");
    assert.equal(db.all("SELECT * FROM subscriptions").length, 1);
    assert.deepEqual(db.all("SELECT * FROM user_settings"), []);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
