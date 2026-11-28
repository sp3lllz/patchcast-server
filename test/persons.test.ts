import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Browser, serve, withAdmin, type Ctx } from "./helpers.ts";
import { parseFeed, parsePersons } from "../src/feed.ts";

// Same cases as Android PersonsTest and PatchcastCore PersonsTests.
export const FEED = (base = "https://example.com") => `<rss xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><title>Show</title>
  <podcast:person role="host" img="${base}/ann.jpg" href="https://ann.example.com">Ann Host</podcast:person>
  <podcast:person>Bob &amp; Co</podcast:person>
  <item><guid>1</guid><title>With guest</title><enclosure url="${base}/1.mp3" type="audio/mpeg"/>
    <podcast:person role="Guest" group="cast" img="javascript:alert(1)" href="ftp://x">Cat Guest</podcast:person>
    <podcast:person role="host">Ann Host</podcast:person><podcast:person role="host">Ann Host</podcast:person><podcast:person> </podcast:person></item>
  <item><guid>2</guid><title>Plain</title><enclosure url="${base}/2.mp3" type="audio/mpeg"/></item></channel></rss>`;

describe("podcast:person", () => {
  test("parsing: defaults, lower-case roles, only http links, no blanks or duplicates, at most 30", () => {
    const f = parseFeed(FEED());
    assert.deepEqual(f.persons, [
      { name: "Ann Host", role: "host", group: "cast", img: "https://example.com/ann.jpg", href: "https://ann.example.com" },
      { name: "Bob & Co", role: "host", group: "cast", img: null, href: null }]);
    assert.deepEqual(f.episodes[0].persons, [
      { name: "Cat Guest", role: "guest", group: "cast", img: null, href: null },
      { name: "Ann Host", role: "host", group: "cast", img: null, href: null }]);
    assert.equal("persons" in f.episodes[1], false);
    const many = Array.from({ length: 40 }, (_, i) => ({ attrs: {}, text: `P${i}` }));
    assert.equal(parsePersons(many).length, 30);
  });

  describe("API", () => {
    let ctx: Ctx, host: Awaited<ReturnType<typeof serve>>;
    before(async () => {
      host = await serve((req, res) => { if (req.url === "/feed") { res.setHeader("content-type", "application/rss+xml"); res.end(FEED(host.url)); } else { res.statusCode = 404; res.end(); } });
      ctx = await withAdmin({ SSRF_ALLOW_HOSTS: host.host });
    });
    after(async () => { await ctx.stop(); await host.close(); });

    test("the show's people on the podcast; an episode's own people, else the show's; pictures via the art proxy", async () => {
      const b = new Browser(ctx); await b.login();
      const sub = await b.req("POST", "/api/v1/subscriptions", { url: `${host.url}/feed` });
      const p = (await b.req("GET", `/api/v1/podcasts/${sub.json.id}`)).json;
      assert.deepEqual(p.persons.map((x: any) => x.name), ["Ann Host", "Bob & Co"]);
      assert.match(p.persons[0].img, /^\/api\/v1\/art\//);
      const by = (t: string) => p.episodes.find((e: any) => e.title === t).id;
      const guest = (await b.req("GET", `/api/v1/episodes/${by("With guest")}`)).json;
      assert.deepEqual(guest.persons.map((x: any) => `${x.name}/${x.role}`), ["Cat Guest/guest", "Ann Host/host"]);
      const plain = (await b.req("GET", `/api/v1/episodes/${by("Plain")}`)).json;
      assert.deepEqual(plain.persons.map((x: any) => x.name), ["Ann Host", "Bob & Co"]);
    });
  });
});
