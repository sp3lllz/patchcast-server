import { api } from "./api.ts";
import { Store, dataVersion, say } from "./store.ts";

/** Settings that follow the user to every device (0.10.0, `/api/v1/settings`). Defaults match the apps. */
export interface Prefs {
  defaultSpeed: number; skipBackSec: number; skipForwardSec: number;
  autoQueueEnabled: boolean; autoQueuePosition: "FRONT" | "BACK"; newEpisodeTimeoutDays: number;
  autoDownloadEnabled: boolean; retentionMode: "KEEP_ALL" | "KEEP_LATEST" | "DELETE_PLAYED"; retentionKeep: number;
  themeMode: "SYSTEM" | "LIGHT" | "DARK"; dynamicColor: boolean;
}
export const DEFAULTS: Prefs = {
  defaultSpeed: 1, skipBackSec: 10, skipForwardSec: 30,
  autoQueueEnabled: true, autoQueuePosition: "BACK", newEpisodeTimeoutDays: 14,
  autoDownloadEnabled: true, retentionMode: "KEEP_LATEST", retentionKeep: 3,
  themeMode: "SYSTEM", dynamicColor: true,
};

const cached = (() => { try { return JSON.parse(localStorage.getItem("prefs") ?? "{}"); } catch { return {}; } })();
// Before 0.10 the theme lived only in this browser: carry it over until the server answers.
if (!cached.themeMode && localStorage.getItem("theme")) cached.themeMode = String(localStorage.getItem("theme")).toUpperCase();
export const prefs = new Store<Prefs>({ ...DEFAULTS, ...cached });
const remember = () => localStorage.setItem("prefs", JSON.stringify(prefs.value));

function apply(list: { key: string; value: unknown }[]) {
  const next: any = { ...DEFAULTS };
  for (const s of list) if (s.key in DEFAULTS && s.value !== null) next[s.key] = s.value;
  prefs.set(next); remember();
}

let loaded = false;
/** Fetches the synced settings; again whenever another device changes something. */
export async function loadPrefs() {
  try { apply((await api("GET", "/settings")).settings); } catch { /* offline: keep the cached copy */ }
  if (!loaded) { loaded = true; let seen = dataVersion.value; dataVersion.sub(() => { if (dataVersion.value !== seen) { seen = dataVersion.value; void loadPrefs(); } }); }
}

export async function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
  const before = prefs.value;
  prefs.patch({ [key]: value } as Partial<Prefs>); remember();
  try { apply((await api("PUT", "/settings", { values: { [key]: value } })).settings); } catch (e: any) { prefs.set(before); remember(); say(e.message ?? "Couldn't save the setting"); }
}
