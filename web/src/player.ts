import { api, ApiError, type Chapter, type Episode, type Podcast } from "./api.ts";
import { Store, dataVersion, fmt, say } from "./store.ts";
import { prefs } from "./settings.ts";

export interface PlayerState {
  ep: Episode | null; chapters: Chapter[]; art: string | null; playing: boolean; buffering: boolean; position: number; duration: number; speed: number; volume: number;
  error: string | null; via: "direct" | "proxy"; sleepAt: number | null; sleepEnd: boolean;
}
export const player = new Store<PlayerState>({
  ep: null, chapters: [], art: null, playing: false, buffering: false, position: 0, duration: 0, speed: 1, volume: Number(localStorage.getItem("volume") ?? 1), error: null, via: "direct", sleepAt: null, sleepEnd: false,
});
/** Newer listening on another device; shown as a banner, never acted on by itself. */
export const remote = new Store<{ ep: Episode; positionMs: number; deviceName: string; at: number; playing: boolean } | null>(null);
export const dismissed = { at: Number(localStorage.getItem("dismissedAt") ?? 0) };

export const audio = new Audio();
audio.preload = "auto";
let lastPush = 0, startAt = 0, ownAt = 0, queueBusy = false;

// ------------------------------------------------------------ progress, with an offline queue
interface Pending { id: number; positionMs: number; durationMs: number | null; playing: boolean; changedAt: number; finished?: boolean }
const loadPending = (): Record<string, Pending> => { try { return JSON.parse(localStorage.getItem("pending") ?? "{}"); } catch { return {}; } };
const savePending = (p: Record<string, Pending>) => localStorage.setItem("pending", JSON.stringify(p));
let flushing = false, again = false;
export async function flush(keepalive = false) {
  if (flushing && !keepalive) { again = true; return; }
  flushing = true;
  try {
    for (const p of Object.values(loadPending())) {
      try {
        await api("POST", `/episodes/${p.id}/progress`, { ...p, clientTime: Date.now() }, { keepalive });
      } catch (e) {
        if (e instanceof ApiError && (e.status === 0 || e.status >= 500 || e.status === 429 || e.status === 401)) return; // keep it, retry later
      }
      const cur = loadPending();
      if (cur[p.id]?.changedAt === p.changedAt) { delete cur[p.id]; savePending(cur); }
    }
  } finally { flushing = false; if (again) { again = false; void flush(); } }
}
window.addEventListener("online", () => void flush());
setInterval(() => void flush(), 30_000);

function push(finished = false, keepalive = false) {
  const { ep, duration } = player.value;
  if (!ep) return;
  lastPush = ownAt = Date.now();
  const p = loadPending();
  p[ep.id] = { id: ep.id, positionMs: Math.round(audio.currentTime * 1000), durationMs: duration || null, playing: !audio.paused, changedAt: Date.now(), ...(finished ? { finished: true } : {}) };
  savePending(p);
  void flush(keepalive);
}

// ------------------------------------------------------------ playback
export async function play(id: number, atMs?: number) {
  const cur = player.value.ep;
  if (cur?.id === id) { if (atMs !== undefined) audio.currentTime = atMs / 1000; await start(); return; }
  if (cur && !audio.paused) { audio.pause(); push(); }
  try {
    const ep = await api<Episode>("GET", `/episodes/${id}`);
    const pos = atMs ?? (ep.durationMs && ep.positionMs > ep.durationMs - 5000 ? 0 : ep.positionMs);
    const saved = await api<Podcast>("GET", `/podcasts/${ep.feedId}`).catch(() => null);
    load(ep, pos, saved?.settings.speed ?? prefs.value.defaultSpeed);
    if (remote.value?.ep.id === id) remote.set(null);
    await start();
    void removeFromQueue(id);
  } catch (e: any) { say(e.message); }
}

function load(ep: Episode, posMs: number, speed: number) {
  startAt = posMs / 1000;
  player.patch({ ep, chapters: [], art: ep.image, position: posMs, duration: ep.durationMs ?? 0, speed, error: null, via: "direct", buffering: true });
  audio.src = ep.audioUrl;
  setMeta();
  api<{ chapters: Chapter[]; image: string | null }>("GET", `/episodes/${ep.id}/chapters`).then((r) => {
    if (player.value.ep?.id !== ep.id) return;
    player.patch({ chapters: r.chapters, art: r.image ?? ep.image });
    setMeta();
  }).catch(() => {});
}
async function start() {
  try { await audio.play(); } catch (e: any) { if (e.name === "NotAllowedError") say("Press play to start"); }
}
/** Loads without playing, e.g. to show the last episode after a reload. */
export function preload(ep: Episode) { if (!player.value.ep) { load(ep, ep.positionMs, prefs.value.defaultSpeed); player.patch({ buffering: false }); audio.preload = "metadata"; } }

