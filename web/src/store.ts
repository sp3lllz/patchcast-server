import { useEffect, useState } from "preact/hooks";

/** Minimal observable value. */
export class Store<T> {
  value: T;
  private subs = new Set<() => void>();
  constructor(v: T) { this.value = v; }
  set(v: T) { if (v !== this.value) { this.value = v; for (const s of [...this.subs]) s(); } }
  patch(p: Partial<T>) { this.set({ ...this.value, ...p }); }
  sub(f: () => void) { this.subs.add(f); return () => { this.subs.delete(f); }; }
}
export function useStore<T>(s: Store<T>): T {
  const [, force] = useState(0);
  const rendered = s.value;
  useEffect(() => {
    if (s.value !== rendered) force((n) => n + 1); // changed between render and subscription
    return s.sub(() => force((n) => n + 1));
  }, [s]);
  return rendered;
}
/** Bumped whenever the server says data changed; views refetch on it. */
export const dataVersion = new Store(0);
export const toast = new Store<string | null>(null);
let t = 0;
export function say(m: string) { toast.set(m); clearTimeout(t); t = window.setTimeout(() => toast.set(null), 4500); }

export const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`;
};
export const dur = (ms: number | null) => { if (!ms) return ""; const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`; };
export const day = (t: number | null) => {
  if (!t) return "";
  const d = new Date(t), days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(t).setHours(0, 0, 0, 0)) / 86400000);
  if (days === 0) return "Today"; if (days === 1) return "Yesterday"; if (days > 1 && days < 7) return d.toLocaleDateString("en-GB", { weekday: "long" });
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
};
export const ago = (t: number) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
