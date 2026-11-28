import { createHash } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import type { Db, Row } from "./db.ts";
import { decodeXml, parseFeed, parseJsonChapters, httpUrl, normalizeChapters, type Chapter, type ParsedFeed } from "./feed.ts";
import { parseTag, readTag, sniffImage } from "./id3.ts";
import { parseTranscript, pickTranscript, transcriptKind, type Transcript } from "./transcript.ts";
import { FetchError, Semaphore, safeFetch } from "./net.ts";
import { feedKey, httpFallback } from "./urls.ts";

const FEED_MAX = 40 * 1024 * 1024, ART_MAX = 12 * 1024 * 1024, CHAPTERS_MAX = 4 * 1024 * 1024, TRANSCRIPT_MAX = 8 * 1024 * 1024;
const ART_CACHE_MAX = 512 * 1024 * 1024;

export interface Log { info(o: any, m?: string): void; warn(o: any, m?: string): void }

export class Feeds {
  private db: Db;
  private log: Log;
  private allow: Set<string>;
  private cacheDir: string;
  private sem = new Semaphore(4);
  private chapterLocks = new Map<number, Promise<Chapter[]>>();
  private transcriptLocks = new Map<number, Promise<(Transcript & { source: string; language: string | null }) | null>>();
  private artLocks = new Map<string, Promise<{ path: string; mime: string } | null>>();
  private refreshing: Promise<void> | null = null;
  private closed = false;
  close() { this.closed = true; }
  /** Called with the feed keys that gained or changed episodes. */
  onFeedChanged: (feedId: number, key: string) => void = () => {};

  constructor(db: Db, dataDir: string, log: Log, allow: Set<string>) {
    this.db = db; this.log = log; this.allow = allow;
    this.cacheDir = join(dataDir, "cache");
    mkdirSync(join(this.cacheDir, "art"), { recursive: true });
    mkdirSync(join(this.cacheDir, "chapters"), { recursive: true });
  }

