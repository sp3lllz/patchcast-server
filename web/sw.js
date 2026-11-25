// App-shell cache only. API responses, art and audio are never cached here.
const CACHE = "patchcast-shell-" + new URL(location.href).searchParams.get("v");
const base = new URL("./", location.href).pathname;
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll([base, base + "icon.svg"])).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith("patchcast-shell-") && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith(base + "api/") || u.pathname.startsWith(base + "auth/")) return;
  const key = e.request.mode === "navigate" ? base : e.request;
  // Network first, so an updated server is picked up at once; the cache is the offline fallback.
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); } return r; })
    .catch(() => caches.match(key).then((r) => r || Response.error())));
});