audio.addEventListener("loadedmetadata", () => {
  audio.playbackRate = player.value.speed; audio.volume = player.value.volume;
  if (startAt > 0) { audio.currentTime = Math.min(startAt, Math.max(0, (audio.duration || Infinity) - 1)); startAt = 0; }
  if (Number.isFinite(audio.duration)) player.patch({ duration: audio.duration * 1000 });
});
audio.addEventListener("timeupdate", () => {
  if (startAt > 0) return;
  const s = player.value;
  player.patch({ position: audio.currentTime * 1000 });
  const before = chapterAt(s.chapters, s.position), now = chapterAt(s.chapters, player.value.position);
  if (before !== now) setMeta();
  if (!audio.paused && Date.now() - lastPush > 20_000) push();
  if (s.sleepAt && Date.now() >= s.sleepAt) { player.patch({ sleepAt: null }); audio.pause(); }
  if ("mediaSession" in navigator && Number.isFinite(audio.duration)) {
    try { navigator.mediaSession.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: audio.playbackRate }); } catch {}
  }
});
audio.addEventListener("play", () => { player.patch({ playing: true, error: null }); });
audio.addEventListener("playing", () => { player.patch({ buffering: false }); push(); });
audio.addEventListener("waiting", () => player.patch({ buffering: true }));
audio.addEventListener("pause", () => { player.patch({ playing: false }); if (!audio.ended && startAt === 0 && player.value.ep) push(); });
audio.addEventListener("error", () => {
  const s = player.value;
  if (!s.ep || !audio.getAttribute("src")) return;
  const at = startAt || audio.currentTime, resume = s.playing || !audio.paused;
  if (s.via === "direct") {
    // The host refuses cross-origin playback (or plain-http audio on an https page): stream through the server.
    startAt = at;
    player.patch({ via: "proxy", buffering: true });
    audio.src = s.ep.audioProxy;
    if (resume) void start();
  } else player.patch({ error: "This episode couldn't be played", playing: false, buffering: false });
});
audio.addEventListener("ended", async () => {
  const { ep, sleepEnd } = player.value;
  player.patch({ playing: false });
  push(true);
  if (sleepEnd) { player.patch({ sleepEnd: false }); return; }
  try {
    const q = await api<{ items: Episode[] }>("GET", "/queue");
    const next = q.items.find((e) => e.id !== ep?.id);
    if (next) await play(next.id);
  } catch {}
});
// A tab closing while playing keeps its last position.
window.addEventListener("pagehide", () => { if (!audio.paused) push(false, true); });

async function removeFromQueue(id: number) {
  if (queueBusy) return;
  queueBusy = true;
  try {
    const { items } = await api<{ items: Episode[] }>("GET", "/queue");
    if (items.some((e) => e.id === id)) await putQueue(items, items.filter((e) => e.id !== id));
  } catch {} finally { queueBusy = false; }
}
export async function putQueue(base: Episode[], items: Episode[]) {
  await api("PUT", "/queue", { base: base.map((e) => e.id), items: items.map((e) => e.id), auto: items.filter((e) => e.auto).map((e) => e.id) });
  dataVersion.set(dataVersion.value + 1);
}
export async function addToQueue(id: number, front = false) {
  try {
    const { items } = await api<{ items: Episode[] }>("GET", "/queue");
    const ep = await api<Episode>("GET", `/episodes/${id}`);
    const rest = items.filter((e) => e.id !== id);
    await putQueue(items, front ? [ep, ...rest] : [...rest, ep]);
    say(front ? "Playing next" : "Added to Up Next");
  } catch (e: any) { say(e.message); }
}

export const chapterAt = (list: Chapter[], ms: number): Chapter | null => { let c: Chapter | null = null; for (const x of list) if (x.startMs <= ms) c = x; return c; };
export const toggle = () => { if (!player.value.ep) return; if (audio.paused) void start(); else audio.pause(); };
export function seek(ms: number) {
  if (!player.value.ep) return;
  const s = Math.max(0, Math.min(ms / 1000, (Number.isFinite(audio.duration) ? audio.duration : Infinity) - 0.5));
  if (audio.readyState < 1) startAt = s; else audio.currentTime = s;
  player.patch({ position: s * 1000 });
  setMeta();
  push();
}
export const skip = (sec: number) => seek(audio.currentTime * 1000 + sec * 1000);
/** Skip lengths are synced settings (0.10.0). */
export const back = () => skip(-prefs.value.skipBackSec);
export const fwd = () => skip(prefs.value.skipForwardSec);
export function nextChapter() {
  const { chapters, position, ep } = player.value;
  const n = chapters.find((c) => !c.hidden && c.startMs > position + 500);
  if (n) return seek(n.startMs);
  void (async () => {
    const q = await api<{ items: Episode[] }>("GET", "/queue");
    const next = q.items.find((e) => e.id !== ep?.id);
    if (next) await play(next.id); else say("Up Next is empty");
  })().catch((e) => say(e.message));
}
export function prevChapter() {
  const { chapters, position } = player.value;
  const list = chapters.filter((c) => !c.hidden && c.startMs <= position);
  const cur = list.at(-1);
  if (!cur) return seek(0);
  seek(position - cur.startMs > 3000 ? cur.startMs : (list.at(-2)?.startMs ?? 0));
}
export function setSpeed(v: number) {
  audio.playbackRate = v; player.patch({ speed: v });
  const ep = player.value.ep;
  if (ep) api("PATCH", `/subscriptions/${ep.feedId}`, { speed: v }).catch(() => {});
}
export function setVolume(v: number) { audio.volume = v; player.patch({ volume: v }); localStorage.setItem("volume", String(v)); }

