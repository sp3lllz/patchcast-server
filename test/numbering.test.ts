import { test } from "node:test";
import assert from "node:assert/strict";
import { Browser, serve, withAdmin } from "./helpers.ts";
import { numberingLabel, parseFeed } from "../src/feed.ts";

// Same cases as Android NumberingTest and PatchcastCore NumberingTests.
const FEED = `<rss xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>T</title>
  <podcast:medium>Audiobook</podcast:medium><podcast:locked owner="x@example.com">yes</podcast:locked>
  <item><guid>1</guid><title>A</title><enclosure url="https://example.com/1.mp3"/><podcast:season name="The Return">2</podcast:season><podcast:episode display="Ch. 5">5</podcast:episode></item>
  <item><guid>2</guid><title>B</title><enclosure url="https://example.com/2.mp3"/><podcast:season>3</podcast:season><podcast:episode>12</podcast:episode></item>
  <item><guid>3</guid><title>C</title><enclosure url="https://example.com/3.mp3"/><podcast:episode>4.5</podcast:episode></item>
  <item><guid>4</guid><title>D</title><enclosure url="https://example.com/4.mp3"/><itunes:season>1</itunes:season><itunes:episode>7</itunes:episode></item>
</channel></rss>`;

test("podcast:season/episode label; medium and locked", () => {
  const f = parseFeed(FEED);
  assert.deepEqual(f.episodes.map((e) => e.numbering ?? null), ["The Return · Ch. 5", "Season 3 · Episode 12", "Episode 4.5", null]);
  assert.equal(f.medium, "audiobook"); assert.equal(f.locked, true);
  const plain = parseFeed(`<rss><channel><title>T</title></channel></rss>`);
  assert.equal(plain.medium, null); assert.equal(plain.locked, false);
  assert.equal(numberingLabel(null, null), null);
  assert.equal(numberingLabel({ n: null, name: null }, null), null);
});

test("numbering on episodes, medium on the podcast", async () => {
  const host = await serve((req, res) => { if (req.url === "/feed") { res.setHeader("content-type", "application/rss+xml"); res.end(FEED); } else { res.statusCode = 404; res.end(); } });
  const ctx = await withAdmin({ SSRF_ALLOW_HOSTS: host.host });
  try {
    const b = new Browser(ctx); await b.login();
    const sub = await b.req("POST", "/api/v1/subscriptions", { url: `${host.url}/feed` });
    const p = (await b.req("GET", `/api/v1/podcasts/${sub.json.id}`)).json;
    assert.equal(p.medium, "audiobook"); assert.equal(p.locked, true);
    assert.equal(p.episodes.find((e: any) => e.title === "A").numbering, "The Return · Ch. 5");
    assert.equal(p.episodes.find((e: any) => e.title === "D").numbering, null);
  } finally { await ctx.stop(); await host.close(); }
});
