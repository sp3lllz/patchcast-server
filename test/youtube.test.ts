import { test } from "node:test";
import assert from "node:assert/strict";
import { channelId, matchVideo, parseYouTubeFeed, similarity, titleWords, watchUrl } from "../src/youtube.ts";

// F1 (WIP) matching rules. The apps will share these cases when they port the rules.
const ID = "UCabcdefghijklmnopqrstuv";

test("channel ids from ids, channel URLs and the channel RSS URL; handles are not resolved", () => {
  assert.equal(channelId(ID), ID);
  assert.equal(channelId(`https://www.youtube.com/channel/${ID}`), ID);
  assert.equal(channelId(`https://youtube.com/channel/${ID}/videos`), ID);
  assert.equal(channelId(`https://www.youtube.com/feeds/videos.xml?channel_id=${ID}`), ID);
  assert.equal(channelId("https://www.youtube.com/@somebody"), null);
  assert.equal(channelId(`https://evil.example.com/channel/${ID}`), null);
  assert.equal(channelId("nonsense"), null);
});

test("channel RSS is parsed", () => {
  const xml = `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><entry><yt:videoId>abcdefghijk</yt:videoId><title>Ep. 12 - Tom &amp; Jerry</title>
    <published>2026-11-20T10:00:00+00:00</published></entry><entry><yt:videoId>bad</yt:videoId><title>x</title></entry></feed>`;
  assert.deepEqual(parseYouTubeFeed(xml), [{ id: "abcdefghijk", title: "Ep. 12 - Tom & Jerry", published: Date.parse("2026-11-20T10:00:00Z") }]);
  assert.equal(watchUrl("abcdefghijk"), "https://www.youtube.com/watch?v=abcdefghijk");
});

test("titles: numbering prefixes, punctuation, case and filler words don't matter", () => {
  assert.deepEqual([...titleWords("#712: The Mac Pro Is Dead (Full Episode)")], ["mac", "pro", "dead"]);
  assert.equal(similarity("712: The Mac Pro is dead", "The Mac Pro Is Dead! | ATP"), 0.75);
  assert.equal(similarity("Café talk", "cafe TALK"), 1);
});

test("matching: date window, similarity threshold, best wins, then the closest date", () => {
  const d = Date.parse("2026-11-20T08:00:00Z"), DAY = 86_400_000;
  const vids = [
    { id: "aaaaaaaaaaa", title: "Mac Pro is dead", published: d + DAY },
    { id: "bbbbbbbbbbb", title: "The Mac Pro is dead (full episode)", published: d + 3 * DAY },
    { id: "ccccccccccc", title: "Something else entirely", published: d },
    { id: "ddddddddddd", title: "Mac Pro is dead", published: d + 30 * DAY },
  ];
  assert.equal(matchVideo({ title: "712: The Mac Pro Is Dead", pubDate: d }, vids)?.id, "aaaaaaaaaaa", "same similarity: closer date");
  assert.equal(matchVideo({ title: "Completely different topic", pubDate: d }, vids), null, "below 0.6");
  assert.equal(matchVideo({ title: "Mac Pro is dead", pubDate: d + 29 * DAY }, vids)?.id, "ddddddddddd");
  assert.equal(matchVideo({ title: "Mac Pro is dead", pubDate: d - 10 * DAY }, vids), null, "outside the window");
  assert.equal(matchVideo({ title: "Mac Pro is dead", pubDate: null }, vids)?.id, "aaaaaaaaaaa", "no date: exact title only");
});
