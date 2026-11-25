import { Parser } from "htmlparser2";

export function parseOpml(xml: string): { url: string; title: string | null }[] {
  const out: { url: string; title: string | null }[] = [];
  const p = new Parser({
    onopentag(name, attrs) {
      if (name.toLowerCase() !== "outline") return;
      const a = Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k.toLowerCase(), v]));
      const url = (a.xmlurl || a.url || "").trim();
      if (url && out.length < 5000) out.push({ url, title: a.title || a.text || null });
    },
  }, { xmlMode: true, decodeEntities: true });
  p.write(xml.replace(/^﻿/, "")); p.end();
  return out;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

export function writeOpml(items: { title: string; url: string; link?: string | null }[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>Patchcast subscriptions</title></head>\n  <body>\n` +
    items.map((i) => `    <outline type="rss" text="${esc(i.title)}" title="${esc(i.title)}" xmlUrl="${esc(i.url)}"${i.link ? ` htmlUrl="${esc(i.link)}"` : ""}/>\n`).join("") +
    `  </body>\n</opml>\n`;
}
