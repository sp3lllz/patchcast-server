import { decodeEntities, parseDate } from "./feed.ts";

/**
 * v0.11.0 F1 "Watch on YouTube" — matching rules (WIP: not wired into the database, API or clients yet; see the app repo's
 * docs/PROGRESS-0.11.0.md). Decided by Patch: a plain link that opens YouTube, no embedded player, no stream extraction,
 * no API key: a channel's public RSS (https://www.youtube.com/feeds/videos.xml?channel_id=UC…) is matched to episodes by
 * title and date. The apps will port these rules (as with transcripts) so matching also works without a server.
 */
export interface YouTubeVideo { id: string; title: string; published: number | null }

const CHANNEL_ID = /^UC[\w-]{22}$/;

/** A channel id from what a person pastes or a feed declares: the id itself, a /channel/UC… URL, or the channel's RSS URL. */
export function channelId(input: string | null | undefined): string | null {
  const s = (input ?? "").trim();
  if (CHANNEL_ID.test(s)) return s;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (!/(^|\.)youtube\.com$/i.test(u.hostname)) return null;
  const q = u.searchParams.get("channel_id");
  if (q && CHANNEL_ID.test(q)) return q;
  const m = /^\/channel\/(UC[\w-]{22})(\/|$)/.exec(u.pathname);
  return m ? m[1] : null; // @handles need a page fetch to resolve: not supported (ask for the channel URL instead)
}

export const channelFeedUrl = (id: string) => `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`;
export const watchUrl = (videoId: string) => `https://www.youtube.com/watch?v=${videoId}`;

/** The channel RSS (Atom): <entry><yt:videoId>…</yt:videoId><title>…</title><published>…</published></entry>. */
export function parseYouTubeFeed(xml: string): YouTubeVideo[] {
  const out: YouTubeVideo[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const id = /<yt:videoId>([\w-]{11})<\/yt:videoId>/.exec(e)?.[1];
    const title = /<title>([\s\S]*?)<\/title>/.exec(e)?.[1];
    if (!id || !title) continue;
    const pub = /<published>([^<]+)<\/published>/.exec(e)?.[1]?.trim();
    const at = pub ? Date.parse(pub) : NaN; // ISO 8601 with offset (YouTube); the feed parser's parseDate is for RSS dates
    out.push({ id, title: decodeEntities(title).trim(), published: Number.isFinite(at) ? at : parseDate(pub) });
  }
  return out;
}

/** Lower case words without punctuation, episode-number prefixes ("#12", "Ep. 12 -", "12:") and filler words. */
export function titleWords(t: string): Set<string> {
  const s = t.toLowerCase()
    .replace(/^\s*(?:#\s*\d+|(?:ep(?:isode)?\.?|no\.?)\s*\d+|\d+)\s*[:.\-–—|]\s*/i, "")
    .replace(/\((?:official )?(?:video|audio|full episode|podcast)\)|\[(?:video|audio|full episode|podcast)\]/g, " ")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ");
  return new Set(s.split(" ").filter((w) => w.length > 1 && !STOP.has(w)));
}
const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "with", "for", "is", "it", "at", "by", "from", "ft", "feat"]);

export function similarity(a: string, b: string): number {
  const x = titleWords(a), y = titleWords(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both); // Jaccard
}

const DAY = 86_400_000;
/**
 * The video for an episode: published from 2 days before to 7 days after the episode, title similarity ≥ 0.6; the best
 * similarity wins, then the closest date. Without an episode date only an exact title match (similarity 1) counts.
 */
export function matchVideo(episode: { title: string; pubDate: number | null }, videos: YouTubeVideo[]): YouTubeVideo | null {
  let best: { v: YouTubeVideo; sim: number; gap: number } | null = null;
  for (const v of videos) {
    const sim = similarity(episode.title, v.title);
    let gap = 0;
    if (episode.pubDate != null && v.published != null) {
      gap = v.published - episode.pubDate;
      if (gap < -2 * DAY || gap > 7 * DAY) continue;
    } else if (sim < 1) continue;
    if (sim < 0.6) continue;
    if (!best || sim > best.sim || (sim === best.sim && Math.abs(gap) < Math.abs(best.gap))) best = { v, sim, gap };
  }
  return best?.v ?? null;
}
