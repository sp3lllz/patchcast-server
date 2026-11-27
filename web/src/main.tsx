import { render, type ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api, ApiError, BASE, setCsrf, whenUnauthorized, type Chapter, type Episode, type Podcast } from "./api.ts";
import { ago, dataVersion, day, dur, fmt, say, Store, toast, useStore } from "./store.ts";
import * as P from "./player.ts";
import { prefs, loadPrefs, setPref, type Prefs } from "./settings.ts";
import { header, predict, short } from "./predict.ts";

// ------------------------------------------------------------ routing
const path = new Store(location.pathname.slice(BASE.length) || "/");
const go = (to: string) => { history.pushState(null, "", BASE + to); path.set(to); window.scrollTo(0, 0); expanded.set(false); };
window.addEventListener("popstate", () => path.set(location.pathname.slice(BASE.length) || "/"));
function A({ to, children, ...p }: { to: string; children: ComponentChildren; class?: string; title?: string }) {
  return <a href={BASE + to} {...p} onClick={(e: MouseEvent) => { if (e.metaKey || e.ctrlKey || e.button) return; e.preventDefault(); go(to); }}>{children}</a>;
}
const expanded = new Store(false);
interface Me { user: { id: number; username: string; isAdmin: boolean }; deviceId: string; csrf: string; version: string }
const me = new Store<Me | null | undefined>(undefined);
// Appearance is a synced setting (0.10.0): the same theme on every device.
const applyTheme = () => { const t = prefs.value.themeMode.toLowerCase(); document.documentElement.dataset.theme = t; localStorage.setItem("theme", t); };
prefs.sub(applyTheme); applyTheme();

// ------------------------------------------------------------ icons
const I: Record<string, string> = {
  play: "M8 5v14l11-7z", pause: "M6 5h4v14H6zM14 5h4v14h-4z", next: "M6 6v12l8.5-6zM16 6h2v12h-2z", prev: "M18 6v12l-8.5-6zM6 6h2v12H6z",
  home: "M4 11l8-7 8 7v9h-5v-6H9v6H4z", grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z", queue: "M3 6h13v2H3zM3 11h13v2H3zM3 16h8v2H3zM16 13v7l6-3.5z", add: "M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z",
  gear: "M4 7h9.2a3 3 0 015.6 0H20v2h-1.2a3 3 0 01-5.6 0H4zM4 15h1.2a3 3 0 015.6 0H20v2h-9.200a3 3 0 01-5.6 0H4z", check: "M9 16.200L4.800 12l-1.400 1.400L9 19 21 7l-1.400-1.400z", up: "M12 8l7 7-1.500 1.500L12 11l-5.500 5.500L5 15z", down: "M12 16L5 9l1.500-1.500L12 13l5.500-5.500L19 9z",
  close: "M6.400 5L12 10.600 17.600 5 19 6.400 13.400 12 19 17.600 17.600 19 12 13.400 6.400 19 5 17.600 10.600 12 5 6.400z", drag: "M9 5h2v2H9zM13 5h2v2h-2zM9 11h2v2H9zM13 11h2v2h-2zM9 17h2v2H9zM13 17h2v2h-2z", vol: "M4 9v6h4l5 4V5L8 9zM15 8.500a4 4 0 010 7zM15 5a7.500 7.500 0 010 14v-2a5.500 5.500 0 000-10z",
  moon: "M20 14.500A8 8 0 119.500 4 6.500 6.500 0 0020 14.500z", refresh: "M12 5a7 7 0 016.700 5H21l-3.500 4L14 10h2.600A5 5 0 007.500 9.800L6 8.400A7 7 0 0112 5zM6.500 10L10 14H7.400a5 5 0 009.100.200l1.500 1.400A7 7 0 015.300 14H3z", trash: "M8 5V3h8v2h5v2H3V5zM5 8h14l-1 13H6z", list: "M4 6h2v2H4zM8 6h12v2H8zM4 11h2v2H4zM8 11h12v2H8zM4 16h2v2H4zM8 16h12v2H8z",
};
const Icon = ({ n }: { n: string }) => <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d={I[n]} /></svg>;
const Btn = ({ n, label, onClick, cls = "", disabled }: { n: string; label: string; onClick: (e: any) => void; cls?: string; disabled?: boolean }) =>
  <button class={`ib ${cls}`} title={label} aria-label={label} disabled={disabled} onClick={(e) => { e.stopPropagation(); onClick(e); }}><Icon n={n} /></button>;
const Art = ({ src, cls = "" }: { src: string | null; cls?: string }) => {
  const [bad, setBad] = useState(false);
  useEffect(() => setBad(false), [src]);
  return src && !bad ? <img class={`art ${cls}`} src={src} alt="" loading="lazy" onError={() => setBad(true)} /> : <div class={`art none ${cls}`}><img src={`${BASE}/icon.svg`} alt="" /></div>;
};

// ------------------------------------------------------------ data
/** Fetches, and refetches whenever the server reports a change. */
function useData<T>(url: string | null): { data: T | null; error: string | null; reload: () => void } {
  const v = useStore(dataVersion);
  const [s, set] = useState<{ url: string | null; data: T | null; error: string | null }>({ url, data: null, error: null });
  const [n, bump] = useState(0);
  useEffect(() => {
    if (!url) return;
    let live = true;
    api<T>("GET", url).then((data) => live && set({ url, data, error: null }), (e) => live && set((o) => ({ url, data: o.url === url ? o.data : null, error: e.message })));
    return () => { live = false; };
  }, [url, v, n]);
  return { data: s.url === url ? s.data : null, error: s.error, reload: () => bump((x) => x + 1) };
}
const changed = () => dataVersion.set(dataVersion.value + 1);
const attempt = async (f: () => Promise<unknown>, ok?: string) => { try { await f(); if (ok) say(ok); changed(); } catch (e: any) { say(e.message); } };
const setPlayed = (ids: number[], played: boolean) => attempt(() => api("POST", "/episodes/played", { ids, played }), ids.length > 1 ? `Marked ${ids.length} as ${played ? "played" : "unplayed"}` : undefined);

