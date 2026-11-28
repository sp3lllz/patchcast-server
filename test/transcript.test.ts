import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Browser, serve, withAdmin, type Ctx } from "./helpers.ts";
import { joinLines, parseTimestamp, parseTranscript, pickTranscript, transcriptKind } from "../src/transcript.ts";
import { parseFeed } from "../src/feed.ts";
import { Db } from "../src/db.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a 0.10 database (user_version 5) gains the transcript columns and keeps its episodes", () => {
  const dir = mkdtempSync(join(tmpdir(), "pcs-"));
  try {
    Db.open(dir).close();
    const raw = new DatabaseSync(join(dir, "patchcast.db"));
    raw.exec(`ALTER TABLE feeds DROP COLUMN persons; ALTER TABLE episodes DROP COLUMN persons; ALTER TABLE episodes DROP COLUMN transcripts; ALTER TABLE episodes DROP COLUMN transcript; ALTER TABLE episodes DROP COLUMN transcript_source; PRAGMA user_version=5;
      INSERT INTO feeds(id,key,url,title) VALUES(1,'example.com/f','https://example.com/f','F');
      INSERT INTO episodes(feed_id,guid,title,audio_url,first_seen,chapters,chapters_source) VALUES(1,'g','Old','https://example.com/a.mp3',1,'[]','none');`);
    raw.close();
    const db = Db.open(dir);
    assert.equal((db.get("PRAGMA user_version") as any).user_version, 7);
    const e = db.get("SELECT title, chapters_source, transcripts, transcript FROM episodes WHERE guid='g'")!;
    assert.deepEqual({ ...e }, { title: "Old", chapters_source: "none", transcripts: null, transcript: null });
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The same cases are in the apps' tests (Android TranscriptsTest, PatchcastCore TranscriptTests): keep them in step.
export const VTT = `WEBVTT

00:00:00.000 --> 00:00:02.500
<v Alice>Hello and welcome

00:00:02.600 --> 00:00:05.000
<v Alice>to the show.

00:00:05.100 --> 00:00:07.000
<v Bob>Thanks, Alice!

01:02:03.450 --> 01:02:05.000
<v Bob>Much later &amp; louder.
`;

describe("transcript parsing", () => {
  test("diarisation labels read as Speaker n (from 1); names are kept", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v SPEAKER_00>Hi.\n\n00:00:09.000 --> 00:00:10.000\n<v spk_1>Hello.\n\n00:00:19.000 --> 00:00:20.000\n<v Dr. Who>Yes.\n";
    assert.deepEqual(parseTranscript(vtt, "vtt").lines.map((l) => l.speaker), ["Speaker 1", "Speaker 2", "Dr. Who"]);
  });

  test("timestamps", () => {
    assert.equal(parseTimestamp("00:00:02.500"), 2500);
    assert.equal(parseTimestamp("01:02:03,45"), 3_723_450);
    assert.equal(parseTimestamp("02:03"), 123_000);
    assert.equal(parseTimestamp("nope"), null);
  });

  test("WebVTT: voices become speakers, short cues of one speaker join, entities decode", () => {
    const t = parseTranscript(VTT, "vtt");
    assert.equal(t.timed, true);
    assert.deepEqual(t.lines.map((l) => [l.startMs, l.speaker, l.text]), [
      [0, "Alice", "Hello and welcome to the show."],
      [5100, "Bob", "Thanks, Alice!"],
      [3_723_450, "Bob", "Much later & louder."],
    ]);
    assert.equal(t.lines[0].endMs, 5000);
  });

  test("SRT with SPEAKER: prefixes and CRLF", () => {
    const srt = "1\r\n00:00:01,000 --> 00:00:03,000\r\nHOST: Good morning.\r\n\r\n2\r\n00:00:10,000 --> 00:00:12,000\r\nGUEST: Hi there.\r\n";
    const t = parseTranscript(srt, transcriptKind("application/x-subrip"));
    assert.deepEqual(t.lines.map((l) => [l.startMs, l.speaker, l.text]), [[1000, "HOST", "Good morning."], [10_000, "GUEST", "Hi there."]]);
  });

  test("Podcast Index JSON", () => {
    const json = JSON.stringify({ version: "1.0.0", segments: [
      { speaker: "Ann", startTime: 0.5, endTime: 1.5, body: "One" }, { speaker: "Ann", startTime: 1.6, endTime: 2, body: "two" },
      { startTime: 30, endTime: 31, body: "Three" }, { startTime: "x", body: "bad" }] });
    const t = parseTranscript(json, "json");
    assert.deepEqual(t.lines.map((l) => [l.startMs, l.speaker, l.text]), [[500, "Ann", "One two"], [30_000, null, "Three"]]);
  });

  test("HTML and plain text are untimed paragraphs", () => {
    const h = parseTranscript("<html><body><p>First <b>para</b>.</p><p>Second&nbsp;one</p><script>x()</script></body></html>", "html");
    assert.equal(h.timed, false);
    assert.deepEqual(h.lines.map((l) => l.text), ["First para.", "Second one"]);
    const p = parseTranscript("Para one\nstill one.\n\nPara two.", "text");
    assert.deepEqual(p.lines.map((l) => l.text), ["Para one still one.", "Para two."]);
  });

  test("joining stops at a speaker change, a long pause, or length", () => {
    const L = (s: number, e: number, t: string, sp: string | null = null) => ({ startMs: s, endMs: e, speaker: sp, text: t });
    assert.equal(joinLines([L(0, 1000, "a"), L(1500, 2000, "b")]).length, 1);
    assert.equal(joinLines([L(0, 1000, "a"), L(4000, 5000, "b")]).length, 2); // 3 s pause
    assert.equal(joinLines([L(0, 1000, "a", "X"), L(1000, 2000, "b", "Y")]).length, 2);
    assert.equal(joinLines([L(0, 1000, "x".repeat(200)), L(1000, 2000, "y".repeat(100))]).length, 2);
    assert.equal(joinLines([L(0, 1000, "x".repeat(130) + "."), L(1000, 2000, "y".repeat(20))]).length, 2); // sentence done, ≥ 140
  });

  test("the best link wins: VTT > SRT > JSON > HTML > text; unknown types skipped", () => {
    const l = (type: string, url = "https://example.com/t") => ({ url, type, language: null, rel: null });
    assert.equal(pickTranscript([l("text/html"), l("application/json"), l("text/vtt")])?.type, "text/vtt");
    assert.equal(pickTranscript([l("text/plain"), l("application/srt")])?.type, "application/srt");
    assert.equal(pickTranscript([l("audio/mpeg")]), null);
    assert.equal(transcriptKind("", "https://example.com/ep1.vtt?x=1"), "vtt");
  });

  test("feed parsing reads podcast:transcript, only when present", () => {
    const f = parseFeed(`<rss xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><title>T</title>
      <item><guid>a</guid><title>A</title><enclosure url="https://example.com/a.mp3" type="audio/mpeg"/>
        <podcast:transcript url="https://example.com/a.vtt" type="text/vtt" language="en"/>
        <podcast:transcript url="https://example.com/a.json" type="application/json" rel="captions"/>
        <podcast:transcript url="ftp://bad" type="text/vtt"/></item>
      <item><guid>b</guid><title>B</title><enclosure url="https://example.com/b.mp3" type="audio/mpeg"/></item></channel></rss>`);
    assert.deepEqual(f.episodes[0].transcripts, [
      { url: "https://example.com/a.vtt", type: "text/vtt", language: "en", rel: null },
      { url: "https://example.com/a.json", type: "application/json", language: null, rel: "captions" }]);
    assert.equal("transcripts" in f.episodes[1], false);
  });
});

describe("transcript API", () => {
  let ctx: Ctx, host: Awaited<ReturnType<typeof serve>>, hits = 0;
  before(async () => {
    host = await serve((req, res) => {
      if (req.url === "/feed") {
        res.setHeader("content-type", "application/rss+xml");
        res.end(`<rss xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><title>Talk</title>
          <item><guid>t1</guid><title>With</title><enclosure url="${host.url}/1.mp3" type="audio/mpeg"/><podcast:transcript url="${host.url}/1.vtt" type="text/vtt"/></item>
          <item><guid>t2</guid><title>Without</title><enclosure url="${host.url}/2.mp3" type="audio/mpeg"/></item>
          <item><guid>t3</guid><title>Broken</title><enclosure url="${host.url}/3.mp3" type="audio/mpeg"/><podcast:transcript url="${host.url}/missing.vtt" type="text/vtt"/></item>
          </channel></rss>`);
      } else if (req.url === "/1.vtt") { hits++; res.setHeader("content-type", "text/vtt"); res.end(VTT); }
      else { res.statusCode = 404; res.end(); }
    });
    ctx = await withAdmin({ SSRF_ALLOW_HOSTS: host.host });
  });
  after(async () => { await ctx.stop(); await host.close(); });

  test("episodes say whether they have one; the transcript is parsed once and cached", async () => {
    const b = new Browser(ctx); await b.login();
    const sub = await b.req("POST", "/api/v1/subscriptions", { url: `${host.url}/feed` });
    const eps = (await b.req("GET", `/api/v1/podcasts/${sub.json.id}`)).json.episodes as any[];
    const by = (t: string) => eps.find((e) => e.title === t);
    assert.equal(by("With").hasTranscript, true);
    assert.equal(by("Without").hasTranscript, false);
    const r = await b.req("GET", `/api/v1/episodes/${by("With").id}/transcript`);
    assert.equal(r.status, 200);
    assert.equal(r.json.timed, true); assert.equal(r.json.source, "vtt");
    assert.equal(r.json.lines[0].text, "Hello and welcome to the show.");
    await b.req("GET", `/api/v1/episodes/${by("With").id}/transcript`);
    assert.equal(hits, 1, "cached after the first fetch");
    assert.equal((await b.req("GET", `/api/v1/episodes/${by("Without").id}/transcript`)).json.error, "no_transcript");
    const broken = await b.req("GET", `/api/v1/episodes/${by("Broken").id}/transcript`);
    assert.equal(broken.status, 404);
  });

  test("only for subscribers", async () => {
    const other = new Browser(ctx, "203.0.113.9");
    ctx.db.run("INSERT INTO users(username,pw_hash,is_admin,created_at) VALUES('eve','',0,?)", Date.now());
    ctx.db.run("INSERT INTO identities(issuer,sub,user_id,linked_at) SELECT ?, 'eve-sub', id, ? FROM users WHERE username='eve'", ctx.config.oidc.issuer, Date.now());
    await other.login("eve");
    const id = ctx.db.get("SELECT id FROM episodes WHERE guid='t1'")!.id;
    assert.equal((await other.req("GET", `/api/v1/episodes/${id}/transcript`)).status, 404);
  });
});
