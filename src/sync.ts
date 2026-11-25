import type { Db, Row } from "./db.ts";
import { enclosureKey, feedKey, normalizeFeedUrl } from "./urls.ts";

export interface EpisodeRef { feedUrl: string; guid?: string | null; enclosureUrl?: string | null; title?: string | null; pubDate?: number | null }
export interface EpisodeChange extends EpisodeRef {
  /** Present = the played flag changed at playedChangedAt. */
  played?: boolean; explicitUnplayed?: boolean; playedChangedAt?: number;
  /** Present = the position changed at positionChangedAt. */
  positionMs?: number; positionChangedAt?: number;
  durationMs?: number | null; lastPlayedAt?: number | null; completedAt?: number | null;
}
export interface SubscriptionChange { feedUrl: string; title?: string | null; deleted?: boolean; changedAt?: number; settings?: Record<string, unknown>; settingsChangedAt?: number }
export interface QueueRef extends EpisodeRef { auto?: boolean; addedAt?: number }
export interface QueuePush { base: EpisodeRef[]; items: QueueRef[]; replace?: boolean }
export interface PushBody {
  pushId?: string; clientTime?: number; mode?: "merge" | "force";
  subscriptions?: SubscriptionChange[]; episodes?: EpisodeChange[]; queue?: QueuePush | null;
}
export interface PushResult { rev: number; serverTime: number; subscriptions: number; episodes: number; queue: boolean; skipped: number; duplicate?: boolean }

/** Different devices this close together in time may disagree on the position by clock error alone… */
export const SKEW_WINDOW_MS = 60_000;
/** …so a backwards move smaller than this from another device is treated as noise, not a rewind. */
export const TRIVIAL_BACKWARDS_MS = 15_000;
const MAX_URL = 4096, MAX_TEXT = 2000;

export class SyncError extends Error { status = 400; code = "bad_request"; }
const bad = (m: string) => new SyncError(m);

const str = (v: unknown, max: number, name: string): string => {
  if (typeof v !== "string" || !v.length || v.length > max) throw bad(`${name} is required (max ${max} characters)`);
  return v;
};
const optStr = (v: unknown, max: number): string | null => (typeof v === "string" && v ? v.slice(0, max) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e15 ? Math.round(v) : null);
const pos = (v: unknown): number => Math.max(0, num(v) ?? 0);

export interface ResolvedRef { feedKey: string; feedUrl: string; guid: string; enclosureUrl: string | null; title: string | null; pubDate: number | null }

export class SyncStore {
  private db: Db;
  private onChange: (userId: number, rev: number, deviceId: string | null) => void;
  now: () => number;

  constructor(db: Db, onChange: (userId: number, rev: number, deviceId: string | null) => void = () => {}, now: () => number = Date.now) {
    this.db = db; this.onChange = onChange; this.now = now;
  }

  rev(userId: number): number { return (this.db.get("SELECT rev FROM users WHERE id=?", userId) as Row).rev; }
  private bump(userId: number): number {
    return (this.db.get("UPDATE users SET rev=rev+1 WHERE id=? RETURNING rev", userId) as Row).rev;
  }

  /** Canonical identity: feed + GUID; when the GUID is unknown, an enclosure match supplies it. */
  resolve(r: EpisodeRef): ResolvedRef {
    const feedUrl = str(r?.feedUrl, MAX_URL, "feedUrl");
    const key = feedKey(feedUrl);
    const enclosureUrl = optStr(r.enclosureUrl, MAX_URL);
    let guid = optStr(r.guid, MAX_URL);
    const base = { feedKey: key, feedUrl, enclosureUrl, title: optStr(r.title, MAX_TEXT), pubDate: num(r.pubDate) };
    const feed = this.db.get("SELECT id FROM feeds WHERE key=?", key);
    if (feed) {
      if (guid && this.db.get("SELECT 1 FROM episodes WHERE feed_id=? AND guid=?", feed.id, guid)) return { ...base, guid };
      if (enclosureUrl) {
        const exact = this.db.get("SELECT guid FROM episodes WHERE feed_id=? AND audio_url=?", feed.id, enclosureUrl);
        if (exact) return { ...base, guid: exact.guid };
        const ek = enclosureKey(enclosureUrl);
        // Only trackers' query strings / schemes differ; don't let "/play?id=1"-style URLs collapse together.
        const hits = this.db.all("SELECT guid, audio_url FROM episodes WHERE feed_id=?", feed.id).filter((e) => enclosureKey(e.audio_url) === ek);
        if (hits.length === 1) return { ...base, guid: hits[0].guid };
      }
    }
    guid ??= enclosureUrl;
    if (!guid) throw bad("episode needs a guid or enclosureUrl");
    return { ...base, guid };
  }