  /** https first; plain http when the https attempt fails at the connection/TLS level. */
  private async get(url: string, headers: Record<string, string> = {}) {
    const opts = { maxBytes: FEED_MAX, timeoutMs: 60_000, allowHosts: this.allow,
      headers: { accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8", ...headers } };
    try {
      const r = await safeFetch(url, opts);
      if (r.status !== 404 && r.status !== 403) return r;
      const fb = httpFallback(url);
      if (!fb) return r;
      const r2 = await safeFetch(fb, opts).catch(() => r);
      return r2.status < 400 ? r2 : r;
    } catch (e) {
      const fb = httpFallback(url);
      if (!fb || (e instanceof FetchError && ["ssrf_blocked", "too_large", "ENOTFOUND", "timeout"].includes(e.code))) throw e;
      try { return await safeFetch(fb, opts); } catch { throw e; }
    }
  }

  async fetchParsed(url: string, etag?: string | null, lastModified?: string | null) {
    const headers: Record<string, string> = {};
    if (etag) headers["if-none-match"] = etag;
    if (lastModified) headers["if-modified-since"] = lastModified;
    const r = await this.get(url, headers);
    if (r.status === 304) return { notModified: true as const };
    if (r.status >= 400 || r.status < 200) throw new FetchError("http", `HTTP ${r.status} from ${new URL(r.url).host}`, r.status);
    const feed = parseFeed(decodeXml(r.bytes, r.headers["content-type"]));
    return { notModified: false as const, feed, etag: r.headers.etag ?? null, lastModified: r.headers["last-modified"] ?? null };
  }

  store(feedId: number, f: ParsedFeed, etag: string | null, lastModified: string | null): { inserted: number; changed: number } {
    const now = Date.now();
    let inserted = 0, changed = 0;
    this.db.tx(() => {
      this.db.run(`UPDATE feeds SET title=?, author=COALESCE(?,author), description=COALESCE(?,description), image=COALESCE(?,image), link=COALESCE(?,link),
        etag=?, last_modified=?, fetched_at=?, error=NULL, persons=? WHERE id=?`, f.title, f.author, f.description, httpUrl(f.image), httpUrl(f.link), etag, lastModified, now,
        f.persons?.length ? JSON.stringify(f.persons) : null, feedId);
      const have = new Map(this.db.all("SELECT guid, hash FROM episodes WHERE feed_id=?", feedId).map((r) => [r.guid, r.hash]));
      const seen = new Set<string>();
      for (const e of f.episodes.slice(0, 10_000)) {
        if (seen.has(e.guid) || e.guid.length > 4096 || !httpUrl(e.audioUrl)) continue;
        seen.add(e.guid);
        const hash = createHash("sha1").update(JSON.stringify(e)).digest("base64url");
        const old = have.get(e.guid);
        if (old === hash) continue;
        if (old === undefined) inserted++; else changed++;
        const psc = e.psc.length ? JSON.stringify(e.psc) : null;
        const transcripts = e.transcripts?.length ? JSON.stringify(e.transcripts) : null;
        const persons = e.persons?.length ? JSON.stringify(e.persons) : null;
        // A changed enclosure or chapter source invalidates cached chapters.
        this.db.run(`INSERT INTO episodes(feed_id,guid,title,description,audio_url,mime,size,duration_ms,pub_date,image,link,chapters_url,psc,number,season,type,hash,first_seen,transcripts,persons)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(feed_id,guid) DO UPDATE SET
            transcript=CASE WHEN transcripts IS NOT excluded.transcripts THEN NULL ELSE transcript END,
            transcript_source=CASE WHEN transcripts IS NOT excluded.transcripts THEN NULL ELSE transcript_source END,
            transcripts=excluded.transcripts, persons=excluded.persons,
            chapters=CASE WHEN audio_url IS NOT excluded.audio_url OR chapters_url IS NOT excluded.chapters_url OR psc IS NOT excluded.psc THEN NULL ELSE chapters END,
            chapters_source=CASE WHEN audio_url IS NOT excluded.audio_url OR chapters_url IS NOT excluded.chapters_url OR psc IS NOT excluded.psc THEN NULL ELSE chapters_source END,
            title=excluded.title, description=excluded.description, audio_url=excluded.audio_url, mime=excluded.mime, size=COALESCE(excluded.size,size),
            duration_ms=COALESCE(excluded.duration_ms,duration_ms), pub_date=COALESCE(excluded.pub_date,pub_date), image=excluded.image, link=excluded.link,
            chapters_url=excluded.chapters_url, psc=excluded.psc, number=excluded.number, season=excluded.season, type=excluded.type, hash=excluded.hash`,
          feedId, e.guid, e.title, e.description, e.audioUrl, e.mime, e.size, e.durationMs, e.pubDate, httpUrl(e.image), httpUrl(e.link),
          httpUrl(e.chaptersUrl), psc, e.number, e.season, e.type, hash, now, transcripts, persons);
      }
    });
    return { inserted, changed };
  }

  async refreshFeed(feedId: number, force = false): Promise<string | null> {
    return this.sem.run(async () => {
      const f = this.closed ? null : this.db.get("SELECT * FROM feeds WHERE id=?", feedId);
      if (!f) return "not found";
      try {
        const r = await this.fetchParsed(f.url, force ? null : f.etag, force ? null : f.last_modified);
        if (this.closed) return "shutting down";
        if (r.notModified) this.db.run("UPDATE feeds SET fetched_at=?, error=NULL WHERE id=?", Date.now(), feedId);
        else {
          const { inserted, changed } = this.store(feedId, r.feed, r.etag, r.lastModified);
          if (inserted || changed || f.error) this.onFeedChanged(feedId, f.key);
          this.log.info({ feed: f.key, inserted, changed }, "feed refreshed");
        }
        return null;
      } catch (e: any) {
        const msg = String(e?.message ?? e).slice(0, 300);
        if (this.closed) return msg;
        this.db.run("UPDATE feeds SET error=?, fetched_at=? WHERE id=?", msg, Date.now(), feedId);
        this.log.warn({ feed: f.key, err: msg }, "feed refresh failed");
        return msg;
      }
    });
  }

  /** Refreshes feeds somebody is subscribed to; overlapping calls share one run. */
  refreshAll(olderThanMs = 0, userId?: number): Promise<void> {
    const run = async () => {
      const rows = this.db.all(`SELECT id FROM feeds f WHERE COALESCE(fetched_at,0)<=? AND EXISTS(SELECT 1 FROM subscriptions s WHERE s.feed_key=f.key AND s.deleted=0 ${userId ? "AND s.user_id=?" : ""})`,
        ...[Date.now() - olderThanMs, ...(userId ? [userId] : [])]);
      await Promise.all(rows.map((r) => this.refreshFeed(r.id)));
    };
    if (userId) return run();
    this.refreshing ??= run().finally(() => { this.refreshing = null; this.sweep(); });
    return this.refreshing;
  }

  /** Finds-or-creates a feed by fetching it first, so a bad URL never becomes a subscription. */
  async addFeed(url: string): Promise<Row> {
    const key = feedKey(url);
    const existing = this.db.get("SELECT * FROM feeds WHERE key=? AND fetched_at IS NOT NULL AND error IS NULL", key);
    if (existing) return existing;
    const r = await this.sem.run(() => this.fetchParsed(url));
    if (r.notModified) throw new FetchError("http", "Unexpected 304");
    const id = this.db.tx(() => {
      const f = this.db.get("SELECT id FROM feeds WHERE key=?", key);
      return f ? (f.id as number) : Number(this.db.run("INSERT INTO feeds(key,url,title) VALUES(?,?,?)", key, url, r.feed.title).lastInsertRowid);
    });
    this.store(id, r.feed, r.etag, r.lastModified);
    return this.db.get("SELECT * FROM feeds WHERE id=?", id)!;
  }

  // ---------------------------------------------------------------- chapters

  chapters(episodeId: number): Promise<Chapter[]> {
    let p = this.chapterLocks.get(episodeId);
    if (!p) {
      p = this.sem.run(() => this.loadChapters(episodeId)).finally(() => this.chapterLocks.delete(episodeId));
      this.chapterLocks.set(episodeId, p);
    }
    return p;
  }

  /** The episode's transcript (podcast:transcript), fetched once and kept; null when it has none or it can't be read. */
  transcript(episodeId: number): Promise<(Transcript & { source: string; language: string | null }) | null> {
    let p = this.transcriptLocks.get(episodeId);
    if (!p) {
      p = this.sem.run(() => this.loadTranscript(episodeId)).finally(() => this.transcriptLocks.delete(episodeId));
      this.transcriptLocks.set(episodeId, p);
    }
    return p;
  }
  private async loadTranscript(id: number): Promise<(Transcript & { source: string; language: string | null }) | null> {
    const e = this.db.get("SELECT transcripts, transcript, transcript_source FROM episodes WHERE id=?", id);
    if (!e?.transcripts) return null;
    if (e.transcript_source) return e.transcript ? JSON.parse(e.transcript) : null;
    const link = pickTranscript(JSON.parse(e.transcripts));
    if (!link) { this.db.run("UPDATE episodes SET transcript=NULL, transcript_source='none' WHERE id=?", id); return null; }
    try {
      const r = await safeFetch(link.url, { maxBytes: TRANSCRIPT_MAX, timeoutMs: 30_000, allowHosts: this.allow });
      if (r.status !== 200) throw new FetchError("http", `HTTP ${r.status}`, r.status);
      const kind = transcriptKind(link.type || r.headers["content-type"], link.url);
      const t = parseTranscript(decodeXml(r.bytes, r.headers["content-type"]), kind);
      const out = t.lines.length ? { ...t, source: kind ?? "text", language: link.language } : null;
      if (!this.closed) this.db.run("UPDATE episodes SET transcript=?, transcript_source=? WHERE id=?", out ? JSON.stringify(out) : null, kind ?? "text", id);
      return out;
    } catch (err: any) {
      this.log.warn({ episode: id, err: err.message }, "transcript failed"); // not cached: tried again next time
      return null;
    }
  }

  /** Podcasting 2.0 JSON → PSC in the feed → ID3 CHAP via HTTP Range. Also picks up embedded episode art. */
  private async loadChapters(id: number): Promise<Chapter[]> {
    const e = this.db.get("SELECT * FROM episodes WHERE id=?", id);
    if (!e) return [];
    if (e.chapters_source) return e.chapters ? JSON.parse(e.chapters) : [];
    let list: Chapter[] = [], source = "none", complete = true, art: string | null = e.embedded_art;
    if (e.chapters_url) {
      try {
        const r = await safeFetch(e.chapters_url, { maxBytes: CHAPTERS_MAX, timeoutMs: 20_000, allowHosts: this.allow });
        if (r.status === 200) { list = parseJsonChapters(r.bytes.toString("utf8")); if (list.length) source = "json"; }
        else complete = false;
      } catch (err: any) { complete = false; this.log.warn({ episode: id, err: err.message }, "chapters json failed"); }
    }
    if (!list.length && e.psc) { list = JSON.parse(e.psc); source = "psc"; }
    if (!list.length || (!e.image && !art)) {
      try {
        const tag = await readTag(this.ranges(e.audio_url));
        if (tag) {
          const t = parseTag(tag);
          const save = (name: string, b: Buffer | null) => {
            const kind = b && b.length > 64 ? sniffImage(b) : null;
            if (!kind) return null;
            const file = `${id}-${name}.${kind.ext}`;
            this.write(join(this.cacheDir, "chapters", file), b!);
            return file;
          };
          const chapters = normalizeChapters(t.chapters.slice(0, 500).map((c, i) => ({
            startMs: c.startMs, endMs: c.endMs > c.startMs ? c.endMs : null, title: c.title ?? "", url: c.url,
            image: ((f) => (f ? `chapter:${f}` : null))(save(String(i), c.image)),
          })));
          const cover = save("cover", t.cover);
          art = cover ? `chapter:${cover}` : (chapters.find((c) => c.startMs === 0 && c.image)?.image ?? null);
          if (!list.length && chapters.length) { list = chapters; source = "id3"; }
          this.log.info({ episode: id, tagBytes: tag.length, chapters: chapters.length, art: !!art }, "id3 read via range");
        }
      } catch (err: any) { complete = false; this.log.warn({ episode: id, err: err.message }, "id3 read failed"); }
    }
    if (!this.closed && (source !== "none" || complete))
      this.db.run("UPDATE episodes SET chapters=?, chapters_source=?, embedded_art=? WHERE id=?", list.length ? JSON.stringify(list) : null, source, art, id);
    return list;
  }

  private ranges(url: string) {
    let target = url;
    return async (start: number, end: number): Promise<Buffer> => {
      const want = end - start + 1;
      const r = await safeFetch(target, { maxBytes: want, prefixOnly: true, timeoutMs: 45_000, allowHosts: this.allow,
        headers: { range: `bytes=${start}-${end}`, "accept-encoding": "identity" } });
      if (r.status !== 206 && !(r.status === 200 && start === 0)) throw new FetchError("http", `HTTP ${r.status}`, r.status);
      target = r.url;
      return r.bytes;
    };
  }

  chapterFile(name: string): { path: string; mime: string } | null {
    const m = /^\d+-(?:\d+|cover)\.(jpg|png|gif|webp|avif)$/.exec(name);
    const path = join(this.cacheDir, "chapters", name);
    if (!m || !existsSync(path)) return null;
    return { path, mime: m[1] === "jpg" ? "image/jpeg" : `image/${m[1]}` };
  }

  // ---------------------------------------------------------------- art

  /** Fetches and caches remote artwork (raster images only). */
  art(url: string): Promise<{ path: string; mime: string } | null> {
    const id = createHash("sha256").update(url).digest("base64url");
    let p = this.artLocks.get(id);
    if (!p) { p = this.loadArt(id, url).finally(() => this.artLocks.delete(id)); this.artLocks.set(id, p); }
    return p;
  }
  private async loadArt(id: string, url: string) {
    const path = join(this.cacheDir, "art", id);
    if (existsSync(path)) {
      const kind = sniffImage(readFileSync(path).subarray(0, 64));
      if (kind) { const now = new Date(); utimesSync(path, now, now); return { path, mime: kind.mime }; }
    }
    try {
      const r = await safeFetch(url, { maxBytes: ART_MAX, timeoutMs: 20_000, allowHosts: this.allow, headers: { accept: "image/*" } });
      const kind = r.status === 200 ? sniffImage(r.bytes) : null;
      if (!kind) return null;
      this.write(path, r.bytes);
      return { path, mime: kind.mime };
    } catch (e: any) { this.log.warn({ err: e.message, host: URL.parse(url)?.host }, "art fetch failed"); return null; }
  }
  private write(path: string, b: Buffer) { const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, b); renameSync(tmp, path); }

  /** Keeps the art cache under its limit, least recently used first. */
  private sweep() {
    const dir = join(this.cacheDir, "art");
    const files = readdirSync(dir).map((n) => { const s = statSync(join(dir, n)); return { p: join(dir, n), size: s.size, t: s.mtimeMs }; }).sort((a, b) => b.t - a.t);
    let total = 0;
    for (const f of files) { total += f.size; if (total > ART_CACHE_MAX) unlinkSync(f.p); }
  }
}