function setMeta() {
  const { ep, chapters, position, art } = player.value;
  const c = chapterAt(chapters, position);
  document.title = ep ? `${ep.title} · Patchcast` : "Patchcast";
  if (!("mediaSession" in navigator) || !ep) return;
  const img = c?.image ?? art;
  navigator.mediaSession.metadata = new MediaMetadata({ title: ep.title, artist: c && !c.hidden ? c.title : ep.podcast, album: ep.podcast, artwork: img ? [{ src: new URL(img, location.href).href, sizes: "512x512" }] : [] });
}
if ("mediaSession" in navigator) {
  const on = (a: MediaSessionAction, f: MediaSessionActionHandler) => { try { navigator.mediaSession.setActionHandler(a, f); } catch {} };
  on("play", () => void start()); on("pause", () => audio.pause());
  on("seekbackward", (d) => skip(-(d.seekOffset ?? prefs.value.skipBackSec))); on("seekforward", (d) => skip(d.seekOffset ?? prefs.value.skipForwardSec));
  on("seekto", (d) => { if (d.seekTime != null) seek(d.seekTime * 1000); });
  on("previoustrack", prevChapter); on("nexttrack", nextChapter);
}
export function keys(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  if (e.ctrlKey || e.metaKey || e.altKey || t.closest("input:not([type=range]),textarea,select,[contenteditable]")) return;
  const map: Record<string, () => void> = {
    " ": toggle, k: toggle, j: back, l: fwd, ArrowLeft: back, ArrowRight: fwd,
    ArrowUp: () => setVolume(Math.min(1, player.value.volume + 0.05)), ArrowDown: () => setVolume(Math.max(0, player.value.volume - 0.05)),
    n: nextChapter, p: prevChapter, m: () => setVolume(player.value.volume ? 0 : 1),
    ">": () => setSpeed(Math.min(3, +(player.value.speed + 0.1).toFixed(2))), "<": () => setSpeed(Math.max(0.5, +(player.value.speed - 0.1).toFixed(2))),
  };
  if (!player.value.ep || !map[e.key] || (e.key === " " && t.closest("button,a"))) return;
  e.preventDefault();
  map[e.key]();
}

// ------------------------------------------------------------ live updates
let es: EventSource | null = null, deb = 0;
export function connect(deviceId: string, base: string) {
  es?.close();
  es = new EventSource(`${base}/api/v1/events`);
  const bump = () => { clearTimeout(deb); deb = window.setTimeout(() => dataVersion.set(dataVersion.value + 1), 400); };
  es.addEventListener("hello", () => { void flush(); void offerLatest(); bump(); });
  es.addEventListener("change", (e) => { if (JSON.parse((e as MessageEvent).data).deviceId !== deviceId) bump(); });
  es.addEventListener("feed", bump);
  es.addEventListener("progress", (e) => {
    const d = JSON.parse((e as MessageEvent).data);
    if (d.deviceId === deviceId || !d.episodeId) return;
    void offer(d.episodeId, d.positionMs, d.deviceName, d.at, d.playing);
  });
}
export function disconnect() { es?.close(); es = null; }
async function offer(id: number, positionMs: number, deviceName: string, at: number, playing: boolean) {
  const r = remote.value;
  if (r?.ep.id === id) { remote.set({ ...r, positionMs, deviceName, at, playing }); return; }
  try { const ep = await api<Episode>("GET", `/episodes/${id}`); if (!ep.played) remote.set({ ep, positionMs, deviceName, at, playing }); } catch {}
}
async function offerLatest() {
  try {
    const { latest } = await api<{ latest: any }>("GET", "/latest");
    if (!latest) return;
    if (latest.mine || latest.at <= ownAt) { if (latest.mine && !player.value.ep) preload(latest.episode); return; }
    if (latest.at > dismissed.at && Date.now() - latest.at < 14 * 86400_000)
      remote.set({ ep: latest.episode, positionMs: latest.episode.positionMs, deviceName: latest.deviceName ?? "another device", at: latest.at, playing: false });
  } catch {}
}
export function continueHere() {
  const r = remote.value;
  if (!r) return;
  remote.set(null);
  void play(r.ep.id, r.positionMs);
  say(`Resumed at ${fmt(r.positionMs)}`);
}
export function dismissRemote() { dismissed.at = Date.now(); localStorage.setItem("dismissedAt", String(dismissed.at)); remote.set(null); }