  // ------------------------------------------------------------------ push

  push(userId: number, deviceId: string, body: PushBody): PushResult {
    if (typeof body !== "object" || !body) throw bad("body must be an object");
    const subs = body.subscriptions ?? [], eps = body.episodes ?? [];
    if (!Array.isArray(subs) || !Array.isArray(eps)) throw bad("subscriptions and episodes must be arrays");
    if (subs.length > 2000 || eps.length > 5000) throw bad("too many records in one push (max 2000 subscriptions, 5000 episodes)");
    const pushId = optStr(body.pushId, 100);
    const now = this.now();
    // Server time is authoritative: shift client timestamps by the client's clock error, and never accept the future.
    const offset = num(body.clientTime) != null ? now - num(body.clientTime)! : 0;
    const force = body.mode === "force";
    const at = (t: unknown): number => {
      if (force) return now;
      const n = num(t);
      return n == null ? now : n <= 0 ? 0 : Math.max(0, Math.min(now, n + offset));
    };
    const before = this.rev(userId);
    const result = this.db.tx(() => {
      if (pushId) {
        const prev = this.db.get("SELECT response FROM pushes WHERE user_id=? AND push_id=?", userId, pushId);
        if (prev) return { ...JSON.parse(prev.response), duplicate: true } as PushResult;
      }
      let nSubs = 0, nEps = 0, skipped = 0;
      for (const s of subs) if (this.applySubscription(userId, deviceId, s, at, now)) nSubs++; else skipped++;
      for (const e of eps) if (this.applyEpisode(userId, deviceId, e, at, now, force)) nEps++; else skipped++;
      const q = body.queue ? this.applyQueue(userId, deviceId, body.queue, at, now) : false;
      const res: PushResult = { rev: this.rev(userId), serverTime: now, subscriptions: nSubs, episodes: nEps, queue: q, skipped };
      if (pushId) {
        this.db.run("INSERT INTO pushes(user_id,push_id,response,at) VALUES(?,?,?,?)", userId, pushId, JSON.stringify(res), now);
        this.db.run("DELETE FROM pushes WHERE at<?", now - 14 * 86_400_000);
      }
      return res;
    });
    if (result.rev > before && !result.duplicate) this.onChange(userId, result.rev, deviceId);
    return result;
  }

