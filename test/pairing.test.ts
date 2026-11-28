import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { Browser, Device, addUser, withAdmin, type Ctx } from "./helpers.ts";
import { ALPHABET, PAIR_MS, normalizeUserCode } from "../src/pairing.ts";

/** A TV: no cookies, no token yet, just the two public pairing calls. */
const tv = (ctx: Ctx, ip = "198.51.100.7") => ({
  start: (body: any = { deviceName: "Living room TV" }) => ctx.app.inject({ method: "POST", url: "/api/v1/auth/pair/start", payload: body, remoteAddress: ip }),
  poll: (pairCode: string) => ctx.app.inject({ method: "POST", url: "/api/v1/auth/pair/poll", payload: { pairCode }, remoteAddress: ip }),
});

describe("device pairing", () => {
  let ctx: Ctx, now: number;
  beforeEach(async () => { now = Date.now(); ctx = await withAdmin({}, { now: () => now }); });
  afterEach(() => ctx.stop());

  test("start → approve in the browser → the TV gets a working device token, once", async () => {
    const t = tv(ctx);
    const s = (await t.start()).json();
    assert.match(s.pairCode, /^[\w-]{43}$/);
    assert.match(s.userCode, new RegExp(`^[${ALPHABET}]{4}-[${ALPHABET}]{4}$`));
    assert.equal(s.expiresIn, 600); assert.equal(s.interval, 5);
    assert.equal(s.verifyUrl, "http://localhost/pair");
    assert.equal(s.verifyUrlComplete, `http://localhost/pair?code=${s.userCode.replace("-", "")}`);

    assert.deepEqual((await t.poll(s.pairCode)).json(), { status: "pending" });

    const b = new Browser(ctx); await b.login();
    const look = await b.req("GET", `/api/v1/pair/${s.userCode.toLowerCase()}`); // any case, with or without the dash
    assert.equal(look.status, 200);
    assert.equal(look.json.deviceName, "Living room TV");
    assert.equal(look.json.userCode, s.userCode);
    const ok = await b.req("POST", `/api/v1/pair/${s.userCode.replace("-", "")}/approve`, {});
    assert.equal(ok.status, 200); assert.equal(ok.json.deviceName, "Living room TV");

    now += 5000;
    const got = (await t.poll(s.pairCode)).json();
    assert.equal(got.status, "approved");
    assert.match(got.token, /^pct_/);
    assert.equal(got.user.username, "patch");
    const d = new Device(ctx); d.token = got.token;
    const me = await d.req("GET", "/api/v1/me");
    assert.equal(me.status, 200); assert.equal(me.json.deviceName, "Living room TV");
    assert.equal(me.json.deviceId, got.deviceId);
    // It's a normal app device: listed, and it can sync.
    const devs = (await b.req("GET", "/api/v1/devices")).json.devices;
    assert.ok(devs.some((x: any) => x.id === got.deviceId && x.kind === "app"));
    assert.equal((await d.pull()).status, 200);

    // The pairCode works once; the userCode was used up by the approval.
    const again = await t.poll(s.pairCode);
    assert.equal(again.statusCode, 400); assert.equal(again.json().error, "expired");
    assert.equal((await b.req("GET", `/api/v1/pair/${s.userCode}`)).status, 404);
  });

  test("an app with a device token can approve too (phone approval)", async () => {
    const s = (await tv(ctx).start()).json();
    const phone = await new Device(ctx).login("Phone");
    assert.equal((await phone.req("POST", `/api/v1/pair/${s.userCode}/approve`)).status, 200);
    now += 5000;
    assert.equal((await tv(ctx).poll(s.pairCode)).json().status, "approved");
  });

  test("the approving account is the one the TV joins", async () => {
    addUser(ctx, "zoe");
    const s = (await tv(ctx).start()).json();
    const b = new Browser(ctx); await b.login("zoe");
    await b.req("POST", `/api/v1/pair/${s.userCode}/approve`, {});
    now += 5000;
    assert.equal((await tv(ctx).poll(s.pairCode)).json().user.username, "zoe");
  });

  test("deny: the TV is told and the code is gone", async () => {
    const s = (await tv(ctx).start()).json();
    const b = new Browser(ctx); await b.login();
    assert.equal((await b.req("POST", `/api/v1/pair/${s.userCode}/deny`, {})).status, 200);
    const r = await tv(ctx).poll(s.pairCode);
    assert.equal(r.statusCode, 403); assert.equal(r.json().error, "denied");
    assert.equal((await tv(ctx).poll(s.pairCode)).json().error, "expired");
    assert.equal((await b.req("POST", `/api/v1/pair/${s.userCode}/approve`, {})).status, 404);
  });

  test("codes expire after 10 minutes", async () => {
    const s = (await tv(ctx).start()).json();
    const b = new Browser(ctx); await b.login();
    now += PAIR_MS + 1;
    assert.equal((await b.req("GET", `/api/v1/pair/${s.userCode}`)).status, 404);
    const r = await tv(ctx).poll(s.pairCode);
    assert.equal(r.statusCode, 400); assert.equal(r.json().error, "expired");
  });

  test("polling faster than the interval gets slow_down with Retry-After", async () => {
    const s = (await tv(ctx).start()).json();
    assert.equal((await tv(ctx).poll(s.pairCode)).statusCode, 200);
    now += 1000;
    const r = await tv(ctx).poll(s.pairCode);
    assert.equal(r.statusCode, 429); assert.equal(r.json().error, "slow_down"); assert.equal(r.headers["retry-after"], "5");
    now += 5000;
    assert.equal((await tv(ctx).poll(s.pairCode)).statusCode, 200);
  });

  test("approving needs a signed-in user, and the browser's CSRF token", async () => {
    const s = (await tv(ctx).start()).json();
    const anon = await ctx.app.inject({ method: "GET", url: `/api/v1/pair/${s.userCode}` });
    assert.equal(anon.statusCode, 401);
    const b = new Browser(ctx); await b.login();
    const noCsrf = await b.req("POST", `/api/v1/pair/${s.userCode}/approve`, {}, { "x-csrf-token": "wrong" });
    assert.equal(noCsrf.status, 403);
    const crossSite = await b.req("POST", `/api/v1/pair/${s.userCode}/approve`, {}, { "sec-fetch-site": "cross-site" });
    assert.equal(crossSite.status, 403);
    assert.equal((await tv(ctx).poll(s.pairCode)).json().status, "pending");
  });

  test("guessing codes is rate limited per account", async () => {
    const b = new Browser(ctx); await b.login();
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await b.req("GET", `/api/v1/pair/BBBB-BB${ALPHABET[i % 20]}${ALPHABET[(i * 7) % 20]}`)).status;
    assert.equal(last, 429);
  });

  test("starting is rate limited per address; bad input is refused", async () => {
    for (let i = 0; i < 30; i++) assert.equal((await tv(ctx, "192.0.2.9").start()).statusCode, 200);
    assert.equal((await tv(ctx, "192.0.2.9").start()).statusCode, 429);
    assert.equal((await tv(ctx).poll("nope")).statusCode, 400);
    const unnamed = (await tv(ctx).start({ deviceName: "\u0000\u0007" })).json();
    const b = new Browser(ctx); await b.login();
    assert.equal((await b.req("GET", `/api/v1/pair/${unnamed.userCode}`)).json.deviceName, "TV");
  });

  test("the pair code and token never reach the log", async () => {
    let log = "";
    const stream = new Writable({ write(c, _e, cb) { log += c; cb(); } });
    const c2 = await withAdmin({ LOG_LEVEL: "debug" }, { logStream: stream });
    try {
      const s = (await tv(c2).start()).json();
      const b = new Browser(c2); await b.login();
      await b.req("POST", `/api/v1/pair/${s.userCode}/approve`, {});
      const got = (await tv(c2).poll(s.pairCode)).json();
      assert.equal(got.status, "approved");
      assert.ok(log.includes("device paired"));
      assert.ok(!log.includes(s.pairCode)); assert.ok(!log.includes(got.token));
    } finally { await c2.stop(); }
  });

  test("normalizeUserCode", () => {
    assert.equal(normalizeUserCode("bcdf-ghjk"), "BCDFGHJK");
    assert.equal(normalizeUserCode(" BCDF GHJK "), "BCDFGHJK");
    assert.equal(normalizeUserCode("BCDF-GHJA"), ""); // vowel: never issued
    assert.equal(normalizeUserCode("BCDF"), "");
    assert.equal(normalizeUserCode(42), "");
  });
});
