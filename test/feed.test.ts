import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeXml, parseDate, parseDuration, parseFeed, parseJsonChapters } from "../src/feed.ts";
import { parseTag, readTag, sniffImage, tagSize } from "../src/id3.ts";
import { parseOpml, writeOpml } from "../src/opml.ts";
import { enclosureKey, feedKey, normalizeFeedUrl } from "../src/urls.ts";
import { notes } from "../src/app.ts";

const fixture = (n: string) => readFileSync(new URL(`fixtures/feeds/${n}`, import.meta.url));

test("parses the sample feed fixtures", () => {
  for (const f of ["bbc_style.xml", "libsyn_style.xml", "megaphone_style.xml", "npr_style.xml", "atom_style.xml", "chapters_psc.xml" ]) {
    const p = parseFeed(decodeXml(fixture(f)));
    assert.ok(p.title && p.title !== "Untitled podcast", f);
    assert.ok(p.episodes.length > 0, f);
    for (const e of p.episodes) assert.ok(e.guid && e.title && /^https?:/.test(e.audioUrl), `${f}: ${e.title}`);
  }
  assert.throws(() => parseFeed(fixture("not_a_feed.html").toString()), /web page/);
  assert.throws(() => parseFeed(decodeXml(fixture("malformed.xml"))), /Malformed/);
  assert.throws(() => parseFeed("hello"), /not XML/);
  assert.ok(parseFeed(decodeXml(fixture("chapters_psc.xml"))).episodes.some((e) => e.psc.length > 1));
});

test("durations, dates, JSON chapters", () => {
  assert.equal(parseDuration("1:02:03"), 3723000); assert.equal(parseDuration("45:30"), 2730000); assert.equal(parseDuration("90"), 90000);
  assert.equal(parseDuration("1h 5m"), 3900000); assert.equal(parseDuration(""), null);
  assert.equal(parseDate("Fri, 20 Nov 2026 21:07:00 GMT"), Date.UTC(2026, 10, 20, 21, 7));
  assert.equal(parseDate("2026-11-20T21:07:00Z"), Date.UTC(2026, 10, 20, 21, 7));
  assert.equal(parseDate("Fri, 20 Nov 2026 21:07:00 +0100"), Date.UTC(2026, 10, 20, 20, 7));
  assert.equal(parseDate("nonsense"), null);
  const c = parseJsonChapters('{"chapters":[{"startTime":10.5,"title":"B","img":"javascript:x"},{"startTime":0,"toc":false}]}');
  assert.deepEqual(c.map((x) => [x.startMs, x.title, x.image ?? null, !!x.hidden]), [[0, "Chapter 1", null, true], [10500, "B", null, false]]);
});

const ss = (n: number) => Buffer.from([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]);
const frame = (id: string, body: Buffer) => Buffer.concat([Buffer.from(id), ss(body.length), Buffer.from([0, 0]), body]);
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 7)]);
const apic = Buffer.concat([Buffer.from([0]), Buffer.from("image/jpeg\0"), Buffer.from([3, 0]), JPG]);
const chap = (id: string, a: number, b: number, title: string, img = false) => frame("CHAP", Buffer.concat([Buffer.from(id + "\0"), u32(a), u32(b), u32(0xffffffff), u32(0xffffffff),
  frame("TIT2", Buffer.concat([Buffer.from([3]), Buffer.from(title)])), ...(img ? [frame("APIC", apic)] : [])]));
const tag = (...f: Buffer[]) => { const b = Buffer.concat(f); return Buffer.concat([Buffer.from("ID3"), Buffer.from([4, 0, 0]), ss(b.length), b]); };

test("ID3 CHAP/CTOC/APIC", async () => {
  const t = tag(frame("CTOC", Buffer.concat([Buffer.from("toc\0"), Buffer.from([3, 2]), Buffer.from("c1\0c2\0")])), chap("c2", 60000, 90000, "Zwei ü"), chap("c1", 0, 60000, "One", true), frame("APIC", apic));
  assert.equal(tagSize(t), t.length);
  const r = parseTag(t);
  assert.deepEqual(r.chapters.map((c) => [c.startMs, c.title, c.image?.length ?? 0]), [[0, "One", JPG.length], [60000, "Zwei ü", 0]]);
  assert.equal(sniffImage(r.cover!)?.mime, "image/jpeg");
  assert.equal(sniffImage(Buffer.from("<svg onload=alert(1)>.............")), null);
  const file = Buffer.concat([t, Buffer.alloc(5000, 1)]);
  const asked: number[][] = [];
  assert.ok((await readTag(async (a, b) => { asked.push([a, b]); return file.subarray(a, b + 1); }))!.equals(t));
  assert.deepEqual(asked, [[0, 9], [0, t.length - 1]]);
  assert.equal(await readTag(async () => Buffer.from("no tag here at all")), null);
});

test("ID3 parser survives truncation and random corruption", () => {
  const t = tag(chap("c1", 0, 60000, "One", true), chap("c2", 60000, 90000, "Two"), frame("APIC", apic));
  for (let i = 0; i < t.length; i++) parseTag(t.subarray(0, i));
  let seed = 1; const rnd = () => (seed = (seed * 16807) % 2147483647);
  for (let i = 0; i < 3000; i++) { const b = Buffer.from(t); for (let k = 0; k < 8; k++) b[10 + (rnd() % (b.length - 10))] = rnd() & 255; parseTag(b); }
});

test("feed identity matches the app's rules", () => {
  assert.equal(feedKey("https://WWW.Example.com/Feed/"), "example.com/Feed");
  assert.equal(feedKey("http://example.com/Feed"), feedKey("https://www.example.com/Feed/"));
  assert.equal(normalizeFeedUrl("feed://x.com/a b"), "https://x.com/a%20b"); assert.equal(normalizeFeedUrl("http://x.com/a"), "https://x.com/a");
  assert.equal(normalizeFeedUrl("ftp://x.com"), null); assert.equal(normalizeFeedUrl("x.com/feed"), "https://x.com/feed"); assert.equal(normalizeFeedUrl(""), null);
  assert.equal(enclosureKey("https://cdn.x.com/a.mp3?t=1"), enclosureKey("http://CDN.x.com/a.mp3?t=2"));
});

test("OPML round trip and tolerance", () => {
  const items = [{ title: 'A & "B" <c>', url: "https://x.com/?a=1&b=2" }];
  assert.deepEqual(parseOpml(writeOpml(items)), [{ url: items[0].url, title: items[0].title }]);
  assert.equal(parseOpml(readFileSync(new URL("fixtures/opml/sloppy.opml", import.meta.url), "utf8")).length > 0, true);
});

test("show notes are sanitised", () => {
  const h = notes('<p onclick="x()">Hi <script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">bad</a> <a href="https://ok.com" style="x">ok</a><svg/onload=alert(1)><iframe src="//e"></iframe></p>');
  assert.doesNotMatch(h, /script|onerror|onclick|javascript|img|svg|iframe|style=/i);
  assert.match(h, /<a href="https:\/\/ok\.com" target="_blank" rel="noopener noreferrer nofollow">ok<\/a>/);
  assert.match(notes("line1\nhttps://a.com/x <3"), /line1<br \/><a href="https:\/\/a\.com\/x"/);
});
