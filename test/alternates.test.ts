import { test } from "node:test";
import assert from "node:assert/strict";
import { Browser, serve, withAdmin } from "./helpers.ts";
import { parseFeed, pickVideo } from "../src/feed.ts";

// Same cases as Android AlternatesTest and PatchcastCore AlternatesTests.
const ITEM = `<item><guid>1</guid><title>A</title><enclosure url="https://example.com/1.mp3" type="audio/mpeg"/>
  <podcast:alternateEnclosure type="audio/aac" length="1022980" bitrate="32000" title="Low bitrate AAC"><podcast:source uri="https://example.com/1.m4a"/></podcast:alternateEnclosure>
  <podcast:alternateEnclosure type="Video/MP4" height="2160" title="4K"><podcast:source uri="https://example.com/4k.mp4"/></podcast:alternateEnclosure>
  <podcast:alternateEnclosure type="video/mp4" height="720"><podcast:source uri="ipfs://x"/><podcast:source uri="https://example.com/720.mp4"/></podcast:alternateEnclosure>
  <podcast:alternateEnclosure type="video/mp4" height="1080" default="true"><podcast:source uri="https://example.com/1080.mp4"/></podcast:alternateEnclosure>
  <podcast:alternateEnclosure type="audio/opus"><podcast:source uri="ftp://nope"/></podcast:alternateEnclosure>
  <podcast:alternateEnclosure><podcast:source uri="https://example.com/notype"/></podcast:alternateEnclosure></item>`;
const FEED = `<rss xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><title>T</title>${ITEM}
  <item><guid>2</guid><title>B</title><enclosure url="https://example.com/2.mp3"/></item></channel></rss>`;

test("podcast:alternateEnclosure: first http source, numbers, defaults; the video offered is the tallest up to 1080", () => {
  const f = parseFeed(FEED);
  const a = f.episodes[0].alternates!;
  assert.deepEqual(a.map((x) => [x.type, x.url, x.bitrate, x.height, x.isDefault]), [
    ["audio/aac", "https://example.com/1.m4a", 32000, null, false],
    ["video/mp4", "https://example.com/4k.mp4", null, 2160, false],
    ["video/mp4", "https://example.com/720.mp4", null, 720, false],
    ["video/mp4", "https://example.com/1080.mp4", null, 1080, true]]);
  assert.equal(a[0].title, "Low bitrate AAC");
  assert.equal(pickVideo(a)?.url, "https://example.com/1080.mp4");
  assert.equal(pickVideo(a.filter((x) => x.height === 2160))?.url, "https://example.com/4k.mp4", "only a 4K one: offer it");
  assert.equal(pickVideo(a.filter((x) => x.type.startsWith("audio"))), null);
  assert.equal("alternates" in f.episodes[1], false);
});

test("episodes carry their alternates and the video to offer", async () => {
  const host = await serve((req, res) => { if (req.url === "/feed") { res.setHeader("content-type", "application/rss+xml"); res.end(FEED); } else { res.statusCode = 404; res.end(); } });
  const ctx = await withAdmin({ SSRF_ALLOW_HOSTS: host.host });
  try {
    const b = new Browser(ctx); await b.login();
    const sub = await b.req("POST", "/api/v1/subscriptions", { url: `${host.url}/feed` });
    const eps = (await b.req("GET", `/api/v1/podcasts/${sub.json.id}`)).json.episodes;
    const a = (await b.req("GET", `/api/v1/episodes/${eps.find((e: any) => e.title === "A").id}`)).json;
    assert.equal(a.alternates.length, 4);
    assert.equal(a.video.height, 1080);
    const bb = (await b.req("GET", `/api/v1/episodes/${eps.find((e: any) => e.title === "B").id}`)).json;
    assert.equal(bb.video, null);
  } finally { await ctx.stop(); await host.close(); }
});