// ------------------------------------------------------------ episode row
function Row({ e, showPodcast = true, handle, remove, sel, onSel }: { e: Episode; showPodcast?: boolean; handle?: ComponentChildren; remove?: () => void; sel?: boolean; onSel?: (shift: boolean) => void }) {
  const p = useStore(P.player);
  const current = p.ep?.id === e.id, playing = current && p.playing;
  const pos = current ? p.position : e.positionMs, total = e.durationMs ?? 0;
  return (
    <div class={`row ${e.played ? "played" : ""} ${current ? "current" : ""}`} data-id={e.id}>
      {onSel && <input type="checkbox" aria-label={`Select ${e.title}`} checked={sel} onClick={(x) => onSel((x as MouseEvent).shiftKey)} />}
      {handle}
      <Art src={e.image} />
      <div class="grow">
        <A to={`/episode/${e.id}`} class="title">{e.title}</A>
        <div class="sub">{showPodcast && <><A to={`/podcast/${e.feedId}`}>{e.podcast}</A> · </>}{day(e.pubDate)}{total ? ` · ${dur(total)}` : ""}{pos > 0 && total > 0 && !e.played ? ` · ${dur(total - pos) || "<1 min"} left` : ""}{e.played ? " · Played" : ""}</div>
        {pos > 0 && total > 0 && !e.played && <div class="bar"><i style={{ width: `${Math.min(100, (pos / total) * 100)}%` }} /></div>}
      </div>
      <Btn n={e.played ? "refresh" : "check"} label={e.played ? "Mark unplayed" : "Mark played"} cls="opt" onClick={() => setPlayed([e.id], !e.played)} />
      {remove ? <Btn n="close" label="Remove from Up Next" onClick={remove} /> : <Btn n="queue" label="Add to Up Next" cls="opt" onClick={() => P.addToQueue(e.id)} />}
      <Btn n={playing ? "pause" : "play"} label={playing ? "Pause" : "Play"} cls="tonal" onClick={() => (current ? P.toggle() : P.play(e.id))} />
    </div>
  );
}
const Empty = ({ children }: { children: ComponentChildren }) => <div class="empty"><img src={`${BASE}/icon.svg`} alt="" /><p>{children}</p></div>;
const Err = ({ m }: { m: string | null }) => (m ? <p class="err">{m}</p> : null);

// ------------------------------------------------------------ pages
function Home() {
  const n = useData<{ episodes: Episode[] }>("/new");
  const q = useData<{ items: Episode[]; hidden: number }>("/queue");
  return (
    <>
      <div class="head"><h1>Home</h1><Btn n="refresh" label="Refresh all feeds" onClick={() => attempt(() => api("POST", "/refresh", {}), "Feeds refreshed")} /></div>
      {q.data && q.data.items.length > 0 && <section><div class="head"><h2>Up Next</h2><A to="/queue" class="more">See all {q.data.items.length}</A></div>
        <div class="cards">{q.data.items.slice(0, 8).map((e) => <button class="card" key={e.id} onClick={() => P.play(e.id)} title={`Play ${e.title}`}><Art src={e.image} /><b>{e.title}</b><span class="sub">{e.podcast}</span></button>)}</div></section>}
      <section><h2>New episodes</h2><Err m={n.error} />
        {n.data?.episodes.map((e) => <Row e={e} key={e.id} />)}
        {n.data && !n.data.episodes.length && <Empty>No unplayed episodes from the last two weeks. <A to="/add">Add a podcast</A></Empty>}</section>
    </>
  );
}

function Library() {
  const { data, error } = useData<{ podcasts: Podcast[] }>("/library");
  return (
    <>
      <div class="head"><h1>Library</h1><A to="/add" class="btn tonal"><Icon n="add" /> Add</A></div><Err m={error} />
      <div class="grid">{data?.podcasts.map((p) => { const s = short(predict(p.releases)); return (
        <A to={`/podcast/${p.id}`} class="pod" key={p.id}><div class="wrap"><Art src={p.image} />{p.unplayed > 0 && <i class="badge">{p.unplayed > 999 ? "999+" : p.unplayed}</i>}</div>
          <b>{p.title}</b><span class="sub">{p.error ? <span class="late" title={p.error}>Refresh failed</span> : <span class={s.late ? "late" : ""}>{s.text}</span>}</span></A>); })}</div>
      {data && !data.podcasts.length && <Empty>No podcasts yet. <A to="/add">Add one</A> or import an OPML file in <A to="/settings">Settings</A>.</Empty>}
    </>
  );
}

