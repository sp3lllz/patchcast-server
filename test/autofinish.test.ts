import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { shouldAutoFinish, AUTO_FINISH_GRACE_MS } from "../src/sync.ts";
import { Device, withAdmin, type Ctx } from "./helpers.ts";

const FEED = "https://example.com/feed";
const MIN = 60_000;

test("the rule: < 5 min left, paused ≥ 10 min ago, after the rollout", () => {
  const since = 1000, now = 100 * MIN;
  const e = (o: any = {}) => ({ played: false, positionMs: 56 * MIN, durationMs: 60 * MIN, pausedAt: now - 10 * MIN, ...o });
  assert.equal(shouldAutoFinish(e(), now, since), true);
  assert.equal(shouldAutoFinish(e({ pausedAt: now - 10 * MIN + 1 }), now, since), false, "grace not over");
  assert.equal(shouldAutoFinish(e({ positionMs: 55 * MIN }), now, since), false, "exactly 5 min left is not < 5");
  assert.equal(shouldAutoFinish(e({ played: true }), now, since), false);
  assert.equal(shouldAutoFinish(e({ durationMs: null }), now, since), false, "unknown length");
  assert.equal(shouldAutoFinish(e({ positionMs: 0 }), now, since), false, "never started");
  assert.equal(shouldAutoFinish(e({ pausedAt: since - 1 }), now, since), false, "paused before the rollout");
});

describe("auto-finish on the server (feature 7)", () => {
  let ctx: Ctx, a: Device, b: Device, clock: number;
  const T0 = 1_800_000_000_000;
  beforeEach(async () => {
    clock = T0;
    ctx = await withAdmin({}, { now: () => clock });
    a = await new Device(ctx).login("Pixel"); b = await new Device(ctx).login("Mac");
  });
  afterEach(() => ctx.stop());
  const state = async (guid = "1") => (await b.pull()).json.episodes.find((e: any) => e.guid === guid);
  const pause = (d: Device, pos: number, guid = "1") => d.push({ clientTime: clock, episodes: [{ feedUrl: FEED, guid, positionMs: pos, positionChangedAt: clock, durationMs: 60 * MIN, lastPlayedAt: clock }] });

  test("nearly finished and not resumed for 10 minutes → played everywhere, position 0, out of the queue", async () => {
    await pause(a, 57 * MIN);
    await a.push({ queue: { base: [], items: [{ feedUrl: FEED, guid: "1" }, { feedUrl: FEED, guid: "2" }] } });
    clock += 9 * MIN;
    assert.equal((await state()).played, false, "a short phone call doesn't count");
    clock += MIN;
    const s = await state();
    assert.deepEqual([s.played, s.positionMs, s.completedAt], [true, 0, T0 + AUTO_FINISH_GRACE_MS]);
    assert.deepEqual((await b.pull()).json.queue.map((q: any) => q.guid), ["2"]);
  });

  test("resuming on any device restarts the 10 minutes; playing past the end of the grace never marks it", async () => {
    await pause(a, 56 * MIN);
    clock += 8 * MIN;
    await pause(b, 56.5 * MIN); // resumed on the Mac and paused again
    clock += 8 * MIN;
    assert.equal((await state()).played, false);
    clock += 2 * MIN;
    assert.equal((await state()).played, true);
  });

  test("more than 5 minutes left, or a pause from before the rollout, is left alone", async () => {
    await pause(a, 50 * MIN, "far");
    ctx.db.run("UPDATE meta SET value=? WHERE key='auto_finish_since'", String(T0 + 1));
    await pause(a, 58 * MIN, "old");
    clock += 30 * MIN;
    const p = (await b.pull()).json.episodes;
    assert.equal(p.find((e: any) => e.guid === "far").played, false);
    assert.equal(p.find((e: any) => e.guid === "old").played, false);
  });

  test("the periodic sweep marks it without anyone pulling and tells devices", async () => {
    await pause(a, 59 * MIN);
    const before = (await b.pull()).json.rev;
    clock += 11 * MIN;
    assert.equal(ctx.sync.autoFinish(), 1);
    assert.equal(ctx.sync.autoFinish(), 0, "only once");
    const p = (await b.pull(before)).json;
    assert.equal(p.episodes[0].played, true);
    // An explicit unplay afterwards sticks (it is newer than the automatic played).
    clock += 1000;
    await a.push({ clientTime: clock, episodes: [{ feedUrl: FEED, guid: "1", played: false, explicitUnplayed: true, playedChangedAt: clock }] });
    assert.equal((await state()).played, false);
  });
});

import { pickShuffle, SHUFFLE_RECENT_MS } from "../src/sync.ts";
test("shuffle pick (feature 2): weighted towards episodes not heard in 30 days, empty → null", () => {
  const now = 10 * SHUFFLE_RECENT_MS;
  const c = [{ item: "recent", lastPlayedAt: now - 1000 }, { item: "old", lastPlayedAt: now - SHUFFLE_RECENT_MS - 1 }, { item: "never", lastPlayedAt: null }];
  // Weights 1, 4, 4 → total 9.
  assert.equal(pickShuffle(c, now, 0), "recent");
  assert.equal(pickShuffle(c, now, 0.999 / 9), "recent");
  assert.equal(pickShuffle(c, now, 1 / 9), "old");
  assert.equal(pickShuffle(c, now, 4.999 / 9), "old");
  assert.equal(pickShuffle(c, now, 5 / 9), "never");
  assert.equal(pickShuffle(c, now, 0.9999), "never");
  assert.equal(pickShuffle([], now, 0.5), null);
  let recent = 0; for (let i = 0; i < 9000; i++) if (pickShuffle(c, now, i / 9000) === "recent") recent++;
  assert.equal(recent, 1000);
});
