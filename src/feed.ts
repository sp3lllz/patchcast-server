import { Parser } from "htmlparser2";

export interface Chapter { startMs: number; title: string; image?: string | null; url?: string | null; endMs?: number | null; hidden?: boolean }
export interface ParsedEpisode {
  guid: string; title: string; description: string | null; audioUrl: string; mime: string | null; size: number | null;
  durationMs: number | null; pubDate: number | null; image: string | null; link: string | null; chaptersUrl: string | null;
  number: number | null; season: number | null; type: string | null; psc: Chapter[];
  /** podcast:transcript links (0.11); only present when the item has some, so older episodes' change hashes stay the same. */
  transcripts?: { url: string; type: string; language: string | null; rel: string | null }[];
  /** podcast:person on the item (0.11); only present when it has some. */
  persons?: Person[];
  /** podcast:alternateEnclosure (0.11); only present when it has some. */
  alternates?: Alternate[];
}
/** podcast:alternateEnclosure (0.11). Same rules in the apps (Alternates.swift / Alternates.kt). */
export interface Alternate { type: string; url: string; bitrate: number | null; height: number | null; length: number | null; title: string | null; isDefault: boolean }

/**
 * type required (lower case); url = the first http(s) podcast:source; bitrate/height/length positive integers or null; title trimmed
 * (≤ 60) or null; at most 10.
 */
