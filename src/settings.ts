/**
 * User settings that follow a person to every device (0.10.0). Each setting is one key with a JSON value and the time
 * it was changed; the newest change per key wins, like positions. Things that belong to one device (Wi-Fi only, battery,
 * notifications, storage, the device's name) are never sent here: the apps keep those to themselves.
 *
 * Known keys are checked so every client can rely on their shape. Other keys are accepted as small JSON values, so a newer
 * app can sync a setting this server doesn't know yet. `null` means "back to the default".
 */
import { SyncError } from "./sync.ts";

const bad = (m: string) => new SyncError(m);

type Check = (v: unknown) => unknown;
const int = (min: number, max: number): Check => (v) => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined);
const real = (min: number, max: number): Check => (v) => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? Math.round(v * 100) / 100 : undefined);
const bool: Check = (v) => (typeof v === "boolean" ? v : undefined);
const oneOf = (...xs: string[]): Check => (v) => (typeof v === "string" && xs.includes(v) ? v : undefined);

/** The settings every Patchcast app understands. Documented in docs/SYNC_API.md → Settings. */
export const SETTINGS: Record<string, Check> = {
  defaultSpeed: real(0.5, 3),
  skipBackSec: int(5, 120),
  skipForwardSec: int(5, 300),
  autoQueueEnabled: bool,
  autoQueuePosition: oneOf("FRONT", "BACK"),
  newEpisodeTimeoutDays: int(0, 365),
  autoDownloadEnabled: bool,
  retentionMode: oneOf("KEEP_ALL", "KEEP_LATEST", "DELETE_PLAYED"),
  retentionKeep: int(1, 100),
  themeMode: oneOf("SYSTEM", "LIGHT", "DARK"),
  dynamicColor: bool,
  // Feature 2: when Up Next runs out, keep playing random episodes from subscribed podcasts.
  shuffleWhenQueueEnds: bool,
  // Feature 5: playing an episode that isn't downloaded also downloads it in the apps (browsers just stream).
  downloadWhileStreaming: bool,
};

const KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
export const MAX_SETTINGS_PER_USER = 500;
const MAX_VALUE = 4096;

/** Validated value for a key (null = reset). Throws a 400 for a wrong key or value. */
export function cleanSetting(key: unknown, value: unknown): { key: string; json: string | null } {
  if (typeof key !== "string" || !KEY.test(key)) throw bad("setting key must be 1-64 letters, digits, '.', '_' or '-', starting with a letter");
  if (value === null || value === undefined) return { key, json: null };
  const check = SETTINGS[key];
  if (check) {
    const v = check(value);
    if (v === undefined) throw bad(`invalid value for setting ${key}`);
    return { key, json: JSON.stringify(v) };
  }
  const json = JSON.stringify(value);
  if (json === undefined || json.length > MAX_VALUE) throw bad(`setting ${key} is too large (max ${MAX_VALUE} bytes of JSON)`);
  return { key, json };
}
