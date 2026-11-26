import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mergeQueue } from "../src/sync.ts";
import { Device, addUser, withAdmin, type Ctx } from "./helpers.ts";

const FEED = "https://example.com/feed";
const ep = (guid: string, o: any = {}) => ({ feedUrl: FEED, guid, ...o });

describe("sync", () => {
  let ctx: Ctx, a: Device, b: Device, clock: number;
  const T0 = 1_800_000_000_000;
  beforeEach(async () => {
    clock = T0;
    ctx = await withAdmin({}, { now: () => clock });
    a = await new Device(ctx).login("Pixel"); b = await new Device(ctx).login("Tablet");
  });
  afterEach(() => ctx.stop());
  const state = async (guid = "1") => (await b.pull()).json.episodes.find((e: any) => e.guid === guid);

  test("incremental pull with a revision cursor and paging", async () => {
    await a.push({ episodes: [ep("1", { positionMs: 5000 }), ep("2", { positionMs: 6000 })], subscriptions: [{ feedUrl: FEED, title: "X" }] });
    const all = (await b.pull()).json;
    assert.equal(all.episodes.length, 2); assert.equal(all.subscriptions.length, 1);
    const none = (await b.pull(all.rev)).json;
    assert.deepEqual([none.episodes, none.subscriptions, none.queue, none.rev], [[], [], null, all.rev]);
    clock += 1000;
    await a.push({ episodes: [ep("2", { positionMs: 9000 })] });
    const inc = (await b.pull(all.rev)).json;
    assert.deepEqual(inc.episodes.map((e: any) => [e.guid, e.positionMs, e.deviceName]), [["2", 9000, "Pixel"]]);
    assert.ok(inc.rev > all.rev);
    const got: string[] = []; let since = 0;
    for (let i = 0; i < 10; i++) { const r = (await b.req("GET", `/api/v1/sync?since=${since}&limit=1`)).json; got.push(...r.episodes.map((e: any) => e.guid), ...r.subscriptions.map(() => "sub")); since = r.rev; if (!r.hasMore) break; }
    assert.deepEqual(got.sort(), ["1", "2", "sub"]);
  });

  test("played is sticky: later progress, stale or non-explicit unplays don't clear it", async () => {
    await a.push({ clientTime: clock, episodes: [ep("1", { played: true, playedChangedAt: clock })] });
    clock += 60_000;
    await b.push({ clientTime: clock, episodes: [ep("1", { played: false, playedChangedAt: clock })] });
    assert.equal((await state()).played, true, "non-explicit");
    await b.push({ clientTime: clock, episodes: [ep("1", { played: false, explicitUnplayed: true, playedChangedAt: T0 - 5000 })] });
    assert.equal((await state()).played, true, "older explicit");
    await b.push({ clientTime: clock, episodes: [ep("1", { played: false, explicitUnplayed: true, playedChangedAt: T0 })] });
    assert.equal((await state()).played, true, "equal time is not strictly newer");
    await b.push({ clientTime: clock, episodes: [ep("1", { played: false, explicitUnplayed: true, playedChangedAt: clock })] });
    assert.equal((await state()).played, false, "newer explicit");
    await a.push({ clientTime: clock, episodes: [ep("1", { played: true, playedChangedAt: T0 + 10 })] });
    assert.equal((await state()).played, false, "a played event from before the explicit unplay stays overridden");
    clock += 1000;
    await a.push({ clientTime: clock, episodes: [ep("1", { played: true, playedChangedAt: clock })] });
    assert.equal((await state()).played, true);
  });

  test("position: latest wins in either direction; stale loses; ties keep the furthest", async () => {
    await a.push({ clientTime: clock, episodes: [ep("1", { positionMs: 600_000, positionChangedAt: clock })] });
    clock += 5000;
    await b.push({ clientTime: clock, episodes: [ep("1", { positionMs: 100_000, positionChangedAt: clock })] });
    assert.equal((await state()).positionMs, 100_000, "a real rewind is honoured");
    await a.push({ clientTime: clock, episodes: [ep("1", { positionMs: 700_000, positionChangedAt: clock - 4000 })] });
    assert.equal((await state()).positionMs, 100_000, "offline stale update loses");
    await a.push({ clientTime: clock, episodes: [ep("1", { positionMs: 90_000, positionChangedAt: clock })] });
    assert.equal((await state()).positionMs, 100_000, "tie keeps furthest");
  });

  test("trivial backwards moves from another device are ignored, from the same device kept", async () => {
    await a.push({ clientTime: clock, episodes: [ep("1", { positionMs: 600_000, positionChangedAt: clock })] });
    clock += 2000;
    await b.push({ clientTime: clock, episodes: [ep("1", { positionMs: 592_000, positionChangedAt: clock })] });
    assert.equal((await state()).positionMs, 600_000);
    clock += 1000;
    await a.push({ clientTime: clock, episodes: [ep("1", { positionMs: 590_000, positionChangedAt: clock })] });
    assert.equal((await state()).positionMs, 590_000, "10 s skip back on the playing device");
    clock += 120_000;
    await b.push({ clientTime: clock, episodes: [ep("1", { positionMs: 585_000, positionChangedAt: clock })] });
    assert.equal((await state()).positionMs, 585_000, "outside the skew window it counts");
  });

  test("clock skew: wrong client clocks are corrected with clientTime and never reach the future", async () => {
    const fast = 3 * 3600_000; // device A runs 3 h fast
    await a.push({ clientTime: clock + fast, episodes: [ep("1", { positionMs: 100_000, positionChangedAt: clock + fast - 1000 })] });
    assert.equal((await state()).positionAt, clock - 1000);
    clock += 10_000;
    await b.push({ clientTime: clock - 5 * 3600_000, episodes: [ep("1", { positionMs: 400_000, positionChangedAt: clock - 5 * 3600_000 })] }); // 5 h slow
    assert.equal((await state()).positionMs, 400_000);
    await a.push({ clientTime: clock, episodes: [ep("2", { positionMs: 1, positionChangedAt: clock + 999_999 })] });
    assert.equal((await state("2")).positionAt, clock);
  });

  test("finishing resets the position; progress from before the finish can't undo it; replay keeps played", async () => {
    await a.push({ clientTime: clock, episodes: [ep("1", { positionMs: 600_000, positionChangedAt: clock })] });
    clock += 60_000;
    await a.push({ clientTime: clock, episodes: [ep("1", { played: true, playedChangedAt: clock })] });
    await b.push({ clientTime: clock, episodes: [ep("1", { positionMs: 500_000, positionChangedAt: clock - 1000 })] });
    let s = await state();
    assert.deepEqual([s.played, s.positionMs], [true, 0]);
    clock += 60_000;
    await b.push({ clientTime: clock, episodes: [ep("1", { positionMs: 30_000, positionChangedAt: clock })] });
    s = await state();
    assert.deepEqual([s.played, s.positionMs], [true, 30_000]);
  });

  test("idempotent: same push twice changes nothing; same pushId returns the first answer", async () => {
    const body = { pushId: "p1", clientTime: clock, episodes: [ep("1", { positionMs: 5000, positionChangedAt: clock })], subscriptions: [{ feedUrl: FEED, deleted: false, changedAt: clock }], queue: { base: [], items: [ep("1")] } };
    const r1 = (await a.push(body)).json;
    const r2 = (await a.push(body)).json;
    assert.equal(r2.duplicate, true); assert.equal(r2.rev, r1.rev);
    const r3 = (await a.push({ ...body, pushId: "p2" })).json;
    assert.deepEqual([r3.rev, r3.episodes, r3.subscriptions, r3.queue], [r1.rev, 0, 0, false]);
    // A retried queue add must not resurrect what another device removed meanwhile.
    await b.push({ queue: { base: [ep("1")], items: [] } });
    await a.push(body);
    assert.deepEqual((await b.pull()).json.queue, []);
  });

  test("subscription tombstones, resubscribe, and settings", async () => {
    await a.push({ clientTime: clock, subscriptions: [{ feedUrl: FEED, title: "X", deleted: false, changedAt: clock, settings: { speed: 1.5, priority: 2, bogus: 1 }, settingsChangedAt: clock }] });
    const r0 = (await b.pull()).json;
    assert.deepEqual(r0.subscriptions[0].settings, { speed: 1.5, priority: 2 });
    clock += 1000;
    await b.push({ clientTime: clock, subscriptions: [{ feedUrl: "http://www.example.com/feed/", deleted: true, changedAt: clock }] });
    const r1 = (await a.pull(r0.rev)).json;
    assert.deepEqual(r1.subscriptions.map((s: any) => [s.feedUrl, s.deleted]), [[FEED, true]], "tombstone reaches other devices, matched despite URL spelling");
    await a.push({ clientTime: clock, subscriptions: [{ feedUrl: FEED, deleted: false, changedAt: clock - 500 }] });
    assert.equal((await a.pull()).json.subscriptions[0].deleted, true, "older add loses to the delete");
    await a.push({ clientTime: clock, subscriptions: [{ feedUrl: FEED, settings: { speed: 2 }, settingsChangedAt: clock }] });
    assert.equal((await a.pull()).json.subscriptions[0].deleted, true, "a settings change doesn't resurrect");
    clock += 1000;
    await a.push({ clientTime: clock, subscriptions: [{ feedUrl: FEED, deleted: false, changedAt: clock }] });
    const s = (await a.pull()).json.subscriptions[0];
    assert.deepEqual([s.deleted, s.settings.speed], [false, 2]);
    await b.push({ clientTime: clock, subscriptions: [{ feedUrl: FEED, settings: { speed: 1 }, settingsChangedAt: clock - 5000 }] });
    assert.equal((await a.pull()).json.subscriptions[0].settings.speed, 2, "stale settings lose");
  });

  test("queue: concurrent edits merge, tombstones hold, finishing removes", async () => {
    await a.push({ queue: { base: [], items: [ep("1"), ep("2"), ep("3")] } });
    const r = (await b.pull()).json;
    assert.deepEqual(r.queue.map((q: any) => q.guid), ["1", "2", "3"]);
    const base = r.queue;
    await a.push({ queue: { base, items: [ep("1"), ep("3"), ep("4")] } });
    await b.push({ queue: { base, items: [ep("3"), ep("1"), ep("2"), ep("5", { auto: true })] } });
    assert.deepEqual((await a.pull()).json.queue.map((q: any) => q.guid).sort(), ["1", "3", "4", "5"]);
    await a.push({ clientTime: clock, episodes: [ep("3", { played: true, playedChangedAt: clock })] });
    const q = (await a.pull()).json.queue;
    assert.equal(q.some((x: any) => x.guid === "3"), false);
    assert.equal(q.find((x: any) => x.guid === "5").auto, true);
    assert.equal((await a.pull((await a.pull()).json.rev)).json.queue, null);
  });

  test("force mode: this device wins", async () => {
    await b.push({ clientTime: clock, episodes: [ep("1", { positionMs: 900_000, positionChangedAt: clock })] });
    await a.push({ clientTime: clock, mode: "force", episodes: [ep("1", { positionMs: 10, positionChangedAt: 5 })] });
    assert.equal((await state()).positionMs, 900_000, "same instant keeps the furthest");
    clock += 1;
    await a.push({ clientTime: clock, mode: "force", episodes: [ep("1", { positionMs: 10, positionChangedAt: 5 })] });
    assert.equal((await state()).positionMs, 10);
  });

  test("unknown GUIDs fall back to the enclosure URL", async () => {
    ctx.db.run("INSERT INTO feeds(id,key,url) VALUES(1,'example.com/feed',?)", FEED);
    ctx.db.run("INSERT INTO episodes(feed_id,guid,title,audio_url,first_seen) VALUES(1,'real-guid','t','https://cdn.example.com/e.mp3?x=1',0)");
    await a.push({ episodes: [ep("old-guid", { enclosureUrl: "http://cdn.example.com/e.mp3?x=2", positionMs: 7 })] });
    assert.equal((await state("real-guid")).positionMs, 7);
    await a.push({ episodes: [{ feedUrl: FEED, enclosureUrl: "https://cdn.example.com/other.mp3", positionMs: 8 }] });
    assert.equal((await state("https://cdn.example.com/other.mp3")).positionMs, 8);
  });

  test("users are isolated; malformed pushes are rejected atomically", async () => {
    addUser(ctx, "other");
    const o = await new Device(ctx).login("Other", "other");
    await a.push({ episodes: [ep("1", { positionMs: 5 })] });
    assert.deepEqual((await o.pull()).json.episodes, []);
    const r = await a.push({ episodes: [ep("9", { positionMs: 1 }), { guid: "x" }] });
    assert.equal(r.status, 400);
    assert.equal(await state("9"), undefined, "nothing from the failed batch was stored");
    assert.equal((await a.push({ episodes: "x" })).status, 400);
    assert.equal((await a.req("GET", "/api/v1/sync?since=-1")).status, 400);
  });
});

test("mergeQueue", () => {
  const m = (b: string, t: string, c: string) => mergeQueue([...b], [...t], [...c]).join("");
  assert.equal(m("abc", "abc", "abc"), "abc");
  assert.equal(m("abc", "abcd", "abc"), "abcd");
  assert.equal(m("abc", "dabc", "abc"), "dabc");
  assert.equal(m("abc", "ac", "abc"), "ac");
  assert.equal(m("abc", "cab", "abc"), "cab");
  assert.equal(m("abc", "abc", "cab"), "cab", "server's reorder survives a client that didn't reorder");
  assert.equal(m("abc", "abcx", "abcy").length, 5);
  assert.equal(m("abc", "ac", "abcy"), "acy");
  assert.equal(m("abc", "cba", "abyc"), "cbya");
  assert.equal(m("", "xy", "ab").split("").sort().join(""), "abxy");
  assert.equal(m("abc", "abc", "ab"), "ab", "server removal survives");
  // Applying the same edit twice is a no-op.
  const once = mergeQueue([..."abc"], [..."cax"], [..."abcy"]);
  assert.deepEqual(mergeQueue([..."abc"], [..."cax"], once), once);
});
