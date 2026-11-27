import type { Db, Row } from "./db.ts";
import { enclosureKey, feedKey, normalizeFeedUrl } from "./urls.ts";
import { cleanSetting, MAX_SETTINGS_PER_USER } from "./settings.ts";

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
/** One user setting (0.10.0). value null = back to the default. */
export interface SettingChange { key: string; value: unknown; changedAt?: number }
/** Feature 6: 1 = thumbs up, -1 = thumbs down, 0 = none. */
export interface RatingChange { feedUrl: string; rating: number; changedAt?: number }
export interface PushBody {
  pushId?: string; clientTime?: number; mode?: "merge" | "force";
  subscriptions?: SubscriptionChange[]; episodes?: EpisodeChange[]; queue?: QueuePush | null; settings?: SettingChange[]; ratings?: RatingChange[];
}
export interface PushResult { rev: number; serverTime: number; subscriptions: number; episodes: number; queue: boolean; settings: number; ratings: number; skipped: number; duplicate?: boolean }

/** Feature 7 (0.10.0): an episode with less than this left… */
export const AUTO_FINISH_REMAINING_MS = 5 * 60_000;
/** …that isn't resumed on any device within this long after it was paused or stopped counts as played. */
export const AUTO_FINISH_GRACE_MS = 10 * 60_000;

/** The rule itself (the apps carry the same one for when there is no server). */
export function shouldAutoFinish(e: { played: boolean; positionMs: number; durationMs: number | null; pausedAt: number }, now: number, since: number): boolean {
  if (e.played || !e.durationMs || e.durationMs <= 0 || e.positionMs <= 0) return false;
  if (e.durationMs - e.positionMs >= AUTO_FINISH_REMAINING_MS) return false;
  return e.pausedAt >= since && now - e.pausedAt >= AUTO_FINISH_GRACE_MS;
}

