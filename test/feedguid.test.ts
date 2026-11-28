import { test } from "node:test";
import assert from "node:assert/strict";
import { Browser, serve, withAdmin } from "./helpers.ts";
import { feedGuid, parseFeed } from "../src/feed.ts";

// Same cases as Android FeedGuidTest and PatchcastCore FeedGuidTests.
test("podcast:guid is read, normalised to lower case, junk ignored", () => {
  const f = (g: string) => parseFeed(`<rss xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><title>T</title><podcast:guid>${g}</podcast:guid></channel></rss>`).guid;
  assert.equal(f(" 9B024349-CCF0-5F69-A609-6B82873EAB3C "), "9b024349-ccf0-5f69-a609-6b82873eab3c");
  assert.equal(f("<b>x</b>"), null);
  assert.equal(feedGuid("has spaces"), null);
  assert.equal(feedGuid("x".repeat(101)), null);
  assert.equal(parseFeed(`<rss><channel><title>T</title></channel></rss>`).guid, null);
});

test("a rating follows the podcast to its new feed address via podcast:guid", async () => {
  const feed = (g: string) => `<rss xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><title>Moving show</title><podcast:guid>${g}</podcast:guid>
    <item><guid>1</guid><title>E</title><enclosure url="https://example.com/1.mp3"/></item></channel></rss>`;
  const host = await serve((req, res) => {
    res.setHeader("content-type", "application/rss+xml");
    if (req.url === "/old" || req.url === "/new") res.end(feed("show-guid-1")); else if (req.url === "/other") res.end(feed("show-guid-2")); else { res.statusCode = 404; res.end(); }
  });
  const ctx = await withAdmin({ SSRF_ALLOW_HOSTS: host.host });
  try {
    const b = new Browser(ctx); await b.login();
    const old = (await b.req("POST", "/api/v1/subscriptions", { url: `${host.url}/old` })).json.id;
    await b.req("PUT", `/api/v1/podcasts/${old}/rating`, { rating: 1 });
    await b.req("DELETE", `/api/v1/subscriptions/${old}`);
    const moved = (await b.req("POST", "/api/v1/subscriptions", { url: `${host.url}/new` })).json.id;
    const p = (await b.req("GET", `/api/v1/podcasts/${moved}`)).json;
    assert.equal(p.guid, "show-guid-1");
    assert.equal(p.rating, 1, "liked before the move");
    const other = (await b.req("POST", "/api/v1/subscriptions", { url: `${host.url}/other` })).json.id;
    assert.equal((await b.req("GET", `/api/v1/podcasts/${other}`)).json.rating, 0, "a different guid doesn't inherit it");
    await b.req("PUT", `/api/v1/podcasts/${moved}/rating`, { rating: -1 });
    assert.equal((await b.req("GET", `/api/v1/podcasts/${moved}`)).json.rating, -1, "its own rating wins once set");
  } finally { await ctx.stop(); await host.close(); }
});
