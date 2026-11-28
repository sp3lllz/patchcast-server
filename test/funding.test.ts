import { test } from "node:test";
import assert from "node:assert/strict";
import { Browser, serve, withAdmin } from "./helpers.ts";
import { parseFeed } from "../src/feed.ts";

// Same cases as Android FundingTest and PatchcastCore FundingTests.
const FEED = `<rss xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><title>Show</title>
  <podcast:funding url="https://example.com/donate">Support us &amp; more</podcast:funding>
  <podcast:funding url="https://example.com/donate">Duplicate</podcast:funding>
  <podcast:funding url="javascript:alert(1)">Bad</podcast:funding>
  <podcast:funding url="https://example.com/members"> </podcast:funding>
  <podcast:funding url="https://example.com/long">${"x".repeat(80)}</podcast:funding>
  <item><guid>1</guid><title>A</title><enclosure url="https://example.com/1.mp3"/><podcast:funding url="https://example.com/ep">Episode level is ignored</podcast:funding></item></channel></rss>`;

test("podcast:funding: http links only, default label, no duplicates, long labels shortened; item-level ignored", () => {
  const f = parseFeed(FEED);
  assert.deepEqual(f.funding, [
    { url: "https://example.com/donate", text: "Support us & more" },
    { url: "https://example.com/members", text: "Support the show" },
    { url: "https://example.com/long", text: "x".repeat(59) + "…" }]);
});

test("podcast:funding is on the podcast in the API", async () => {
  const host = await serve((req, res) => { if (req.url === "/feed") { res.setHeader("content-type", "application/rss+xml"); res.end(FEED); } else { res.statusCode = 404; res.end(); } });
  const ctx = await withAdmin({ SSRF_ALLOW_HOSTS: host.host });
  try {
    const b = new Browser(ctx); await b.login();
    const sub = await b.req("POST", "/api/v1/subscriptions", { url: `${host.url}/feed` });
    const p = (await b.req("GET", `/api/v1/podcasts/${sub.json.id}`)).json;
    assert.equal(p.funding[0].url, "https://example.com/donate");
    assert.equal(p.funding.length, 3);
  } finally { await ctx.stop(); await host.close(); }
});
