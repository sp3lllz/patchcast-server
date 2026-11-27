import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type Row = Record<string, any>;

/** Thin wrapper over node:sqlite: statement cache and nested-safe transactions. */
export class Db {
  readonly raw: DatabaseSync;
  private cache = new Map<string, StatementSync>();
  private depth = 0;

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    migrate(this);
  }

  static open(dataDir: string): Db {
    mkdirSync(dataDir, { recursive: true });
    return new Db(join(dataDir, "patchcast.db"));
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) { s = this.raw.prepare(sql); this.cache.set(sql, s); }
    return s;
  }
  all<T = Row>(sql: string, ...args: any[]): T[] { return this.stmt(sql).all(...args) as T[]; }
  get<T = Row>(sql: string, ...args: any[]): T | undefined { return this.stmt(sql).get(...args) as T | undefined; }
  run(sql: string, ...args: any[]) { return this.stmt(sql).run(...args); }

  /** Synchronous transaction (never await inside: better atomicity by construction). */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.raw.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const r = fn();
      this.raw.exec("COMMIT");
      return r;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth--;
    }
  }
  close() { this.raw.close(); }
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE, pw_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE devices (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, kind TEXT NOT NULL, token_hash TEXT UNIQUE,
    created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL
  );
  CREATE INDEX devices_user ON devices(user_id);
  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE feeds (
    id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, url TEXT NOT NULL, title TEXT, author TEXT, description TEXT,
    image TEXT, link TEXT, etag TEXT, last_modified TEXT, fetched_at INTEGER, error TEXT
  );
  CREATE TABLE episodes (
    id INTEGER PRIMARY KEY, feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
    guid TEXT NOT NULL, title TEXT NOT NULL, description TEXT, audio_url TEXT NOT NULL, mime TEXT, size INTEGER,
    duration_ms INTEGER, pub_date INTEGER, image TEXT, link TEXT, chapters_url TEXT, psc TEXT,
    number INTEGER, season INTEGER, type TEXT, hash TEXT, first_seen INTEGER NOT NULL,
    chapters TEXT, chapters_source TEXT, embedded_art TEXT,
    UNIQUE(feed_id, guid)
  );
  CREATE INDEX episodes_feed_date ON episodes(feed_id, pub_date DESC);
  CREATE INDEX episodes_date ON episodes(pub_date DESC);
  CREATE TABLE subscriptions (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, feed_key TEXT NOT NULL, feed_url TEXT NOT NULL,
    title TEXT, settings TEXT NOT NULL DEFAULT '{}', added_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
    changed_at INTEGER NOT NULL, settings_at INTEGER NOT NULL DEFAULT 0,
    rev INTEGER NOT NULL, updated_at INTEGER NOT NULL, device_id TEXT,
    PRIMARY KEY (user_id, feed_key)
  );
  CREATE INDEX subscriptions_rev ON subscriptions(user_id, rev);
  CREATE TABLE episode_state (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, feed_key TEXT NOT NULL, guid TEXT NOT NULL,
    feed_url TEXT NOT NULL, enclosure_url TEXT, title TEXT, pub_date INTEGER,
    played INTEGER NOT NULL DEFAULT 0, played_at INTEGER NOT NULL DEFAULT 0, unplayed_explicit INTEGER NOT NULL DEFAULT 0,
    position_ms INTEGER NOT NULL DEFAULT 0, position_at INTEGER NOT NULL DEFAULT 0, position_device TEXT,
    duration_ms INTEGER, last_played_at INTEGER, completed_at INTEGER,
    rev INTEGER NOT NULL, updated_at INTEGER NOT NULL, device_id TEXT,
    PRIMARY KEY (user_id, feed_key, guid)
  );
  CREATE INDEX episode_state_rev ON episode_state(user_id, rev);
  CREATE INDEX episode_state_recent ON episode_state(user_id, position_at DESC);
  CREATE TABLE queue_items (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, feed_key TEXT NOT NULL, guid TEXT NOT NULL,
    feed_url TEXT NOT NULL, enclosure_url TEXT, title TEXT, auto INTEGER NOT NULL DEFAULT 0, added_at INTEGER NOT NULL,
    ord INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, rev INTEGER NOT NULL, updated_at INTEGER NOT NULL, device_id TEXT,
    PRIMARY KEY (user_id, feed_key, guid)
  );
  CREATE TABLE pushes (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, push_id TEXT NOT NULL, response TEXT NOT NULL,
    at INTEGER NOT NULL, PRIMARY KEY (user_id, push_id)
  );
  `,
  // 0.7.0: OIDC. Accounts without a local password have pw_hash ''. Since 0.8.0 pw_hash and pw_recovery_until are kept but never read.
  `
  ALTER TABLE users ADD COLUMN display_name TEXT;
  ALTER TABLE users ADD COLUMN pw_recovery_until INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN via TEXT NOT NULL DEFAULT 'password';
  ALTER TABLE sessions ADD COLUMN id_token TEXT;
  CREATE TABLE identities (
    issuer TEXT NOT NULL, sub TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username TEXT, email TEXT, linked_at INTEGER NOT NULL, last_login_at INTEGER,
    PRIMARY KEY (issuer, sub), UNIQUE (user_id, issuer)
  );
  `,
  // 0.10.0: settings that follow the user to every device. value NULL = back to the default (kept as a tombstone so the reset syncs).
  `
  CREATE TABLE user_settings (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, key TEXT NOT NULL, value TEXT,
    changed_at INTEGER NOT NULL, rev INTEGER NOT NULL, updated_at INTEGER NOT NULL, device_id TEXT,
    PRIMARY KEY (user_id, key)
  );
  CREATE INDEX user_settings_rev ON user_settings(user_id, rev);
  `,
  // 0.10.0 (feature 7): server facts. auto_finish_since = when this server started marking nearly-finished, abandoned episodes
  // as played; only pauses after that count, so old half-listened episodes aren't all marked at once.
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO meta(key, value) VALUES ('auto_finish_since', CAST(CAST(strftime('%s','now') AS INTEGER) * 1000 AS TEXT));
  `,
  // 0.10.0 (feature 6): a personal thumbs up/down per podcast, keyed by feed so it outlives the subscription. 0 = no rating.
  `
  CREATE TABLE ratings (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, feed_key TEXT NOT NULL, feed_url TEXT NOT NULL,
    rating INTEGER NOT NULL, changed_at INTEGER NOT NULL, rev INTEGER NOT NULL, updated_at INTEGER NOT NULL, device_id TEXT,
    PRIMARY KEY (user_id, feed_key)
  );
  CREATE INDEX ratings_rev ON ratings(user_id, rev);
  `,
];

function migrate(db: Db) {
  const v = (db.raw.prepare("PRAGMA user_version").get() as any).user_version as number;
  if (v > MIGRATIONS.length) throw new Error(`Database is version ${v}, newer than this server understands (${MIGRATIONS.length})`);
  for (let i = v; i < MIGRATIONS.length; i++) {
    db.tx(() => { db.raw.exec(MIGRATIONS[i]); db.raw.exec(`PRAGMA user_version=${i + 1}`); });
  }
}
