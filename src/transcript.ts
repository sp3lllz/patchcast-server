import { decodeEntities } from "./feed.ts";

/**
 * Podcasting 2.0 transcripts (podcast:transcript). The same rules live in the apps (Android `Transcripts.kt`,
 * PatchcastCore `Transcripts.swift`): change all three together.
 *
 * A transcript is a list of lines. Timed formats (WebVTT, SRT, JSON) give each line a start (and usually an end) so a
 * tap can seek and the view can follow playback; HTML and plain text are untimed paragraphs.
 */
export interface TranscriptLink { url: string; type: string; language: string | null; rel: string | null }
export interface TranscriptLine { startMs: number | null; endMs: number | null; speaker: string | null; text: string }
export interface Transcript { timed: boolean; lines: TranscriptLine[] }

export const MAX_LINES = 20_000;
/** Lines built from short caption cues are joined up to about this many characters (same speaker, no long pause). */
const JOIN_CHARS = 280, JOIN_GAP_MS = 2_000;

/** Which kind a transcript link is, from its MIME type or file name. */
export function transcriptKind(type: string | null | undefined, url = ""): "vtt" | "srt" | "json" | "html" | "text" | null {
  const t = (type ?? "").toLowerCase(), u = url.toLowerCase().split(/[?#]/)[0];
  if (t.includes("vtt") || u.endsWith(".vtt")) return "vtt";
  if (t.includes("srt") || t.includes("subrip") || u.endsWith(".srt")) return "srt";
  if (t.includes("json") || u.endsWith(".json")) return "json";
  if (t.includes("html") || u.endsWith(".html") || u.endsWith(".htm")) return "html";
  if (t.startsWith("text/") || u.endsWith(".txt")) return "text";
  return null;
}
const RANK = { vtt: 0, srt: 1, json: 2, html: 3, text: 4 } as const;

/** The best link: a timed format first; the feed's own order breaks ties. Unknown types are skipped. */
export function pickTranscript(links: TranscriptLink[]): TranscriptLink | null {
  let best: TranscriptLink | null = null, rank = 99;
  for (const l of links) {
    const k = transcriptKind(l.type, l.url);
    if (k && RANK[k] < rank) { best = l; rank = RANK[k]; }
  }
  return best;
}

/** "01:02:03.456", "02:03,4", "3.5" → ms. */
export function parseTimestamp(s: string): number | null {
  const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?\s*$/.exec(s);
  if (!m) return null;
  const frac = m[4] ? Number(m[4].padEnd(3, "0")) : 0;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + frac;
}

const clean = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
/** Machine diarisation labels count from 0 ("SPEAKER_00", "spk_1") and read as "Speaker 1", "Speaker 2"; real names are kept. */
export function speakerName(s: string | null | undefined): string | null {
  const t = s ? clean(s) : "";
  if (!t) return null;
  const m = /^(?:speaker|spk)[ _-]?(\d{1,3})$/i.exec(t);
  return m ? `Speaker ${Number(m[1]) + 1}` : t;
}

/** WebVTT and SRT: blocks separated by blank lines; a "start --> end" line, then the text. `<v Name>` sets the speaker. */
function parseCues(body: string): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const block of body.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const rows = block.split("\n");
    const i = rows.findIndex((r) => r.includes("-->"));
    if (i < 0) continue;
    const [a, b] = rows[i].split("-->");
    const start = parseTimestamp(a), end = parseTimestamp((b ?? "").trim().split(/\s+/)[0] ?? "");
    if (start == null) continue;
    const raw = rows.slice(i + 1).join(" ");
    const voice = /<v(?:\.[^\s>]*)?\s+([^>]+)>/.exec(raw)?.[1]?.trim() ?? null;
    let text = clean(raw), speaker = speakerName(voice);
    // "SPEAKER: text" style (common in SRT exports)
    const named = !speaker ? /^([A-Z][\w .'-]{0,40}):\s+(.+)$/.exec(text) : null;
    if (named) { speaker = speakerName(named[1]); text = named[2]; }
    if (text) out.push({ startMs: start, endMs: end, speaker, text });
  }
  return out;
}

/** Podcast Index JSON transcript: {segments:[{startTime, endTime, body, speaker}]} in seconds. */
function parseJson(body: string): TranscriptLine[] {
  let root: any;
  try { root = JSON.parse(body); } catch { return []; }
  const segs = Array.isArray(root?.segments) ? root.segments : [];
  return segs.flatMap((s: any) => {
    const start = Number(s?.startTime), text = typeof s?.body === "string" ? clean(s.body) : "";
    if (!Number.isFinite(start) || start < 0 || !text) return [];
    const end = Number(s?.endTime);
    return [{ startMs: Math.round(start * 1000), endMs: Number.isFinite(end) && end > start ? Math.round(end * 1000) : null,
      speaker: typeof s?.speaker === "string" ? speakerName(s.speaker) : null, text }];
  });
}

/** HTML and plain text: paragraphs, no times. */
function parseParagraphs(body: string, html: boolean): TranscriptLine[] {
  let t = body.replace(/\r\n?/g, "\n");
  if (html) t = t.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<\s*(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, "\n\n");
  return t.split(/\n\s*\n/).map((p) => (html ? clean(p) : p.replace(/\s+/g, " ").trim())).filter(Boolean)
    .map((text) => ({ startMs: null, endMs: null, speaker: null, text }));
}

/**
 * Caption files cut speech into 2–5 s cues; for reading, consecutive cues become one line when: same speaker, at most 2 s
 * apart, and the joined text stays under 280 characters — but a finished sentence only takes more while it is under 140.
 */
export function joinLines(lines: TranscriptLine[]): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const l of lines) {
    const p = out[out.length - 1];
    const len = p ? p.text.length + 1 + l.text.length : 0;
    const join = !!p && p.startMs != null && l.startMs != null && p.speaker === l.speaker
      && (p.endMs == null || l.startMs - p.endMs <= JOIN_GAP_MS)
      && len < (/[.?!…]["”’)]?$/.test(p.text) ? JOIN_CHARS / 2 : JOIN_CHARS);
    if (join) { p!.text += " " + l.text; p!.endMs = l.endMs ?? p!.endMs; } else out.push({ ...l });
  }
  return out;
}

export function parseTranscript(body: string, kind: ReturnType<typeof transcriptKind>): Transcript {
  const b = body.replace(/^﻿/, "");
  let k = kind;
  if (/^WEBVTT/.test(b)) k = "vtt";
  let lines: TranscriptLine[];
  if (k === "vtt" || k === "srt") lines = joinLines(parseCues(b));
  else if (k === "json") lines = joinLines(parseJson(b));
  else lines = parseParagraphs(b, k === "html" || /^\s*</.test(b));
  lines = lines.slice(0, MAX_LINES);
  const timed = lines.length > 0 && lines.every((l) => l.startMs != null);
  if (timed) lines.sort((x, y) => x.startMs! - y.startMs!);
  return { timed, lines };
}