function PodcastPage({ id }: { id: number }) {
  const { data: p, error } = useData<Podcast>(`/podcasts/${id}`);
  const [filter, setFilter] = useState("unplayed");
  const [limit, setLimit] = useState(60);
  const [sel, setSel] = useState<Set<number> | null>(null);
  const [more, setMore] = useState(false);
  const last = useRef<number | null>(null);
  if (!p) return <Err m={error} />;
  const eps = p.episodes!, list = eps.filter((e) => filter === "all" || (filter === "played") === e.played);
  const h = header(predict(eps.filter((e) => e.pubDate).slice(0, 40).map((e) => [e.pubDate!, e.type])));
  const pick = (eid: number, shift: boolean) => {
    const s = new Set(sel);
    const ids = list.map((e) => e.id);
    if (shift && last.current !== null) { const [a, b] = [ids.indexOf(last.current), ids.indexOf(eid)].sort((x, y) => x - y); ids.slice(Math.max(0, a), b + 1).forEach((x) => s.add(x)); }
    else s.has(eid) ? s.delete(eid) : s.add(eid);
    last.current = eid; setSel(s);
  };
  return (
    <>
      <div class="hero"><Art src={p.image} /><div class="grow">
        <h1>{p.title}</h1>{p.author && <div class="sub">{p.author}</div>}
        <div class={`pred ${h.late ? "late" : ""}`}><b>{h.head}</b><span>{h.detail}</span></div>
        <div class="actions">
          {p.subscribed ? <button class="btn" onClick={() => confirm(`Unsubscribe from ${p.title}? It will be removed from your other devices too.`) && attempt(async () => { await api("DELETE", `/subscriptions/${id}`); go("/library"); }, "Unsubscribed")}>Unsubscribe</button>
            : <button class="btn primary" onClick={() => attempt(() => api("POST", "/subscriptions", { url: p.feedUrl }), "Subscribed")}>Subscribe</button>}
          <button class="btn" onClick={() => attempt(async () => { const r = await api("POST", "/refresh", { podcastId: id }); if (r.error) throw new Error(r.error); }, "Refreshed")}><Icon n="refresh" /> Refresh</button>
          <label class="check"><input type="checkbox" checked={!!p.settings.exclude} onChange={(e) => attempt(() => api("PATCH", `/subscriptions/${id}`, { exclude: e.currentTarget.checked }))} /> Exclude from New episodes</label>
          <label class="check">Speed <select value={String(p.settings.speed ?? 1)} onChange={(e) => attempt(() => api("PATCH", `/subscriptions/${id}`, { speed: Number(e.currentTarget.value) }))}>{[...new Set([0.8, 1, 1.1, 1.2, 1.25, 1.5, 1.75, 2, 2.5, 3, p.settings.speed ?? 1])].sort().map((s) => <option value={String(s)}>{s}×</option>)}</select></label>
        </div></div></div>
      {p.error && <p class="err">Last refresh failed: {p.error}</p>}
      {p.description && <div class={`desc ${more ? "open" : ""}`} onClick={() => setMore(!more)}><Notes html={p.description} /></div>}
      <div class="tabs">
        {["unplayed", "played", "all"].map((f) => <button class={filter === f ? "on" : ""} onClick={() => { setFilter(f); setLimit(60); }}>{f[0].toUpperCase() + f.slice(1)} ({eps.filter((e) => f === "all" || (f === "played") === e.played).length})</button>)}
        <span class="grow" />
        {sel ? <>
          <span class="sub">{sel.size} selected</span>
          <button class="btn" onClick={() => setSel(new Set(list.map((e) => e.id)))}>All</button>
          <button class="btn tonal" disabled={!sel.size} onClick={() => { void setPlayed([...sel], true); setSel(null); }}>Mark played</button>
          <button class="btn tonal" disabled={!sel.size} onClick={() => { void setPlayed([...sel], false); setSel(null); }}>Mark unplayed</button>
          <button class="btn" onClick={() => setSel(null)}>Cancel</button>
        </> : <>
          <button class="btn" onClick={() => setSel(new Set())}>Select</button>
          <button class="btn" onClick={() => { const u = eps.filter((e) => !e.played); if (u.length && confirm(`Mark all ${u.length} episodes as played?`)) void setPlayed(u.map((e) => e.id), true); }}>Mark all played</button>
        </>}
      </div>
      {list.slice(0, limit).map((e) => <Row e={e} key={e.id} showPodcast={false} sel={sel?.has(e.id)} onSel={sel ? (s) => pick(e.id, s) : undefined} />)}
      {list.length > limit && <button class="btn wide" onClick={() => setLimit(limit + 200)}>Show more ({list.length - limit})</button>}
      {!list.length && <Empty>Nothing here.</Empty>}
    </>
  );
}

/** Finds playable timestamps the way the app does: not ratios, dates, clock times or anything past the end. */
const TS = /(?<![\d:.,/])(?:(\d{1,2}):([0-5]\d):([0-5]\d)|(\d{1,3}):([0-5]\d))(?![\d:]|\.\d|\s?(?:am|pm|a\.m\.|p\.m\.)\b)/gi;
function Notes({ html, duration, onSeek }: { html: string; duration?: number | null; onSeek?: (ms: number) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const cb = useRef(onSeek); cb.current = onSeek;
  useLayoutEffect(() => {
    const root = el.current!;
    root.innerHTML = html; // sanitised on the server
    if (!cb.current) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (w.nextNode()) if (!(w.currentNode.parentElement as HTMLElement).closest("a")) nodes.push(w.currentNode as Text);
    for (const n of nodes) {
      const t = n.data, frag = document.createDocumentFragment();
      let at = 0, hit = false;
      for (const m of t.matchAll(TS)) {
        const ms = (m[1] ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[4] * 60 + +m[5]) * 1000;
        if (duration && ms > duration + 1000) continue;
        hit = true;
        frag.append(t.slice(at, m.index));
        const b = document.createElement("button");
        b.className = "ts"; b.textContent = m[0]; b.onclick = () => cb.current?.(ms);
        frag.append(b); at = m.index + m[0].length;
      }
      if (hit) { frag.append(t.slice(at)); n.replaceWith(frag); }
    }
  }, [html, duration]);
  return <div class="notes" ref={el} />;
}

function ChapterList({ chapters, position, onPick }: { chapters: Chapter[]; position: number | null; onPick: (ms: number) => void }) {
  const vis = chapters.filter((c) => !c.hidden), cur = position === null ? null : P.chapterAt(vis, position);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { // keep the current chapter visible inside its own list, without scrolling the page
    const b = box.current, c = b?.querySelector<HTMLElement>(".cur");
    if (b && c && b.scrollHeight > b.clientHeight) b.scrollTop = c.offsetTop - b.offsetTop - c.clientHeight;
  }, [cur?.startMs]);
  return <div class="chapters" ref={box}>{vis.map((c) => (
    <button key={c.startMs} class={c === cur ? "cur" : ""} onClick={() => onPick(c.startMs)}><Art src={c.image ?? null} cls={c.image ? "" : "hide"} /><span class="grow">{c.title}</span><time>{fmt(c.startMs)}</time></button>))}</div>;
}

