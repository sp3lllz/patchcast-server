import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Browser, Device, withAdmin, addUser, type Ctx } from "./helpers.ts";

const FEED = "https://example.com/feed";

describe("ratings (feature 6)", () => {
  let ctx: Ctx, a: Device, b: Device, clock: number;
  const T0 = 1_800_000_000_000;
  beforeEach(async () => {
    clock = T0;
    ctx = await withAdmin({}, { now: () => clock });
    a = await new Device(ctx).login("Pixel"); b = await new Device(ctx).login("Mac");
  });
  afterEach(() => ctx.stop());
  const rating = async (d: Device = b) => (await d.pull()).json.ratings.find((r: any) => r.feedUrl === FEED)?.rating;

  test("a thumbs up syncs, newest wins, and it outlives unsubscribing and resubscribing", async () => {
    await a.push({ clientTime: clock, subscriptions: [{ feedUrl: FEED, title: "X" }], ratings: [{ feedUrl: FEED, rating: 1, changedAt: clock }] });
    assert.equal(await rating(), 1);
    clock += 1000;
    await b.push({ clientTime: clock, ratings: [{ feedUrl: FEED, rating: -1, changedAt: T0 - 5 }] });
    assert.equal(await rating(), 1, "older change loses");
    await b.push({ clientTime: clock, subscriptions: [{ feedUrl: FEED, deleted: true, changedAt: clock }] });
    assert.equal(await rating(), 1, "unsubscribing keeps it");
    clock += 1000;
    await b.push({ clientTime: clock, subscriptions: [{ feedUrl: FEED, deleted: false, changedAt: clock }] });
    assert.equal(await rating(), 1, "there again after resubscribing");
    await b.push({ clientTime: clock, ratings: [{ feedUrl: FEED, rating: 0, changedAt: clock }] });
    assert.equal(await rating(a), 0, "cleared");
  });

  test("bad ratings are refused, other users can't see them, 0.9 apps ignore them", async () => {
    for (const r of [2, "1", null, 0.5]) assert.equal((await a.push({ ratings: [{ feedUrl: FEED, rating: r }] })).status, 400);
    assert.equal((await a.push({ ratings: [{ feedUrl: "not a url", rating: 1 }] })).status, 400);
    await a.push({ ratings: [{ feedUrl: FEED, rating: -1 }] });
    addUser(ctx, "sam");
    const s = await new Device(ctx).login("Sam", "sam");
    assert.deepEqual((await s.pull()).json.ratings, []);
    assert.equal((await b.push({ episodes: [{ feedUrl: FEED, guid: "1", positionMs: 5 }] })).status, 200, "a push without ratings is fine");
  });

  test("web: the library and podcast page show the rating; PUT sets it", async () => {
    const w = new Browser(ctx); await w.login();
    await a.push({ subscriptions: [{ feedUrl: FEED, title: "X" }] });
    const id = (await w.req("GET", "/api/v1/library")).json.podcasts[0].id;
    assert.equal((await w.req("GET", "/api/v1/library")).json.podcasts[0].rating, 0);
    assert.equal((await w.req("PUT", `/api/v1/podcasts/${id}/rating`, { rating: 1 })).json.rating, 1);
    assert.equal((await w.req("GET", `/api/v1/podcasts/${id}`)).json.rating, 1);
    assert.equal(await rating(), 1);
    assert.equal((await w.req("PUT", `/api/v1/podcasts/${id}/rating`, { rating: 3 })).status, 400);
  });
});