  private applySubscription(userId: number, deviceId: string, s: SubscriptionChange, at: (t: unknown) => number, now: number): boolean {
    const raw = str(s?.feedUrl, MAX_URL, "feedUrl");
    const url = normalizeFeedUrl(raw);
    if (!url) throw bad(`Invalid feed URL`);
    const key = feedKey(url);
    const cur = this.db.get("SELECT * FROM subscriptions WHERE user_id=? AND feed_key=?", userId, key);
    const changedAt = at(s.changedAt);
    const title = optStr(s.title, MAX_TEXT);
    const settings = s.settings && typeof s.settings === "object" ? cleanSettings(s.settings) : null;
    const settingsAt = settings ? at(s.settingsChangedAt ?? s.changedAt) : 0;
    if (!s.deleted) this.ensureFeed(key, url, title);
    if (!cur) {
      this.db.run(`INSERT INTO subscriptions(user_id,feed_key,feed_url,title,settings,added_at,deleted,changed_at,settings_at,rev,updated_at,device_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, userId, key, url, title, JSON.stringify(settings ?? {}), now, s.deleted ? 1 : 0, changedAt, settingsAt, this.bump(userId), now, deviceId);
      return true;
    }
    let { deleted, changed_at, settings_at } = cur;
    let json: string = cur.settings;
    const want = s.deleted ? 1 : 0;
    // Newest change wins. On a tie keep the subscription.
    if (s.deleted !== undefined) {
      if (changedAt > changed_at || (changedAt === changed_at && !want)) { deleted = want; changed_at = changedAt; }
    }
    if (settings && settingsAt > settings_at) { json = JSON.stringify({ ...JSON.parse(cur.settings), ...settings }); settings_at = settingsAt; }
    const newTitle = title ?? cur.title;
    if (deleted === cur.deleted && json === cur.settings && newTitle === cur.title) {
      if (changed_at !== cur.changed_at || settings_at !== cur.settings_at)
        this.db.run("UPDATE subscriptions SET changed_at=?, settings_at=? WHERE user_id=? AND feed_key=?", changed_at, settings_at, userId, key);
      return false;
    }
    this.db.run(`UPDATE subscriptions SET title=?, settings=?, deleted=?, changed_at=?, settings_at=?, rev=?, updated_at=?, device_id=?,
      added_at=CASE WHEN deleted=1 AND ?=0 THEN ? ELSE added_at END WHERE user_id=? AND feed_key=?`,
      newTitle, json, deleted, changed_at, settings_at, this.bump(userId), now, deviceId, deleted, now, userId, key);
    if (deleted && !cur.deleted) this.dropFromQueue(userId, deviceId, now, (q) => q.feed_key === key);
    return true;
  }

  ensureFeed(key: string, url: string, title: string | null): number {
    const f = this.db.get("SELECT id FROM feeds WHERE key=?", key);
    if (f) return f.id;
    return Number(this.db.run("INSERT INTO feeds(key,url,title) VALUES(?,?,?)", key, url, title).lastInsertRowid);
  }

  private applyEpisode(userId: number, deviceId: string, c: EpisodeChange, at: (t: unknown) => number, now: number, force: boolean): boolean {
    const r = this.resolve(c);
    const cur: Row = this.db.get("SELECT * FROM episode_state WHERE user_id=? AND feed_key=? AND guid=?", userId, r.feedKey, r.guid)
      ?? { played: 0, played_at: -1, unplayed_explicit: 0, position_ms: 0, position_at: -1, position_device: null, duration_ms: null, last_played_at: null, completed_at: null, isNew: true };
    const n: Row = { ...cur };

    if (typeof c.played === "boolean") {
      const t = at(c.playedChangedAt);
      if (c.played && !cur.played) {
        // Sticky: played wins unless the stored unplayed was explicit and is strictly newer.
        if (!(cur.unplayed_explicit && cur.played_at > t) || force) {
          n.played = 1; n.played_at = t; n.unplayed_explicit = 0;
          n.completed_at = num(c.completedAt) != null ? at(c.completedAt) : t;
          if (t >= cur.position_at) { n.position_ms = 0; n.position_at = t; n.position_device = deviceId; }
        }
      } else if (c.played && cur.played) {
        if (t > cur.played_at) n.played_at = t;
      } else if (!c.played && cur.played) {
        if (c.explicitUnplayed && (force || t > cur.played_at)) { n.played = 0; n.played_at = t; n.unplayed_explicit = 1; n.completed_at = null; }
      } else if (!c.played && !cur.played && c.explicitUnplayed && t > cur.played_at) {
        n.played_at = t; n.unplayed_explicit = 1;
      }
    }

    if (num(c.positionMs) != null) {
      const t = at(c.positionChangedAt);
      const p = pos(c.positionMs);
      const other = cur.position_device !== null && cur.position_device !== deviceId;
      // A finished episode's zeroed position isn't overwritten by progress from before it was finished.
      const beforeFinish = n.played && t < n.played_at;
      if (!beforeFinish && (t > cur.position_at || (t === cur.position_at && p > cur.position_ms))) {
        const back = cur.position_ms - p;
        const trivial = !force && other && back > 0 && back < TRIVIAL_BACKWARDS_MS && t - cur.position_at < SKEW_WINDOW_MS && !n.played;
        n.position_at = t;
        if (!trivial) { n.position_ms = p; n.position_device = deviceId; }
        const lp = num(c.lastPlayedAt) != null ? at(c.lastPlayedAt) : t;
        if (p > 0) n.last_played_at = Math.max(cur.last_played_at ?? 0, lp);
      }
    }
    if (num(c.durationMs) && num(c.durationMs)! > 0) n.duration_ms = num(c.durationMs);

    const visible = ["played", "position_ms", "duration_ms", "last_played_at", "completed_at", "unplayed_explicit"];
    const changed = cur.isNew || visible.some((k) => n[k] !== cur[k]) ;
    const hidden = n.played_at !== cur.played_at || n.position_at !== cur.position_at;
    if (!changed && !hidden) return false;
    this.db.run(`INSERT INTO episode_state(user_id,feed_key,guid,feed_url,enclosure_url,title,pub_date,played,played_at,unplayed_explicit,position_ms,position_at,
        position_device,duration_ms,last_played_at,completed_at,rev,updated_at,device_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id,feed_key,guid) DO UPDATE SET enclosure_url=COALESCE(excluded.enclosure_url,enclosure_url), title=COALESCE(excluded.title,title),
        pub_date=COALESCE(excluded.pub_date,pub_date), played=excluded.played, played_at=excluded.played_at, unplayed_explicit=excluded.unplayed_explicit,
        position_ms=excluded.position_ms, position_at=excluded.position_at, position_device=excluded.position_device, duration_ms=excluded.duration_ms,
        last_played_at=excluded.last_played_at, completed_at=excluded.completed_at, rev=excluded.rev, updated_at=excluded.updated_at, device_id=excluded.device_id`,
      userId, r.feedKey, r.guid, r.feedUrl, r.enclosureUrl, r.title, r.pubDate, n.played, Math.max(0, n.played_at), n.unplayed_explicit, n.position_ms,
      Math.max(0, n.position_at), n.position_device, n.duration_ms, n.last_played_at, n.completed_at,
      changed ? this.bump(userId) : cur.rev, changed ? now : cur.updated_at, changed ? deviceId : cur.device_id);
    if (n.played && !cur.played) this.dropFromQueue(userId, deviceId, now, (q) => q.feed_key === r.feedKey && q.guid === r.guid);
    return changed;
  }

  // ------------------------------------------------------------------ queue

  queue(userId: number): Row[] {
    return this.db.all("SELECT * FROM queue_items WHERE user_id=? AND deleted=0 ORDER BY ord, added_at, guid", userId);
  }

  private dropFromQueue(userId: number, deviceId: string, now: number, match: (q: Row) => boolean) {
    const cur = this.queue(userId);
    if (cur.some(match)) this.writeQueue(userId, deviceId, now, cur.filter((q) => !match(q)), cur);
  }

  /** Three-way merge: what changed from `base` to `items` is applied to whatever the server holds now. */
  private applyQueue(userId: number, deviceId: string, q: QueuePush, at: (t: unknown) => number, now: number): boolean {
    if (!Array.isArray(q.items) || !Array.isArray(q.base)) throw bad("queue needs base and items arrays");
    if (q.items.length > 5000 || q.base.length > 5000) throw bad("queue too long");
    const id = (r: Row) => `${r.feed_key}\n${r.guid}`;
    const cur = this.queue(userId);
    const items: Row[] = [];
    const seen = new Set<string>();
    for (const i of q.items) {
      const r = this.resolve(i);
      const row = { feed_key: r.feedKey, guid: r.guid, feed_url: r.feedUrl, enclosure_url: r.enclosureUrl, title: r.title, auto: i.auto ? 1 : 0, added_at: i.addedAt ? at(i.addedAt) : now };
      if (!seen.has(id(row))) { seen.add(id(row)); items.push(row); }
    }
    const base = q.replace ? cur.map(id) : q.base.map((b) => { const r = this.resolve(b); return id({ feed_key: r.feedKey, guid: r.guid }); });
    const merged = mergeQueue(base, items.map(id), cur.map(id));
    const byId = new Map<string, Row>();
    for (const c of cur) byId.set(id(c), c);
    const baseSet = new Set(base);
    for (const i of items) {
      const k = id(i), c = byId.get(k);
      // Dragging an automatic item makes it manual; that flag change is the client's to make.
      byId.set(k, c ? { ...c, auto: baseSet.has(k) || q.replace ? i.auto : Math.min(c.auto, i.auto) } : i);
    }
    // An addition of something finished in the meantime is dropped unless it was deliberately queued by the user.
    const next = merged.map((k) => byId.get(k)!).filter((i) => i && !(i.auto && !cur.some((c) => id(c) === id(i)) && this.isPlayed(userId, i)));
    return this.writeQueue(userId, deviceId, now, next, cur);
  }

  private isPlayed(userId: number, i: Row) {
    return !!this.db.get("SELECT 1 FROM episode_state WHERE user_id=? AND feed_key=? AND guid=? AND played=1", userId, i.feed_key, i.guid);
  }

  private writeQueue(userId: number, deviceId: string, now: number, next: Row[], cur: Row[]): boolean {
    const id = (r: Row) => `${r.feed_key}\n${r.guid}`;
    const old = new Map(cur.map((c) => [id(c), c]));
    const keep = new Set(next.map(id));
    let changed = false;
    next.forEach((i, ord) => {
      const c = old.get(id(i));
      if (c && c.ord === ord && c.auto === i.auto) return;
      changed = true;
      this.db.run(`INSERT INTO queue_items(user_id,feed_key,guid,feed_url,enclosure_url,title,auto,added_at,ord,deleted,rev,updated_at,device_id) VALUES(?,?,?,?,?,?,?,?,?,0,?,?,?)
        ON CONFLICT(user_id,feed_key,guid) DO UPDATE SET auto=excluded.auto, ord=excluded.ord, deleted=0, added_at=excluded.added_at,
        enclosure_url=COALESCE(excluded.enclosure_url,enclosure_url), title=COALESCE(excluded.title,title), rev=excluded.rev, updated_at=excluded.updated_at, device_id=excluded.device_id`,
        userId, i.feed_key, i.guid, i.feed_url, i.enclosure_url ?? null, i.title ?? null, i.auto, i.added_at, ord, this.bump(userId), now, deviceId);
    });
    for (const c of cur) if (!keep.has(id(c))) {
      changed = true;
      this.db.run("UPDATE queue_items SET deleted=1, rev=?, updated_at=?, device_id=? WHERE user_id=? AND feed_key=? AND guid=?", this.bump(userId), now, deviceId, userId, c.feed_key, c.guid);
    }
    return changed;
  }

  // ------------------------------------------------------------------ pull

  pull(userId: number, since: number, opts: { limit?: number; feedUrl?: string } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 1000, 1), 5000);
    const current = this.rev(userId);
    const key = opts.feedUrl ? feedKey(opts.feedUrl) : null;
    const subs = this.db.all(`SELECT s.*, d.name dname FROM subscriptions s LEFT JOIN devices d ON d.id=s.device_id WHERE s.user_id=? AND s.rev>? ${key ? "AND feed_key=?" : ""} ORDER BY s.rev LIMIT ?`,
      ...[userId, since, ...(key ? [key] : []), limit + 1]);
    const eps = this.db.all(`SELECT s.*, d.name dname FROM episode_state s LEFT JOIN devices d ON d.id=COALESCE(s.position_device, s.device_id) WHERE s.user_id=? AND s.rev>? ${key ? "AND feed_key=?" : ""} ORDER BY s.rev LIMIT ?`,
      ...[userId, since, ...(key ? [key] : []), limit + 1]);
    const all = [...subs, ...eps].sort((a, b) => a.rev - b.rev);
    const hasMore = all.length > limit;
    const upto = hasMore ? all[limit - 1].rev : current;
    const queueRev = (this.db.get("SELECT MAX(rev) r FROM queue_items WHERE user_id=?", userId) as Row).r ?? 0;
    return {
      rev: upto, hasMore, serverTime: this.now(),
      subscriptions: subs.filter((s) => s.rev <= upto).map(subOut),
      episodes: eps.filter((e) => e.rev <= upto).map(stateOut),
      // The whole ordered queue whenever any part of it changed (it is small); tombstones stay on the server.
      queue: !hasMore && !key && queueRev > since ? this.queue(userId).map((q) => ({
        feedUrl: q.feed_url, guid: q.guid, enclosureUrl: q.enclosure_url, title: q.title, auto: !!q.auto, addedAt: q.added_at })) : null,
    };
  }

  /** Latest unfinished listening on any device: the "continue on this device" candidate. */
  latest(userId: number): Row | undefined {
    return this.db.get(`SELECT s.*, d.name dname FROM episode_state s LEFT JOIN devices d ON d.id=s.position_device
      WHERE s.user_id=? AND s.position_at>0 AND s.played=0 AND s.position_ms>0 ORDER BY s.position_at DESC LIMIT 1`, userId);
  }
  state(userId: number, key: string, guid: string): Row | undefined {
    return this.db.get(`SELECT s.*, d.name dname FROM episode_state s LEFT JOIN devices d ON d.id=s.position_device WHERE s.user_id=? AND s.feed_key=? AND s.guid=?`, userId, key, guid);
  }
}

export function subOut(s: Row) {
  return { feedUrl: s.feed_url, title: s.title, settings: JSON.parse(s.settings), deleted: !!s.deleted, addedAt: s.added_at, rev: s.rev, updatedAt: s.updated_at, deviceId: s.device_id };
}
export function stateOut(e: Row) {
  return {
    feedUrl: e.feed_url, guid: e.guid, enclosureUrl: e.enclosure_url, title: e.title, pubDate: e.pub_date, played: !!e.played,
    positionMs: e.position_ms, positionAt: e.position_at, durationMs: e.duration_ms, lastPlayedAt: e.last_played_at, completedAt: e.completed_at,
    rev: e.rev, updatedAt: e.updated_at, deviceId: e.position_device ?? e.device_id, deviceName: e.dname ?? null,
  };
}

/** Per-podcast settings subset; unknown keys are ignored, null clears. */
export function cleanSettings(s: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (s.speed === null) out.speed = null;
  else if (typeof s.speed === "number" && s.speed >= 0.25 && s.speed <= 5) out.speed = Math.round(s.speed * 100) / 100;
  if (typeof s.priority === "number" && Number.isInteger(s.priority) && Math.abs(s.priority) < 1e6) out.priority = s.priority;
  if (s.autoQueue === null || typeof s.autoQueue === "boolean") out.autoQueue = s.autoQueue;
  if (typeof s.exclude === "boolean") { out.exclude = s.exclude; if (s.autoQueue === undefined) out.autoQueue = s.exclude ? false : null; }
  if (out.autoQueue !== undefined) out.exclude = out.autoQueue === false;
  return out;
}

/** Pure three-way list merge (base → theirs applied onto mine). */
export function mergeQueue(base: string[], theirs: string[], mine: string[]): string[] {
  const baseS = new Set(base), theirS = new Set(theirs), mineS = new Set(mine);
  const removed = new Set(base.filter((k) => !theirS.has(k)));
  const removedByMe = new Set(base.filter((k) => !mineS.has(k)));
  const common = theirs.filter((k) => baseS.has(k) && mineS.has(k));
  const baseOrder = base.filter((k) => theirS.has(k) && mineS.has(k));
  const reordered = common.some((k, i) => k !== baseOrder[i]);
  const mineKept = mine.filter((k) => !removed.has(k) || !baseS.has(k));
  // The list whose order leads, and the one whose extra items are woven in after their own predecessors.
  const lead = reordered ? theirs.filter((k) => !removedByMe.has(k)) : mineKept;
  const other = reordered ? mineKept : theirs.filter((k) => !removedByMe.has(k));
  const out = [...lead];
  const have = new Set(out);
  other.forEach((k, i) => {
    if (have.has(k)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) { const p = out.indexOf(other[j]); if (p >= 0) { at = p + 1; break; } }
    // Nothing before it in its own list: keep it in front of its first known successor.
    if (at === 0) { const succ = other.slice(i + 1).find((x) => have.has(x)); at = succ ? out.indexOf(succ) : i === 0 ? 0 : out.length; }
    out.splice(at, 0, k);
    have.add(k);
  });
  return out;
}
