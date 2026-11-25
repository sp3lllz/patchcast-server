/** Next-episode prediction: port of the app's ReleasePredictor (local time zone, last 5 release days). */
const DAY = 86_400_000;
export interface Expected { at: number; median: number; weekday: number | null; weekdaysOnly: boolean; confidence: "high" | "medium" | "low" }
export type Prediction = Expected | { irregular: "few" | "uneven" };

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : Math.floor((s[m - 1] + s[m]) / 2); };
const midnight = (t: number) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };

export function predict(releases: [number, string | null][]): Prediction {
  const byDay = new Map<number, number>();
  for (const [p, t] of releases) {
    if (t && ["trailer", "bonus"].includes(t.trim().toLowerCase())) continue;
    const k = midnight(p).getTime();
    byDay.set(k, Math.min(byDay.get(k) ?? Infinity, p));
  }
  const days = [...byDay.values()].sort((a, b) => b - a).slice(0, 5).reverse();
  if (days.length < 3) return { irregular: "few" };
  const gaps = days.slice(1).map((d, i) => d - days[i]);
  const med = median(gaps);
  if (med <= 0) return { irregular: "uneven" };
  const spread = median(gaps.map((g) => Math.abs(g - med))) / med;
  if (spread > 0.5) return { irregular: "uneven" };
  const confidence = spread <= 0.1 ? "high" : spread <= 0.25 ? "medium" : "low";
  const dates = days.map((d) => new Date(d));
  const counts = new Map<number, number>();
  for (const d of dates) counts.set(d.getDay(), (counts.get(d.getDay()) ?? 0) + 1);
  const [top, n] = [...counts].sort((a, b) => b[1] - a[1])[0];
  const weekday = n >= Math.max(3, days.length - 1) && med >= 5 * DAY ? top : null;
  const weekend = (d: Date) => d.getDay() === 0 || d.getDay() === 6;
  const weekdaysOnly = weekday === null && med <= DAY * 1.5 && dates.every((d) => !weekend(d));
  const latest = midnight(days[days.length - 1]);
  const plus = (d: Date, k: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + k);
  const step = Math.max(1, Math.round(med / DAY));
  let next: Date;
  if (weekday !== null) {
    const c = plus(latest, step);
    let diff = (weekday - c.getDay() + 7) % 7;
    if (diff > 3) diff -= 7;
    next = plus(c, diff);
    if (next <= latest) next = plus(next, 7);
  } else if (weekdaysOnly) { next = plus(latest, 1); while (weekend(next)) next = plus(next, 1); }
  else next = plus(latest, step);
  const sec = median(dates.map((d) => d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()));
  const at = new Date(next.getFullYear(), next.getMonth(), next.getDate(), Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), sec % 60).getTime();
  return { at, median: med, weekday, weekdaysOnly, confidence };
}

const WD = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const when = (t: number) => {
  const d = new Date(t);
  return `${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }).replace(",", "")}, ~${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
};
const overdue = (ms: number) => { const d = Math.floor(ms / DAY); return d >= 1 ? `Overdue by ${d} day${d === 1 ? "" : "s"}` : `Overdue by ${Math.floor(ms / 3600000)} h`; };
export function schedule(p: Expected): string {
  if (p.weekdaysOnly) return "usually every weekday";
  const d = Math.max(1, Math.round(p.median / DAY));
  const base = d === 1 ? "usually daily" : d >= 6 && d <= 8 ? "usually weekly" : d >= 13 && d <= 15 ? "usually fortnightly" : d >= 28 && d <= 31 ? "usually monthly" : `usually every ${d} days`;
  return p.weekday !== null ? `${base} on ${WD[p.weekday]}` : base;
}
export function short(p: Prediction, now = Date.now()): { text: string; late: boolean } {
  if ("irregular" in p) return { text: "Irregular schedule", late: false };
  const o = now - p.at;
  return o > 2 * 3600_000 ? { text: overdue(o), late: true } : { text: `Next: ${when(p.at)}`, late: false };
}
export function header(p: Prediction, now = Date.now()): { head: string; detail: string; late: boolean } {
  if ("irregular" in p) return { head: "Irregular schedule", detail: p.irregular === "few" ? "Not enough recent episodes to predict the next one" : "Recent releases are too uneven to predict", late: false };
  const o = now - p.at, late = o > 2 * 3600_000, s = schedule(p);
  return { head: late ? `${overdue(o)} (expected ${when(p.at)})` : `Next episode expected ${when(p.at)}`, detail: `${s[0].toUpperCase()}${s.slice(1)} · ${p.confidence} confidence`, late };
}
