/** Feed/enclosure identity. Must stay in step with the app's UrlUtils / HistoryMatcher. */

export function normalizeFeedUrl(raw: string): string | null {
  let u = raw.trim().replaceAll(" ", "%20");
  if (!u) return null;
  const l = u.toLowerCase();
  if (/^(feed|itpc|pcast|podcast):\/\//.test(l)) u = "https://" + u.slice(u.indexOf("://") + 3);
  else if (l.startsWith("feed:http")) return normalizeFeedUrl(u.slice(5));
  else if (l.startsWith("http://")) u = "https://" + u.slice(7);
  else if (l.startsWith("https://")) u = "https://" + u.slice(8);
  else if (!l.includes("://")) u = "https://" + u;
  else return null;
  const host = u.slice(8).split("/")[0].split("?")[0];
  if (!host || (!host.includes(".") && !host.startsWith("localhost") && !host.includes(":"))) return null;
  try { new URL(u); } catch { return null; }
  return u;
}

export function feedKey(url: string): string {
  const s = url.trim();
  const i = s.indexOf("://");
  const noScheme = i >= 0 ? s.slice(i + 3) : s;
  const slash = noScheme.indexOf("/");
  const host = (slash >= 0 ? noScheme.slice(0, slash) : noScheme).toLowerCase().replace(/^www\./, "");
  const rest = slash >= 0 ? noScheme.slice(slash + 1).replace(/\/+$/, "") : "";
  return `${host}/${rest}`;
}

export function enclosureKey(url: string): string {
  const s = url.trim();
  const i = s.indexOf("://");
  const noScheme = i >= 0 ? s.slice(i + 3) : s;
  const slash = noScheme.indexOf("/");
  const host = (slash >= 0 ? noScheme.slice(0, slash) : noScheme).toLowerCase().replace(/^www\./, "");
  const path = slash >= 0 ? noScheme.slice(slash + 1).split("?")[0].split("#")[0] : "";
  return `${host}/${path}`;
}

export const httpFallback = (url: string) => (/^https:\/\//i.test(url) ? "http://" + url.slice(8) : null);