function EpisodePage({ id }: { id: number }) {
  const { data: e, error } = useData<Episode>(`/episodes/${id}`);
  const ch = useData<{ chapters: Chapter[]; source: string; image: string | null }>(`/episodes/${id}/chapters`).data;
  const p = useStore(P.player);
  if (!e) return <Err m={error} />;
  const current = p.ep?.id === id, playing = current && p.playing;
  const at = current ? p.position : null;
  const cur = at !== null && ch ? P.chapterAt(ch.chapters, at) : null;
  return (
    <>
      <div class="hero"><Art src={cur?.image ?? ch?.image ?? e.image} /><div class="grow">
        <A to={`/podcast/${e.feedId}`} class="sub">{e.podcast}</A><h1>{e.title}</h1>
        <div class="sub">{day(e.pubDate)}{e.durationMs ? ` · ${dur(e.durationMs)}` : ""}{e.positionMs > 0 && !e.played ? ` · at ${fmt(at ?? e.positionMs)}` : ""}{e.played ? " · Played" : ""}{e.lastDevice && !current && e.positionMs > 0 ? ` · last on ${e.lastDevice.name}` : ""}</div>
        <div class="actions">
          <button class="btn primary" onClick={() => (current ? P.toggle() : P.play(id))}><Icon n={playing ? "pause" : "play"} /> {playing ? "Pause" : e.positionMs > 0 && !e.played ? `Resume ${fmt(at ?? e.positionMs)}` : "Play"}</button>
          <button class="btn tonal" onClick={() => P.addToQueue(id, true)}>Play next</button>
          <button class="btn tonal" onClick={() => P.addToQueue(id)}><Icon n="queue" /> Add to Up Next</button>
          <button class="btn tonal" onClick={() => setPlayed([id], !e.played)}><Icon n="check" /> {e.played ? "Mark unplayed" : "Mark played"}</button>
          {e.link && /^https?:/.test(e.link) && <a class="btn" href={e.link} target="_blank" rel="noopener noreferrer">Website</a>}
        </div></div></div>
      {ch && ch.chapters.some((c) => !c.hidden) && <section><h2>Chapters ({ch.chapters.filter((c) => !c.hidden).length})</h2><ChapterList chapters={ch.chapters} position={at} onPick={(ms) => P.play(id, ms)} /></section>}
      <section><h2>Show notes</h2>{e.notes ? <Notes html={e.notes} duration={e.durationMs} onSeek={(ms) => P.play(id, ms)} /> : <p class="sub">No show notes.</p>}</section>
    </>
  );
}

/** 0.10.0: what was played before sits above Up Next (oldest at the top); the page opens at Up Next, scroll up for history. */
function History() {
  const { data } = useData<{ episodes: Episode[] }>("/history?limit=50");
  const top = useRef<HTMLHeadingElement>(null);
  const scrolled = useRef(false);
  useLayoutEffect(() => {
    if (!data || scrolled.current) return;
    scrolled.current = true;
    if (data.episodes.length) document.getElementById("upnext")?.scrollIntoView({ block: "start" });
  }, [data]);
  if (!data?.episodes.length) return null;
  return <section class="history" aria-label="Recently played"><h2 ref={top}>Recently played</h2>
    {[...data.episodes].reverse().map((e) => <Row e={e} key={`h${e.id}`} />)}</section>;
}

function Queue() {
  const { data, error } = useData<{ items: Episode[]; hidden: number }>("/queue");
  const [items, setItems] = useState<Episode[]>([]);
  const [drag, setDrag] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const live = useRef<Episode[]>([]);
  useEffect(() => { if (data && drag === null) { setItems(data.items); live.current = data.items; } }, [data]);
  const commit = (next: Episode[]) => { const base = data!.items; setItems(next); live.current = next; void P.putQueue(base, next).catch((e) => { say(e.message); setItems(base); }); };
  const start = (e: PointerEvent, id: number) => {
    e.preventDefault();
    const h = e.currentTarget as HTMLElement;
    h.setPointerCapture(e.pointerId);
    setDrag(id);
    let moved = false;
    const move = (ev: PointerEvent) => {
      const rows = [...box.current!.querySelectorAll<HTMLElement>(".row")];
      const over = rows.findIndex((r) => { const b = r.getBoundingClientRect(); return ev.clientY < b.top + b.height / 2; });
      const list = live.current, from = list.findIndex((x) => x.id === id);
      let to = over < 0 ? list.length : over;
      if (to > from) to--;
      if (to !== from) { const n = [...list]; const [x] = n.splice(from, 1); n.splice(to, 0, { ...x, auto: false }); live.current = n; setItems(n); moved = true; }
      if (ev.clientY < 80) window.scrollBy(0, -12); else if (ev.clientY > innerHeight - 160) window.scrollBy(0, 12);
    };
    const up = () => { h.removeEventListener("pointermove", move); h.removeEventListener("pointerup", up); h.removeEventListener("pointercancel", up); setDrag(null); if (moved) commit(live.current); };
    h.addEventListener("pointermove", move); h.addEventListener("pointerup", up); h.addEventListener("pointercancel", up);
  };
  const nudge = (i: number, d: number) => { const n = [...items]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; n[j] = { ...n[j], auto: false }; commit(n); };
  return (
    <>
      <History />
      <div class="head" id="upnext"><h1>Up Next</h1>{items.length > 0 && <button class="btn" onClick={() => confirm("Clear Up Next on all devices?") && commit([])}>Clear</button>}</div><Err m={error} />
      <div ref={box}>{items.map((e, i) => <div key={e.id} class={drag === e.id ? "dragging" : ""}><Row e={e} remove={() => commit(items.filter((x) => x.id !== e.id))}
        handle={<button class="ib handle" aria-label={`Reorder ${e.title} (drag, or arrow keys)`} title="Drag to reorder" onPointerDown={(x) => start(x as any, e.id)} onKeyDown={(k) => { if (k.key === "ArrowUp" || k.key === "ArrowDown") { k.preventDefault(); k.stopPropagation(); nudge(i, k.key === "ArrowUp" ? -1 : 1); } }}><Icon n="drag" /></button>} /></div>)}</div>
      {data && !items.length && <Empty>Up Next is empty. Use the queue button on any episode.</Empty>}
      {!!data?.hidden && <p class="sub">{data.hidden} more on your phone that this server can't show (their feeds haven't been fetched here).</p>}
    </>
  );
}