/** Feature 2 (0.10.0): shuffle when the queue ends. Not heard in the last 30 days (or never) = this many times as likely. */
export const SHUFFLE_RECENT_MS = 30 * 86_400_000;
export const SHUFFLE_FRESH_WEIGHT = 4;
/** Weighted random pick (the apps carry the same one). `rnd` in [0, 1). */
export function pickShuffle<T>(cands: { item: T; lastPlayedAt: number | null }[], now: number, rnd: number): T | null {
  if (!cands.length) return null;
  const w = cands.map((c) => (c.lastPlayedAt != null && now - c.lastPlayedAt < SHUFFLE_RECENT_MS ? 1 : SHUFFLE_FRESH_WEIGHT));
  let x = rnd * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < cands.length; i++) { x -= w[i]; if (x < 0) return cands[i].item; }
  return cands[cands.length - 1].item;
}

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
    const subs = body.subscriptions ?? [], eps = body.episodes ?? [], sets = body.settings ?? [], rats = body.ratings ?? [];
    if (!Array.isArray(subs) || !Array.isArray(eps) || !Array.isArray(sets) || !Array.isArray(rats)) throw bad("subscriptions, episodes, settings and ratings must be arrays");
    if (rats.length > 2000) throw bad("too many ratings in one push (max 2000)");
    if (subs.length > 2000 || eps.length > 5000 || sets.length > 200) throw bad("too many records in one push (max 2000 subscriptions, 5000 episodes, 200 settings)");
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
      let nSets = 0;
      for (const c of sets) if (this.applySetting(userId, deviceId, c, at, now, force)) nSets++; else skipped++;
      let nRats = 0;
      for (const r of rats) if (this.applyRating(userId, deviceId, r, at, force)) nRats++; else skipped++;
      const res: PushResult = { rev: this.rev(userId), serverTime: now, subscriptions: nSubs, episodes: nEps, queue: q, settings: nSets, ratings: nRats, skipped };
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

  /** Newest change per key wins; on a tie the stored value stays (unless the device forces). */
  private applySetting(userId: number, deviceId: string, c: SettingChange, at: (t: unknown) => number, now: number, force: boolean): boolean {
    if (typeof c !== "object" || !c) throw bad("each setting must be an object");
    const { key, json } = cleanSetting(c.key, c.value);
    const t = at(c.changedAt);
    const cur = this.db.get("SELECT value, changed_at FROM user_settings WHERE user_id=? AND key=?", userId, key);
    if (cur && (force ? t < cur.changed_at : t <= cur.changed_at)) return false;
    if (cur && cur.value === json) { this.db.run("UPDATE user_settings SET changed_at=? WHERE user_id=? AND key=?", t, userId, key); return false; }
    if (!cur && (this.db.get("SELECT COUNT(*) n FROM user_settings WHERE user_id=?", userId) as Row).n >= MAX_SETTINGS_PER_USER) throw bad(`too many settings (max ${MAX_SETTINGS_PER_USER})`);
    this.db.run(`INSERT INTO user_settings(user_id,key,value,changed_at,rev,updated_at,device_id) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value, changed_at=excluded.changed_at, rev=excluded.rev, updated_at=excluded.updated_at, device_id=excluded.device_id`,
      userId, key, json, t, this.bump(userId), now, deviceId);
    return true;
  }

  /** Feature 6: newest change per podcast wins (ties keep the stored one unless forced). Kept after unsubscribing. */
  private applyRating(userId: number, deviceId: string, c: RatingChange, at: (t: unknown) => number, force: boolean): boolean {
    if (typeof c !== "object" || !c) throw bad("each rating must be an object");
    const url = normalizeFeedUrl(str(c.feedUrl, MAX_URL, "feedUrl"));
    if (!url) throw bad("Invalid feed URL");
    if (c.rating !== 1 && c.rating !== -1 && c.rating !== 0) throw bad("rating must be 1, -1 or 0");
    const key = feedKey(url), t = at(c.changedAt), now = this.now();
    const cur = this.db.get("SELECT rating, changed_at FROM ratings WHERE user_id=? AND feed_key=?", userId, key);
    if (cur && (force ? t < cur.changed_at : t <= cur.changed_at)) return false;
    if (cur && cur.rating === c.rating) { this.db.run("UPDATE ratings SET changed_at=? WHERE user_id=? AND feed_key=?", t, userId, key); return false; }
    this.db.run(`INSERT INTO ratings(user_id,feed_key,feed_url,rating,changed_at,rev,updated_at,device_id) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id,feed_key) DO UPDATE SET rating=excluded.rating, changed_at=excluded.changed_at, rev=excluded.rev, updated_at=excluded.updated_at, device_id=excluded.device_id`,
      userId, key, url, c.rating, t, this.bump(userId), now, deviceId);
    return true;
  }

  rating(userId: number, key: string): number {
    return (this.db.get("SELECT rating FROM ratings WHERE user_id=? AND feed_key=?", userId, key) as Row | undefined)?.rating ?? 0;
  }

  /** Every stored setting of a user (resets included, as null). */
  settings(userId: number): Row[] {
    return this.db.all("SELECT * FROM user_settings WHERE user_id=? ORDER BY key", userId);
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
    // 0.10.0 (play history): the time it was last listened to also counts when it came with a finish, not only with a position.
    if (num(c.lastPlayedAt) != null && num(c.lastPlayedAt)! > 0 && (c.played === true || pos(c.positionMs) > 0)) n.last_played_at = Math.max(n.last_played_at ?? 0, at(c.lastPlayedAt));
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

  // ------------------------------------------------------------------ feature 7: nearly finished + abandoned = played

  autoFinishSince(): number {
    return Number((this.db.get("SELECT value FROM meta WHERE key='auto_finish_since'") as Row | undefined)?.value ?? Number.MAX_SAFE_INTEGER);
  }

  /**
   * Marks episodes played that have < 5 min left and whose last position (a pause, stop or the last progress while playing)
   * is ≥ 10 min old, on every device. Any progress resets the clock, so listening anywhere prevents it. Like a finish: position 0,
   * gone from the queue. Returns the number marked. `userId` limits it to one user (done before every pull).
   */
  autoFinish(userId?: number): number {
    const now = this.now(), since = this.autoFinishSince();
    const rows = this.db.all(`SELECT user_id, feed_key, guid, position_ms, position_at, duration_ms FROM episode_state
      WHERE played=0 AND position_ms>0 AND duration_ms>0 AND duration_ms-position_ms<? AND position_at>=? AND position_at<=? ${userId != null ? "AND user_id=?" : ""}`,
      ...[AUTO_FINISH_REMAINING_MS, since, now - AUTO_FINISH_GRACE_MS, ...(userId != null ? [userId] : [])]);
    let n = 0;
    const touched = new Map<number, number>();
    for (const r of rows) {
      if (!shouldAutoFinish({ played: false, positionMs: r.position_ms, durationMs: r.duration_ms, pausedAt: r.position_at }, now, since)) continue;
      const at = r.position_at + AUTO_FINISH_GRACE_MS;
      this.db.tx(() => {
        const rev = this.bump(r.user_id);
        this.db.run(`UPDATE episode_state SET played=1, played_at=?, unplayed_explicit=0, completed_at=?, position_ms=0, position_at=?, position_device=NULL,
          rev=?, updated_at=?, device_id=NULL WHERE user_id=? AND feed_key=? AND guid=? AND played=0`, at, at, at, rev, now, r.user_id, r.feed_key, r.guid);
        this.dropFromQueue(r.user_id, "server", now, (q) => q.feed_key === r.feed_key && q.guid === r.guid);
        touched.set(r.user_id, this.rev(r.user_id));
      });
      n++;
    }
    for (const [u, rev] of touched) this.onChange(u, rev, null);
    return n;
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
    this.autoFinish(userId); // lazily, so a pull never shows an episode that should already count as played
    const limit = Math.min(Math.max(opts.limit ?? 1000, 1), 5000);
    const current = this.rev(userId);
    const key = opts.feedUrl ? feedKey(opts.feedUrl) : null;
    const subs = this.db.all(`SELECT s.*, d.name dname FROM subscriptions s LEFT JOIN devices d ON d.id=s.device_id WHERE s.user_id=? AND s.rev>? ${key ? "AND feed_key=?" : ""} ORDER BY s.rev LIMIT ?`,
      ...[userId, since, ...(key ? [key] : []), limit + 1]);
    const eps = this.db.all(`SELECT s.*, d.name dname FROM episode_state s LEFT JOIN devices d ON d.id=COALESCE(s.position_device, s.device_id) WHERE s.user_id=? AND s.rev>? ${key ? "AND feed_key=?" : ""} ORDER BY s.rev LIMIT ?`,
      ...[userId, since, ...(key ? [key] : []), limit + 1]);
    // Settings aren't per podcast: a feed= pull leaves them out.
    const sets = key ? [] : this.db.all("SELECT * FROM user_settings WHERE user_id=? AND rev>? ORDER BY rev LIMIT ?", userId, since, limit + 1);
    const rats = key ? [] : this.db.all("SELECT * FROM ratings WHERE user_id=? AND rev>? ORDER BY rev LIMIT ?", userId, since, limit + 1);
    const all = [...subs, ...eps, ...sets, ...rats].sort((a, b) => a.rev - b.rev);
    const hasMore = all.length > limit;
    const upto = hasMore ? all[limit - 1].rev : current;
    const queueRev = (this.db.get("SELECT MAX(rev) r FROM queue_items WHERE user_id=?", userId) as Row).r ?? 0;
    return {
      rev: upto, hasMore, serverTime: this.now(),
      subscriptions: subs.filter((s) => s.rev <= upto).map(subOut),
      episodes: eps.filter((e) => e.rev <= upto).map(stateOut),
      settings: sets.filter((x) => x.rev <= upto).map(settingOut),
      ratings: rats.filter((x) => x.rev <= upto).map((r) => ({ feedUrl: r.feed_url, rating: r.rating, changedAt: r.changed_at, rev: r.rev, updatedAt: r.updated_at, deviceId: r.device_id })),
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
export function settingOut(s: Row) {
  return { key: s.key, value: s.value == null ? null : JSON.parse(s.value), changedAt: s.changed_at, rev: s.rev, updatedAt: s.updated_at, deviceId: s.device_id };
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
  // 0.10.0: the rest of a podcast's settings (null = follow the global setting).
  if (s.autoDownload === null || typeof s.autoDownload === "boolean") out.autoDownload = s.autoDownload;
  if (s.retentionMode === null || (typeof s.retentionMode === "string" && ["KEEP_ALL", "KEEP_LATEST", "DELETE_PLAYED"].includes(s.retentionMode))) out.retentionMode = s.retentionMode;
  if (s.retentionKeep === null || (typeof s.retentionKeep === "number" && Number.isInteger(s.retentionKeep) && s.retentionKeep >= 1 && s.retentionKeep <= 100)) out.retentionKeep = s.retentionKeep;
  if (s.newTimeoutDays === null || (typeof s.newTimeoutDays === "number" && Number.isInteger(s.newTimeoutDays) && s.newTimeoutDays >= 0 && s.newTimeoutDays <= 365)) out.newTimeoutDays = s.newTimeoutDays;
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
