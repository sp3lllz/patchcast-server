/** Minimal ID3v2.3/2.4 reader for CHAP/CTOC/APIC (port of the app's Id3Chapters). All reads are bounds-checked. */
export interface Id3Chapter { id: string; startMs: number; endMs: number; title: string | null; url: string | null; mime: string | null; image: Buffer | null }
export interface Id3Tag { chapters: Id3Chapter[]; coverMime: string | null; cover: Buffer | null }
export const MAX_TAG_BYTES = 24 * 1024 * 1024;

const syncsafe = (b: Buffer, p: number) => ((b[p] & 0x7f) << 21) | ((b[p + 1] & 0x7f) << 14) | ((b[p + 2] & 0x7f) << 7) | (b[p + 3] & 0x7f);

export function tagSize(h: Buffer): number {
  if (h.length < 10 || h.toString("latin1", 0, 3) !== "ID3") return 0;
  return 10 + syncsafe(h, 6) + (h[5] & 0x10 ? 10 : 0);
}

export function parseTag(tag: Buffer): Id3Tag {
  const empty = { chapters: [], coverMime: null, cover: null };
  if (!tagSize(tag)) return empty;
  const major = tag[3];
  if (major !== 3 && major !== 4) return empty;
  const end = Math.min(tag.length, 10 + syncsafe(tag, 6));
  let pos = 10;
  if (tag[5] & 0x40) { if (pos + 4 > end) return empty; pos += major === 4 ? syncsafe(tag, pos) : 4 + tag.readUInt32BE(pos); }
  const chapters = new Map<string, Id3Chapter>();
  let toc: string[] | null = null;
  let cover: { type: number; mime: string; data: Buffer } | null = null;
  frames(tag, pos, end, major, (id, s, e) => {
    if (id === "CHAP") { const c = chap(tag, s, e, major); if (c && chapters.size < 1000) chapters.set(c.id, c); }
    else if (id === "CTOC") { const c = ctoc(tag, s, e); if (c && (c.top || !toc)) toc = c.children; }
    else if (id === "APIC") { const a = apic(tag, s, e); if (a && (!cover || (a.type === 3 && cover.type !== 3))) cover = a; }
  });
  const ordered = (toc as string[] | null)?.map((i) => chapters.get(i)).filter((c): c is Id3Chapter => !!c);
  const list = ordered && ordered.length === chapters.size ? ordered : [...chapters.values()].sort((a, b) => a.startMs - b.startMs);
  const c = cover as { mime: string; data: Buffer } | null;
  return { chapters: list, coverMime: c?.mime ?? null, cover: c?.data ?? null };
}