function Add() {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<any[] | null>(null);
  const isUrl = /^(https?|feed|itpc|pcast):\/\//i.test(q.trim()) || /^[\w-]+(\.[\w-]+)+\/\S+$/.test(q.trim());
  const sub = async (url: string) => { setBusy(true); try { const r = await api("POST", "/subscriptions", { url }); say(r.already ? `Already subscribed to ${r.title}` : `Subscribed to ${r.title}`); changed(); go(`/podcast/${r.id}`); } catch (e: any) { say(`Could not subscribe: ${e.message}`); } finally { setBusy(false); } };
  const submit = async (e: Event) => {
    e.preventDefault();
    if (!q.trim()) return;
    if (isUrl) return sub(q.trim());
    setBusy(true);
    try { setRes((await api("GET", `/search?q=${encodeURIComponent(q.trim())}`)).results); } catch (x: any) { say(x.message); } finally { setBusy(false); }
  };
  return (
    <>
      <h1>Add a podcast</h1>
      <form class="inline" onSubmit={submit}><input type="search" autofocus placeholder="Search podcasts, or paste a feed URL" value={q} onInput={(e) => setQ(e.currentTarget.value)} /><button class="btn primary" disabled={busy}>{busy ? "…" : isUrl ? "Subscribe" : "Search"}</button></form>
      {res?.map((r) => <div class="row" key={r.feedUrl}><Art src={r.image} /><div class="grow"><span class="title">{r.title}</span><div class="sub">{r.author}{r.genre ? ` · ${r.genre}` : ""}</div></div><button class="btn tonal" disabled={busy} onClick={() => sub(r.feedUrl)}>Subscribe</button></div>)}
      {res && !res.length && <Empty>No results.</Empty>}
    </>
  );
}