export function parseAlternates(els: El[]): Alternate[] {
  const out: Alternate[] = [];
  const pos = (s: string | undefined) => { const n = Number(s); return Number.isFinite(n) && n > 0 ? Math.round(n) : null; };
  for (const e of els) {
    const type = (e.attrs.type ?? "").trim().toLowerCase();
    const url = e.children.filter((c) => c.name === "podcast:source").map((c) => httpUrl(c.attrs.uri)).find(Boolean) ?? null;
    if (!type || !url) continue;
    const title = decodeEntities(e.attrs.title ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || null;
    out.push({ type, url, bitrate: pos(e.attrs.bitrate), height: pos(e.attrs.height), length: pos(e.attrs.length), title, isDefault: e.attrs.default === "true" });
    if (out.length >= 10) break;
  }
  return out;
}

/** The video to offer: the first video alternate, preferring the tallest up to 1080 lines (then the smallest above). */
export function pickVideo(alts: Alternate[]): Alternate | null {
  const v = alts.filter((a) => a.type.startsWith("video/"));
  if (!v.length) return null;
  const ok = v.filter((a) => (a.height ?? 0) <= 1080).sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
  return ok[0] ?? [...v].sort((a, b) => (a.height ?? 0) - (b.height ?? 0))[0];
}
export interface ParsedFeed {
  title: string; description: string | null; author: string | null; image: string | null; link: string | null; episodes: ParsedEpisode[];
  /** podcast:person at feed level (0.11): the show's regular people; apply to every episode that has none of its own. */
  persons: Person[];
  /** podcast:funding (0.11): "Support the show" links. */
  funding: Funding[];
  /** podcast:guid (0.11): the show's identity that survives a change of feed URL. */
  guid: string | null;
}
/** podcast:guid: trimmed, lower case, 1–100 characters of letters, digits, "-", "_", ".", ":". Anything else is ignored. */
export function feedGuid(s: string | null | undefined): string | null {
  const t = (s ?? "").trim().toLowerCase();
  return /^[a-z0-9._:-]{1,100}$/.test(t) ? t : null;
}
/** podcast:funding (0.11). Same rules in the apps (Funding.swift / Funding.kt). */
export interface Funding { url: string; text: string }

/** http(s) URL required; label = the feed's text (trimmed, at most 60 characters) or "Support the show"; at most 5, no duplicate URLs. */
export function parseFunding(els: { attrs: Record<string, string>; text: string }[]): Funding[] {
  const out: Funding[] = [];
  for (const e of els) {
    const url = httpUrl(e.attrs.url);
    if (!url || out.some((f) => f.url === url)) continue;
    const t = decodeEntities(e.text).replace(/\s+/g, " ").trim();
    out.push({ url, text: t ? (t.length > 60 ? t.slice(0, 59).trimEnd() + "…" : t) : "Support the show" });
    if (out.length >= 5) break;
  }
  return out;
}
/** podcast:person (0.11). Same rules in the apps (Persons.swift / Persons.kt). */
export interface Person { name: string; role: string; group: string; img: string | null; href: string | null }

/** Name required; role defaults to "host", group to "cast" (lower case); img/href only http(s); at most 30, duplicates dropped. */
export function parsePersons(els: { attrs: Record<string, string>; text: string }[]): Person[] {
  const out: Person[] = [], seen = new Set<string>();
  for (const e of els) {
    const name = decodeEntities(e.text).replace(/\s+/g, " ").trim().slice(0, 120);
    if (!name) continue;
    const role = (e.attrs.role ?? "").trim().toLowerCase() || "host", group = (e.attrs.group ?? "").trim().toLowerCase() || "cast";
    const key = `${name.toLowerCase()}|${role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, role, group, img: httpUrl(e.attrs.img), href: httpUrl(e.attrs.href) });
    if (out.length >= 30) break;
  }
  return out;
}
export class FeedParseError extends Error {}

interface El { name: string; attrs: Record<string, string>; text: string; children: El[] }

/** Decodes by BOM, then the XML declaration, then the HTTP charset, then UTF-8. */
export function decodeXml(bytes: Buffer, contentType = ""): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  const head = bytes.subarray(0, 200).toString("latin1");
  const enc = /encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head)?.[1] ?? /charset=["']?([\w.:-]+)/i.exec(contentType)?.[1] ?? "utf-8";
  try { return new TextDecoder(enc).decode(bytes); } catch { return new TextDecoder("utf-8").decode(bytes); }
}

/** Entity decoding for text that was double-escaped in titles ("Tom &amp;amp; Jerry"). */
export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  let out = "";
  const p = new Parser({ ontext: (t) => { out += t; } }, { decodeEntities: true });
  p.write(s.replaceAll("<", "&lt;")); p.end();
  return out;
}
export const stripTags = (s: string) => decodeEntities(s.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

const local = (n: string) => n.slice(n.indexOf(":") + 1);
/** Namespace by declared URI where possible, else by conventional prefix. */
function nsOf(prefix: string, uris: Map<string, string>): string {
  const u = (uris.get(prefix) ?? "").toLowerCase();
  if (u.includes("itunes.com") || prefix === "itunes") return "itunes";
  if (u.includes("podcastindex") || u.includes("podcast-namespace") || prefix === "podcast") return "podcast";
  if (u.includes("modules/content") || prefix === "content") return "content";
  if (u.includes("yahoo.com/mrss") || prefix === "media") return "media";
  if (u.includes("simple-chapters") || prefix === "psc") return "psc";
  if (u.includes("purl.org/dc") || prefix === "dc") return "dc";
  if (u.includes("w3.org/2005/atom") || prefix === "atom") return "";
  if (prefix === "" || u.includes("rss/1.0") || u.includes("22-rdf")) return "";
  return "other";
}

export function parseFeed(xml: string): ParsedFeed {
  const t = xml.replace(/^﻿/, "").trimStart();
  if (!t.startsWith("<")) throw new FeedParseError("Response is not XML");
  if (/^<!doctype html|^<html/i.test(t.slice(0, 200))) throw new FeedParseError("URL returned a web page, not a podcast feed");
  const uris = new Map<string, string>();
  const episodes: ParsedEpisode[] = [];
  let root: string | null = null;
  const head: El = { name: "head", attrs: {}, text: "", children: [] };
  // Items are built one at a time and dropped, so memory stays proportional to one item, not the feed.
  const stack: El[] = [];
  let item: El | null = null;
  let depth = 0;
  const parser = new Parser({
    onopentag(rawName, attrs) {
      depth++;
      if (depth > 200) throw new FeedParseError("Malformed feed (too deeply nested)");
      for (const k in attrs) if (k === "xmlns" || k.startsWith("xmlns:")) uris.set(k === "xmlns" ? "" : k.slice(6), attrs[k]);
      const i = rawName.indexOf(":");
      const prefix = i >= 0 ? rawName.slice(0, i).toLowerCase() : "";
      const ln = local(rawName).toLowerCase();
      if (root === null) {
        if (!["rss", "rdf", "feed"].includes(ln)) throw new FeedParseError(`Unknown feed format <${rawName}>`);
        root = ln;
        return;
      }
      const ns = nsOf(prefix, uris);
      const el: El = { name: ns ? `${ns}:${ln}` : ln, attrs: Object.fromEntries(Object.entries(attrs).map(([k, v]) => [local(k).toLowerCase(), v])), text: "", children: [] };
      if (!item && (el.name === "item" || el.name === "entry")) { item = el; stack.length = 0; stack.push(el); return; }
      if (item) { stack[stack.length - 1]!.children.push(el); stack.push(el); return; }
      if (el.name === "channel") return;
      (stack[stack.length - 1] ?? head).children.push(el);
      stack.push(el);
    },
    ontext(s) { const el = stack[stack.length - 1]; if (el && el.text.length < 2_000_000) el.text += s; },
    onclosetag(rawName) {
      depth--;
      const ln = local(rawName).toLowerCase();
      if (item && stack.length === 1 && (ln === "item" || ln === "entry")) {
        const ep = root === "feed" ? atomEntry(item) : rssItem(item);
        if (ep) episodes.push(ep);
        item = null; stack.length = 0;
        return;
      }
      if (ln === "channel" && !item) { stack.length = 0; return; }
      if (stack.length) stack.pop();
    },
  }, { xmlMode: true, decodeEntities: true, recognizeSelfClosing: true });
  parser.write(t);
  // A truncated document leaves elements open; whatever is half-read must not be stored as a feed.
  const truncated = depth > 0 && !episodes.length;
  parser.end();
  if (truncated) throw new FeedParseError("Malformed feed (truncated)");
  if (!root) throw new FeedParseError("Empty document");
  const c = head.children;
  if (!episodes.length && !c.some((e) => e.name === "title" && e.text.trim())) throw new FeedParseError("Malformed feed (no title and no episodes)");
  const txt = (n: string) => c.find((e) => e.name === n && e.text.trim())?.text.trim() ?? null;
  const attr = (n: string, a: string) => c.find((e) => e.name === n && e.attrs[a])?.attrs[a] ?? null;
  if (root === "feed") {
    const author = c.find((e) => e.name === "author");
    return {
      title: clean(txt("title")) || "Untitled podcast", description: txt("subtitle"),
      author: txt("itunes:author") ?? author?.children.find((e) => e.name === "name")?.text.trim() ?? null,
      image: attr("itunes:image", "href") ?? txt("logo") ?? txt("icon"),
      link: c.find((e) => e.name === "link" && (e.attrs.rel ?? "alternate") === "alternate")?.attrs.href ?? null, episodes,
      persons: parsePersons(c.filter((e) => e.name === "podcast:person")),
      funding: parseFunding(c.filter((e) => e.name === "podcast:funding")),
      guid: feedGuid(txt("podcast:guid")),
    };
  }
  const rssImg = c.find((e) => e.name === "image")?.children.find((e) => e.name === "url")?.text.trim() ?? null;
  return {
    title: clean(txt("title")) || "Untitled podcast", description: txt("description") ?? txt("itunes:summary"),
    author: clean(txt("itunes:author") ?? txt("managingeditor") ?? txt("dc:creator")),
    image: (attr("itunes:image", "href") ?? rssImg ?? attr("media:thumbnail", "url"))?.trim() ?? null,
    link: c.find((e) => e.name === "link" && e.text.trim())?.text.trim() ?? null, episodes,
    persons: parsePersons(c.filter((e) => e.name === "podcast:person")),
    funding: parseFunding(c.filter((e) => e.name === "podcast:funding")),
    guid: feedGuid(txt("podcast:guid")),
  };
}

const clean = (s: string | null) => (s ? decodeEntities(s).trim() : s);
const int = (s: string | null | undefined) => { const n = Number((s ?? "").trim()); return s && Number.isInteger(n) ? n : null; };

function pick(item: El) {
  return {
    text: (n: string) => item.children.find((e) => e.name === n && e.text.trim())?.text.trim() ?? null,
    all: (n: string) => item.children.filter((e) => e.name === n),
    attr: (n: string, a: string) => item.children.find((e) => e.name === n && e.attrs[a])?.attrs[a]?.trim() ?? null,
  };
}

function rssItem(item: El): ParsedEpisode | null {
  const g = pick(item);
  const media = [...g.all("media:content"), ...g.all("media:group").flatMap((m) => m.children.filter((e) => e.name === "media:content"))];
  let enc: El | null = null;
  for (const e of g.all("enclosure")) {
    if (!e.attrs.url) continue;
    if (!enc || (!enc.attrs.type?.startsWith("audio") && e.attrs.type?.startsWith("audio"))) enc = e;
  }
  const mediaAudio = media.find((m) => m.attrs.url && (m.attrs.type?.startsWith("audio") || m.attrs.medium === "audio"));
  const audioUrl = (enc?.attrs.url ?? mediaAudio?.attrs.url)?.trim();
  if (!audioUrl) return null;
  const notes = [g.text("content:encoded"), g.text("description"), g.text("itunes:summary")].filter((s): s is string => !!s)
    .sort((a, b) => b.length - a.length)[0] ?? null;
  const size = int(enc?.attrs.length);
  return {
    guid: g.text("guid") || item.attrs.about || audioUrl,
    title: stripTags(g.text("title") ?? g.text("itunes:title") ?? "") || "Untitled episode",
    description: notes, audioUrl, mime: (enc ?? mediaAudio)?.attrs.type ?? null, size: size && size > 0 ? size : null,
    durationMs: parseDuration(g.text("itunes:duration")) ?? parseDuration(mediaAudio?.attrs.duration),
    pubDate: parseDate(g.text("pubdate")) ?? parseDate(g.text("dc:date")),
    image: g.attr("itunes:image", "href") ?? g.attr("media:thumbnail", "url") ?? media.find((m) => m.attrs.type?.startsWith("image") || m.attrs.medium === "image")?.attrs.url ?? null,
    link: g.text("link"), chaptersUrl: g.attr("podcast:chapters", "url"),
    number: int(g.text("itunes:episode")), season: int(g.text("itunes:season")),
    type: g.text("itunes:episodetype")?.toLowerCase() ?? null,
    ...transcriptLinks(g.all("podcast:transcript")),
    ...itemPersons(g.all("podcast:person")),
    ...itemAlternates(g.all("podcast:alternateenclosure")),
    psc: normalizeChapters(g.all("psc:chapters").flatMap((e) => e.children).filter((e) => e.name === "psc:chapter").flatMap((e) => {
      const start = parseNpt(e.attrs.start);
      return start == null ? [] : [{ startMs: start, title: decodeEntities(e.attrs.title ?? ""), url: httpUrl(e.attrs.href), image: httpUrl(e.attrs.image) }];
    })),
  };
}

function atomEntry(item: El): ParsedEpisode | null {
  const g = pick(item);
  const links = g.all("link");
  const enc = links.find((l) => l.attrs.rel === "enclosure" && l.attrs.href);
  if (!enc) return null;
  const notes = [g.text("content"), g.text("summary")].filter((s): s is string => !!s).sort((a, b) => b.length - a.length)[0] ?? null;
  return {
    guid: g.text("id") || enc.attrs.href, title: stripTags(g.text("title") ?? "") || "Untitled episode", description: notes,
    audioUrl: enc.attrs.href.trim(), mime: enc.attrs.type ?? null, size: int(enc.attrs.length), durationMs: parseDuration(g.text("itunes:duration")),
    pubDate: parseDate(g.text("published")) ?? parseDate(g.text("updated")), image: g.attr("itunes:image", "href"),
    link: links.find((l) => (l.attrs.rel ?? "alternate") === "alternate")?.attrs.href ?? null, chaptersUrl: g.attr("podcast:chapters", "url"),
    number: null, season: null, type: g.text("itunes:episodetype")?.toLowerCase() ?? null, psc: [],
    ...transcriptLinks(g.all("podcast:transcript")),
    ...itemPersons(g.all("podcast:person")),
    ...itemAlternates(g.all("podcast:alternateenclosure")),
  };
}

function itemAlternates(els: El[]): { alternates?: Alternate[] } {
  const list = parseAlternates(els);
  return list.length ? { alternates: list } : {};
}

function itemPersons(els: El[]): { persons?: Person[] } {
  const list = parsePersons(els);
  return list.length ? { persons: list } : {};
}

function transcriptLinks(els: El[]): { transcripts?: ParsedEpisode["transcripts"] } {
  const list = els.flatMap((e) => {
    const url = httpUrl(e.attrs.url);
    return url ? [{ url, type: (e.attrs.type ?? "").trim().toLowerCase(), language: e.attrs.language?.trim() || null, rel: e.attrs.rel?.trim() || null }] : [];
  }).slice(0, 10);
  return list.length ? { transcripts: list } : {};
}

export const httpUrl = (s: string | null | undefined) => (s && /^https?:\/\//i.test(s.trim()) ? s.trim() : null);

export function parseDuration(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = s.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 1000) || null;
  if (/^\d+(:\d+){1,2}(\.\d+)?$/.test(t)) return Math.round(t.split(":").reduce((a, p) => a * 60 + Number(p), 0) * 1000) || null;
  let total = 0, hit = false;
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(h|m|s)/g)) { hit = true; total += Number(m[1]) * { h: 3600, m: 60, s: 1 }[m[2] as "h" | "m" | "s"]; }
  return hit && total > 0 ? Math.round(total * 1000) : null;
}

export function parseDate(s: string | null | undefined): number | null {
  if (!s) return null;
  let t = s.trim().replace(/\s+/g, " ").replace(/^[A-Za-z]{3,9}\.?, ?/, "");
  t = t.replace(/\b(BST|CEST|CET)\b/, (z) => ({ BST: "+0100", CET: "+0100", CEST: "+0200" })[z]!);
  // Offset-less ISO timestamps are read as UTC.
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(t)) t += "Z";
  else if (/\d{2}:\d{2}(:\d{2})?$/.test(t)) t += " UTC";
  const n = Date.parse(t);
  return Number.isFinite(n) ? n : null;
}

export function parseNpt(s: string | null | undefined): number | null {
  if (!s || !/^[\d:.]+$/.test(s.trim())) return null;
  const n = s.trim().split(":").reduce((a, p) => a * 60 + Number(p), 0);
  return Number.isFinite(n) ? Math.round(n * 1000) : null;
}

export function normalizeChapters(list: Chapter[]): Chapter[] {
  const seen = new Set<number>();
  return list.filter((c) => c.startMs >= 0).sort((a, b) => a.startMs - b.startMs)
    .filter((c) => !seen.has(c.startMs) && seen.add(c.startMs)).slice(0, 1000)
    .map((c, i) => ({ ...c, title: c.title.trim() || `Chapter ${i + 1}` }));
}

/** Podcasting 2.0 JSON chapters. */
export function parseJsonChapters(text: string): Chapter[] {
  const root = JSON.parse(text.replace(/^﻿/, "").trim());
  if (!Array.isArray(root?.chapters)) return [];
  return normalizeChapters(root.chapters.flatMap((c: any) => {
    const start = Number(c?.startTime);
    if (!Number.isFinite(start) || start < 0) return [];
    const end = Number(c.endTime);
    return [{ startMs: Math.round(start * 1000), title: String(c.title ?? ""), image: httpUrl(c.img), url: httpUrl(c.url),
      endMs: Number.isFinite(end) && end > start ? Math.round(end * 1000) : null, hidden: c.toc === false }];
  }));
}
