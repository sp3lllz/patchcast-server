export const BASE = document.querySelector<HTMLMetaElement>('meta[name="patchcast-base"]')!.content;
let csrf = "";
export const setCsrf = (t: string) => { csrf = t; };
export class ApiError extends Error { status: number; code: string; constructor(s: number, c: string, m: string) { super(m); this.status = s; this.code = c; } }
let onUnauthorized = () => {};
export const whenUnauthorized = (f: () => void) => { onUnauthorized = f; };

export async function api<T = any>(method: string, path: string, body?: unknown, opts: { type?: string; keepalive?: boolean } = {}): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${BASE}/api/v1${path}`, {
      method, credentials: "same-origin", keepalive: opts.keepalive,
      headers: { ...(method !== "GET" ? { "x-csrf-token": csrf } : {}), ...(body !== undefined ? { "content-type": opts.type ?? "application/json" } : {}) },
      body: body === undefined ? undefined : opts.type ? (body as string) : JSON.stringify(body),
    });
  } catch { throw new ApiError(0, "offline", "Can't reach the server"); }
  const json = (r.headers.get("content-type") ?? "").includes("json") ? await r.json() : await r.text();
  if (!r.ok) {
    if (r.status === 401 && !path.startsWith("/auth/")) onUnauthorized();
    throw new ApiError(r.status, json?.error ?? "error", json?.message ?? `HTTP ${r.status}`);
  }
  return json as T;
}

export interface Episode {
  id: number; feedId: number; title: string; podcast: string; audioUrl: string; audioProxy: string; durationMs: number | null; pubDate: number | null; image: string | null; podcastImage: string | null;
  link: string | null; played: boolean; positionMs: number; positionAt: number; lastPlayedAt: number | null; type: string | null; auto?: boolean; notes?: string; lastDevice?: { id: string; name: string } | null; hasTranscript?: boolean; persons?: Person[]; video?: { url: string; type: string; height: number | null; title: string | null } | null;
}
export interface Chapter { startMs: number; title: string; image?: string | null; url?: string | null; hidden?: boolean }
export interface Podcast {
  id: number; feedUrl: string; title: string; author: string | null; image: string | null; error: string | null; total: number; unplayed: number;
  settings: { speed?: number | null; priority?: number; exclude?: boolean; autoQueue?: boolean | null }; releases: [number, string | null][]; rating?: number; description?: string; episodes?: Episode[]; subscribed?: boolean; link?: string | null; persons?: Person[]; funding?: { url: string; text: string }[];
}
export interface Person { name: string; role: string; group: string; img: string | null; href: string | null }
export interface TranscriptLine { startMs: number | null; endMs: number | null; speaker: string | null; text: string }
export interface Transcript { timed: boolean; lines: TranscriptLine[]; source: string; language: string | null }