const download = async (p: string, name: string) => { try { const d = await api("GET", p); const u = URL.createObjectURL(new Blob([typeof d === "string" ? d : JSON.stringify(d, null, 2)])); const a = document.createElement("a"); a.href = u; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 1000); } catch (e: any) { say(e.message); } };
function FileBtn({ label, accept, onText }: { label: string; accept: string; onText: (t: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return <label class={`btn tonal ${busy ? "busy" : ""}`}>{busy ? "Importing…" : label}<input type="file" accept={accept} hidden disabled={busy} onChange={async (e) => { const i = e.currentTarget, f = i.files?.[0]; if (!f) return; setBusy(true); try { await onText(await f.text()); changed(); } catch (x: any) { say(x.message); } finally { setBusy(false); i.value = ""; } }} /></label>;
}

function Account({ acc, error }: { acc: any; error: string | null }) {
  if (!acc) return <Err m={error} />;
  const name = acc.oidc.providerName, i = acc.identity;
  return <section class="panel"><h2>Account</h2>
    <div class="line"><div class="grow"><b>{acc.displayName ?? acc.username}</b>{acc.isAdmin && <i class="chip">Admin</i>}
      <div class="sub">{acc.username} · signs in with {name}{i && [i.username, i.email].some(Boolean) ? ` as ${[i.username, i.email].filter(Boolean).join(" · ")}` : ""}{i?.lastLoginAt ? ` · last sign-in ${ago(i.lastLoginAt)}` : ""}</div></div></div>
    <p class="sub">Your name, email, passkeys and sign-in methods are managed in {name}.</p></section>;
}

function Users({ me: self, users, error }: { me: number; users: any; error: string | null }) {
  if (!users) return <section class="panel"><h2>Users</h2><Err m={error} /></section>;
  const name = users.providerName;
  return <section class="panel"><h2>Users</h2>
    <p class="sub">{users.autoCreate ? `People get an account here the first time they sign in with ${name}. Choose who may sign in there (the client's allowed groups) or with OIDC_ALLOWED_GROUPS.`
      : `New accounts aren't created automatically (OIDC_AUTO_CREATE=false), so only the people listed here can sign in. To add somebody, give them access in ${name} and let them sign in once while OIDC_AUTO_CREATE is true.`}</p>
    {users.users.map((u: any) => <div class="line" key={u.id}><div class="grow"><b>{u.username}</b>{u.displayName && u.displayName !== u.username ? ` (${u.displayName})` : ""}{u.isAdmin && <i class="chip">Admin</i>}
      <div class="sub">{u.oidc ? [name, u.email].filter(Boolean).join(" · ") : `Not linked to ${name}: can't sign in`} · {u.podcasts} podcasts · added {day(u.createdAt)}{u.lastLoginAt ? ` · last sign-in ${ago(u.lastLoginAt)}` : ""}</div></div>
      {u.id !== self && <button class="btn danger" onClick={() => confirm(`Delete ${u.username} and all their data?`) && attempt(() => api("DELETE", `/users/${u.id}`), "Deleted")}>Delete</button>}</div>)}</section>;
}

/** A labelled select bound to one synced setting. */
function PrefSelect<K extends keyof Prefs>({ k, label, options, unit = "" }: { k: K; label: string; options: [Prefs[K], string][]; unit?: string }) {
  const v = useStore(prefs)[k];
  // A value chosen in another app (e.g. 1.3×) stays listed and selected.
  const list = options.some(([x]) => x === v) ? options : [...options, [v, `${v}${unit}`] as [Prefs[K], string]].sort((a, b) => (typeof a[0] === "number" && typeof b[0] === "number" ? a[0] - b[0] : 0));
  return <label class="check">{label} <select value={String(v)} onChange={(e) => { const o = list.find(([x]) => String(x) === e.currentTarget.value); if (o) void setPref(k, o[0]); }}>
    {list.map(([x, t]) => <option value={String(x)}>{t}</option>)}</select></label>;
}
function PrefToggle({ k, label }: { k: "autoQueueEnabled" | "autoDownloadEnabled"; label: string }) {
  const v = useStore(prefs)[k];
  return <label class="check"><input type="checkbox" checked={v} onChange={(e) => void setPref(k, e.currentTarget.checked)} /> {label}</label>;
}
const secs = (xs: number[]) => xs.map((x) => [x, `${x} s`] as [number, string]);

function Settings() {
  const m = useStore(me)!, pr = useStore(prefs);
  const dev = useData<{ devices: any[] }>("/devices");
  const users = useData<any>(m.user.isAdmin ? "/users" : null);
  const acc = useData<any>("/me/account");
  const [res, setRes] = useState<string | null>(null);
  const signOut = async (provider: boolean) => { P.audio.pause(); let r: any = null; try { r = await api("POST", "/auth/logout", { provider }); } catch {} signedOut(); if (r?.endSessionUrl) location.href = r.endSessionUrl; };
  return (
    <>
      <h1>Settings</h1>
      <p class="sub">Playback, new-episode, download and appearance settings are the same on all your devices: a change here reaches your phone, tablet and Mac. Wi-Fi only, battery and storage options stay on each device, and downloaded files are never synced.</p>
      <section class="panel"><h2>Appearance</h2><div class="tabs" role="group" aria-label="Theme">{(["SYSTEM", "LIGHT", "DARK"] as const).map((x) => <button class={pr.themeMode === x ? "on" : ""} aria-pressed={pr.themeMode === x} onClick={() => void setPref("themeMode", x)}>{x[0] + x.slice(1).toLowerCase()}</button>)}</div></section>
      <section class="panel"><h2>Playback</h2><div class="actions">
        <PrefSelect k="defaultSpeed" label="Default speed" unit="×" options={[0.8, 1, 1.1, 1.2, 1.25, 1.5, 1.75, 2, 2.5, 3].map((x) => [x, `${x}×`])} />
        <PrefSelect k="skipBackSec" label="Skip back" unit=" s" options={secs([5, 10, 15, 20, 30, 45, 60])} />
        <PrefSelect k="skipForwardSec" label="Skip forward" unit=" s" options={secs([10, 15, 20, 30, 45, 60, 90, 120])} /></div>
        <p class="sub">A podcast's own speed (on its page) wins over the default.</p></section>
      <section class="panel"><h2>New episodes</h2><div class="actions">
        <PrefToggle k="autoQueueEnabled" label="Add new episodes to Up Next" />
        <PrefSelect k="autoQueuePosition" label="Add them at the" options={[["FRONT", "front"], ["BACK", "back"]]} />
        <PrefSelect k="newEpisodeTimeoutDays" label="Remove unplayed new episodes after" unit=" days" options={[[1, "1 day"], [3, "3 days"], [7, "7 days"], [14, "14 days"], [30, "30 days"], [0, "never"]]} /></div></section>
      <section class="panel"><h2>Downloads in the apps</h2><p class="sub">The browser streams; these rules tell each phone, tablet and Mac what to download for itself.</p><div class="actions">
        <PrefToggle k="autoDownloadEnabled" label="Download new episodes automatically" />
        <PrefSelect k="retentionMode" label="Keep" options={[["KEEP_ALL", "all downloads"], ["KEEP_LATEST", "the latest N per podcast"], ["DELETE_PLAYED", "until played"]]} />
        {pr.retentionMode === "KEEP_LATEST" && <PrefSelect k="retentionKeep" label="N =" options={[1, 2, 3, 5, 10, 20].map((x) => [x, String(x)])} />}</div></section>
      <section class="panel"><h2>Import & export</h2><div class="actions">
        <FileBtn label="Import OPML" accept=".opml,.xml,text/xml,text/x-opml" onText={async (x) => { const r = await api("POST", "/import/opml", x, { type: "text/xml" }); setRes(`Imported ${r.imported}, ${r.already} already subscribed${r.failed.length ? `, ${r.failed.length} failed: ${r.failed.map((f: any) => `${f.title} (${f.reason})`).join("; ")}` : ""}`); }} />
        <button class="btn" onClick={() => download("/export/opml", "patchcast-subscriptions.opml")}>Export OPML</button>
        <FileBtn label="Import play history" accept=".json,application/json" onText={async (x) => { const r = await api("POST", "/import/history", JSON.parse(x)); setRes(`Applied ${r.applied} of ${r.episodes} episode states, ${r.subscribed} new podcasts`); }} />
        <button class="btn" onClick={() => download("/export/history", "patchcast-history.json")}>Export play history</button></div>{res && <p>{res}</p>}</section>
      <section class="panel"><h2>Devices & tokens</h2><p class="sub">Phones sign in from Patchcast → Settings → Sync. Revoking a device signs it out at once.</p>
        {dev.data?.devices.map((d) => <div class="line" key={d.id}><div class="grow"><b>{d.name}</b>{d.current && <i class="chip">This browser</i>}<div class="sub">{d.kind === "app" ? "App token" : "Web session"} · last seen {ago(d.lastSeen)} · added {day(d.createdAt)}</div></div>
          <button class="btn" onClick={() => { const n = prompt("Device name", d.name); if (n) void attempt(() => api("PATCH", `/devices/${d.id}`, { name: n })); }}>Rename</button>
          {!d.current && <button class="btn danger" onClick={() => confirm(`Revoke ${d.name}?`) && attempt(() => api("DELETE", `/devices/${d.id}`), "Revoked")}>Revoke</button>}</div>)}</section>
      <Account acc={acc.data} error={acc.error} />
      {m.user.isAdmin && <Users me={m.user.id} users={users.data} error={users.error} />}
      <section class="panel"><h2>Keyboard</h2><p class="sub">Space/K play · J or ← back {pr.skipBackSec} s · L or → forward {pr.skipForwardSec} s · ↑↓ volume · N/P next/previous chapter · &lt; &gt; speed · M mute</p></section>
      <div class="actions"><button class="btn" onClick={() => signOut(false)}>Sign out</button>{acc.data?.sessionVia === "oidc" && <button class="btn" onClick={() => signOut(true)}>Sign out of {acc.data.oidc.providerName} too</button>}<span class="sub">{m.user.username} · Patchcast Sync {m.version}</span></div>
    </>
  );
}

// ------------------------------------------------------------ player
function Seek() {
  const p = useStore(P.player);
  const [drag, setDrag] = useState<number | null>(null);
  const d = p.duration || 1, at = drag ?? p.position;
  return (
    <div class="seek"><time>{fmt(at)}</time>
      <div class="track"><i class="fill" style={{ width: `${Math.min(100, (at / d) * 100)}%` }} />
        {p.chapters.filter((c) => !c.hidden && c.startMs > 0 && c.startMs < d).map((c) => <i class="tick" key={c.startMs} style={{ left: `${(c.startMs / d) * 100}%` }} title={c.title} />)}
        <input type="range" aria-label="Seek" min={0} max={d} step={1000} value={at} onInput={(e) => setDrag(Number(e.currentTarget.value))} onChange={(e) => { P.seek(Number(e.currentTarget.value)); setDrag(null); }} /></div>
      <time>-{fmt(Math.max(0, d - at))}</time></div>
  );
}
function SleepMenu() {
  const p = useStore(P.player);
  const on = p.sleepAt || p.sleepEnd;
  return <label class={`sel ${on ? "on" : ""}`} title="Sleep timer"><Icon n="moon" /><select aria-label="Sleep timer" value={p.sleepEnd ? "end" : p.sleepAt ? "on" : ""} onChange={(e) => { const v = e.currentTarget.value; P.player.patch({ sleepEnd: v === "end", sleepAt: v && v !== "end" && v !== "on" ? Date.now() + Number(v) * 60000 : v === "on" ? p.sleepAt : null }); }}>
    <option value="">Off</option>{p.sleepAt && <option value="on">{Math.max(1, Math.ceil((p.sleepAt - Date.now()) / 60000))} min</option>}{[5, 15, 30, 45, 60].map((m) => <option value={String(m)}>In {m} min</option>)}<option value="end">End of episode</option></select></label>;
}
function Controls() {
  const p = useStore(P.player), pr = useStore(prefs);
  return <div class="controls"><Btn n="prev" label="Previous chapter" onClick={P.prevChapter} /><button class="ib txt" title={`Back ${pr.skipBackSec} seconds`} aria-label={`Back ${pr.skipBackSec} seconds`} onClick={P.back}>−{pr.skipBackSec}</button>
    <Btn n={p.playing ? "pause" : "play"} label={p.playing ? "Pause" : "Play"} cls={`big ${p.buffering && p.playing ? "wait" : ""}`} onClick={P.toggle} />
    <button class="ib txt" title={`Forward ${pr.skipForwardSec} seconds`} aria-label={`Forward ${pr.skipForwardSec} seconds`} onClick={P.fwd}>+{pr.skipForwardSec}</button><Btn n="next" label="Next chapter" onClick={P.nextChapter} /></div>;
}
const Speed = () => { const p = useStore(P.player); return <label class="sel" title="Playback speed"><select aria-label="Playback speed" value={String(p.speed)} onChange={(e) => P.setSpeed(Number(e.currentTarget.value))}>{[...new Set([0.8, 1, 1.1, 1.2, 1.25, 1.5, 1.75, 2, 2.5, 3, p.speed])].sort((a, b) => a - b).map((s) => <option value={String(s)}>{s}×</option>)}</select></label>; };

/** 0.10.0: Show notes and Chapters sit in the same bar as Speed and Sleep; one panel is shown at a time. */
const panel = new Store<"notes" | "chapters" | null>(null);
function PlayerBar() {
  const p = useStore(P.player), open = useStore(expanded), pick = useStore(panel);
  if (!p.ep) return null;
  const c = P.chapterAt(p.chapters, p.position), art = c?.image ?? p.art;
  const nChapters = p.chapters.filter((x) => !x.hidden).length;
  const shown = pick === "chapters" && nChapters ? "chapters" : pick === "notes" || !nChapters ? "notes" : "chapters";
  const show = (x: "notes" | "chapters") => { panel.set(x); requestAnimationFrame(() => document.getElementById("now-panel")?.scrollIntoView({ behavior: "smooth", block: "start" })); };
  return (
    <>
      {open && <div class="now" role="dialog" aria-label="Now playing"><div class="inner">
        <div class="head"><Btn n="down" label="Close player" onClick={() => expanded.set(false)} /><span class="grow" /><A to={`/episode/${p.ep.id}`} class="btn">Episode page</A></div>
        <div class="cols"><div class="left"><Art src={art} cls="huge" /><h2>{p.ep.title}</h2><div class="sub">{p.ep.podcast}</div>{c && !c.hidden && <div class="chapter">{c.title}</div>}<Seek /><Controls />
          <div class="extras toolbar"><Speed /><SleepMenu />
            <button class={`btn ${shown === "notes" ? "on" : ""}`} aria-pressed={shown === "notes"} aria-controls="now-panel" aria-label="Show notes" onClick={() => show("notes")}>Notes</button>
            {nChapters > 0 && <button class={`btn ${shown === "chapters" ? "on" : ""}`} aria-pressed={shown === "chapters"} aria-controls="now-panel" aria-label={`Chapters, ${nChapters}`} onClick={() => show("chapters")}>Chapters {nChapters}</button>}
            </div><div class="extras"><Volume /></div>{p.via === "proxy" && <div class="sub">Streaming through your server</div>}<Err m={p.error} /></div>
          <div class="right" id="now-panel">{shown === "chapters" ? <><h3>Chapters ({nChapters})</h3><ChapterList chapters={p.chapters} position={p.position} onPick={P.seek} /></>
            : <><h3>Show notes</h3><Notes html={p.ep.notes ?? ""} duration={p.duration} onSeek={P.seek} /></>}</div></div></div></div>}
      <div class="player"><div class="info" onClick={() => expanded.set(!open)} role="button" tabIndex={0} aria-label="Open player" onKeyDown={(e) => e.key === "Enter" && expanded.set(!open)}><Art src={art} /><div class="grow"><b>{p.ep.title}</b><span class="sub">{p.error ?? (c && !c.hidden ? c.title : p.ep.podcast)}</span></div></div>
        <div class="mid"><Controls /><Seek /></div><div class="extras"><Speed /><SleepMenu /><Volume /></div></div>
    </>
  );
}

const Volume = () => { const p = useStore(P.player); return <label class="vol" title="Volume"><Icon n="vol" /><input type="range" aria-label="Volume" min={0} max={1} step={0.01} value={p.volume} onInput={(e) => P.setVolume(Number(e.currentTarget.value))} /></label>; };

function Banner() {
  const r = useStore(P.remote), p = useStore(P.player);
  if (!r || (p.playing && p.ep?.id !== r.ep.id) || (p.ep?.id === r.ep.id && Math.abs(p.position - r.positionMs) < 5000)) return null;
  return <div class="banner" role="status"><Art src={r.ep.image} /><div class="grow"><b>{r.playing ? `Playing on ${r.deviceName}` : "Continue on this device"}: {r.ep.title}</b><span class="sub">at {fmt(r.positionMs)} · from {r.deviceName} · {ago(r.at)}</span></div><button class="btn primary" onClick={P.continueHere}>Continue here</button><Btn n="close" label="Dismiss" onClick={P.dismissRemote} /></div>;
}

// ------------------------------------------------------------ sign in
function signedIn(m: Me) { setCsrf(m.csrf); me.set(m); P.connect(m.deviceId, BASE); void loadPrefs(); }
function signedOut() { P.disconnect(); P.audio.pause(); P.remote.set(null); me.set(null); }
whenUnauthorized(signedOut);

/** The only way in is the provider; there is no password form (0.8). */
function SignIn() {
  const [st, setSt] = useState<any>(null), [err, setErr] = useState<string | null>(null);
  useEffect(() => { api("GET", "/status").then(setSt, (e) => setErr(e.message)); }, []);
  return <main class="signin"><form onSubmit={(e) => e.preventDefault()}><img src={`${BASE}/icon.svg`} alt="" /><h1>Patchcast</h1>
    <p class="sub">Sign in to your sync server</p>
    {st && <a class="btn primary wide" href={`${BASE}/auth/oidc/login?returnTo=${encodeURIComponent(path.value + location.search)}`}>Sign in with {st.oidc.providerName}</a>}
    <Err m={err} /></form></main>;
}

function App() {
  const m = useStore(me), p = useStore(path), msg = useStore(toast), pl = useStore(P.player);
  useEffect(() => { api<Me>("GET", "/me").then(signedIn, (e) => { if (e instanceof ApiError && e.status === 401) me.set(null); else { say(e.message); setTimeout(() => location.reload(), 5000); } }); document.addEventListener("keydown", P.keys); return () => document.removeEventListener("keydown", P.keys); }, []);
  if (m === undefined) return <>{msg && <div class="toast" role="status">{msg}</div>}</>;
  if (m === null) return <SignIn />;
  const nav = [["/", "home", "Home"], ["/library", "grid", "Library"], ["/queue", "queue", "Up Next"], ["/add", "add", "Add"], ["/settings", "gear", "Settings"]];
  const id = Number(p.split("/")[2]);
  const page = p.startsWith("/podcast/") ? <PodcastPage id={id} key={p} /> : p.startsWith("/episode/") ? <EpisodePage id={id} key={p} /> : p === "/library" ? <Library /> : p === "/queue" ? <Queue /> : p === "/add" ? <Add /> : p === "/settings" ? <Settings /> : <Home />;
  return <div class={`shell ${pl.ep ? "has-player" : ""}`}><nav><A to="/" class="brand"><img src={`${BASE}/icon.svg`} alt="" /><b>Patchcast</b></A>{nav.map(([to, n, l]) => <A to={to} class={`item ${p === to ? "on" : ""}`} key={to}><Icon n={n} /><span>{l}</span></A>)}</nav>
    <main><Banner />{page}</main><PlayerBar />{msg && <div class="toast" role="status">{msg}</div>}</div>;
}
render(<App />, document.getElementById("app")!);
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname.endsWith(".localhost")))
  api("GET", "/status").then((s) => navigator.serviceWorker.register(`${BASE}/sw.js?v=${s.version}`, { scope: `${BASE}/` })).catch(() => {});