function frames(b: Buffer, from: number, to: number, major: number, on: (id: string, s: number, e: number) => void) {
  let p = from;
  while (p >= 0 && p + 10 <= to && b[p] !== 0) {
    const id = b.toString("latin1", p, p + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const size = frameSize(b, p, to, major);
    const s = p + 10;
    if (s + size > to) break;
    on(id, s, s + size);
    p = s + size;
  }
}

/** v2.4 sizes should be syncsafe but some taggers write plain 32-bit; pick whichever lands on a frame boundary. */
function frameSize(b: Buffer, p: number, to: number, major: number): number {
  const plain = b.readUInt32BE(p + 4);
  if (major !== 4) return plain;
  const safe = syncsafe(b, p + 4);
  if (safe === plain) return safe;
  const ok = (n: number) => {
    const next = p + 10 + n;
    if (next > to) return false;
    return next === to || next + 10 > to || b[next] === 0 || /^[A-Z0-9]{4}$/.test(b.toString("latin1", next, next + 4));
  };
  return ok(safe) ? safe : ok(plain) ? plain : safe;
}

const zero = (b: Buffer, from: number, to: number) => { const i = b.indexOf(0, from); return i >= 0 && i < to ? i : -1; };

function chap(b: Buffer, s: number, e: number, major: number): Id3Chapter | null {
  const z = zero(b, s, e);
  if (z < 0 || z + 17 > e) return null;
  const c: Id3Chapter = { id: b.toString("latin1", s, z), startMs: b.readUInt32BE(z + 1), endMs: b.readUInt32BE(z + 5), title: null, url: null, mime: null, image: null };
  frames(b, z + 17, e, major, (id, fs, fe) => {
    if (id === "TIT2") c.title = text(b, fs, fe);
    else if (id === "WXXX") c.url = wxxx(b, fs, fe);
    else if (id === "APIC") { const a = apic(b, fs, fe); if (a) { c.mime = a.mime; c.image = a.data; } }
  });
  return c;
}

function ctoc(b: Buffer, s: number, e: number): { top: boolean; children: string[] } | null {
  const z = zero(b, s, e);
  if (z < 0 || z + 3 > e) return null;
  const top = (b[z + 1] & 2) !== 0, n = b[z + 2];
  const children: string[] = [];
  let p = z + 3;
  for (let i = 0; i < n; i++) { const q = zero(b, p, e); if (q < 0) break; children.push(b.toString("latin1", p, q)); p = q + 1; }
  return { top, children };
}

function decode(b: Buffer, enc: number): string {
  if (enc === 1) return new TextDecoder(b[0] === 0xfe && b[1] === 0xff ? "utf-16be" : "utf-16le").decode(b);
  if (enc === 2) return new TextDecoder("utf-16be").decode(b);
  return enc === 3 ? b.toString("utf8") : b.toString("latin1");
}
function term(b: Buffer, from: number, to: number, enc: number): number {
  if (enc === 1 || enc === 2) { for (let i = from; i + 1 < to; i += 2) if (!b[i] && !b[i + 1]) return i; return to; }
  const z = zero(b, from, to);
  return z < 0 ? to : z;
}
const termLen = (enc: number) => (enc === 1 || enc === 2 ? 2 : 1);

function text(b: Buffer, s: number, e: number): string | null {
  if (e - s < 1) return null;
  return decode(b.subarray(s + 1, term(b, s + 1, e, b[s])), b[s]).replace(/[\0﻿]/g, "").trim();
}
function wxxx(b: Buffer, s: number, e: number): string | null {
  if (e - s < 2) return null;
  const u = term(b, s + 1, e, b[s]) + termLen(b[s]);
  if (u >= e) return null;
  const z = zero(b, u, e);
  const url = b.toString("latin1", u, z < 0 ? e : z).trim();
  return /^https?:\/\//i.test(url) ? url : null;
}
function apic(b: Buffer, s: number, e: number): { type: number; mime: string; data: Buffer } | null {
  if (e - s < 4) return null;
  const z = zero(b, s + 1, e);
  if (z < 0 || z + 2 > e) return null;
  const start = term(b, z + 2, e, b[s]) + termLen(b[s]);
  return start >= e ? null : { type: b[z + 1], mime: b.toString("latin1", s + 1, z) || "image/jpeg", data: b.subarray(start, e) };
}

/** Image type by magic bytes (tags lie); null = not a supported raster image. */
export function sniffImage(b: Buffer): { ext: string; mime: string } | null {
  if (b.length < 16) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (b.toString("latin1", 0, 8) === "\x89PNG\r\n\x1a\n") return { ext: "png", mime: "image/png" };
  if (b.toString("latin1", 0, 4) === "GIF8") return { ext: "gif", mime: "image/gif" };
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return { ext: "webp", mime: "image/webp" };
  if (b.toString("latin1", 4, 12) === "ftypavif") return { ext: "avif", mime: "image/avif" };
  return null;
}

/** Reads just the ID3 tag through a range fetcher. */
export async function readTag(fetchRange: (start: number, end: number) => Promise<Buffer>): Promise<Buffer | null> {
  const head = await fetchRange(0, 9);
  const size = tagSize(head);
  if (size <= 10 || size > MAX_TAG_BYTES) return null;
  const tag = await fetchRange(0, size - 1);
  return tag.length >= size ? tag.subarray(0, size) : null;
}
