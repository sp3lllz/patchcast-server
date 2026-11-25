import { test } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import { checkUrl, isPublicAddress, safeFetch, safeOpen } from "../src/net.ts";
import { serve } from "./helpers.ts";

const code = (c: string) => (e: any) => { assert.equal(e.code, c, `${e.code}: ${e.message}`); return true; };

test("isPublicAddress rejects every non-global range", () => {
  for (const ip of ["127.0.0.1", "127.9.9.9", "0.0.0.0", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "192.0.0.1", "192.0.2.1",
    "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1", "255.255.255.255", "168.63.129.16", "::1", "::", "fe80::1", "fc00::1", "fd00:ec2::254", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe", "::127.0.0.1", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "2002:7f00:1::", "2002:a00:1::1", "2001:db8::1", "2001::1", "fe80::1%eth0", "garbage"])
    assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) assert.equal(isPublicAddress(ip), true, ip);
});

test("URL checks: schemes, credentials, odd IP spellings, local names", () => {
  for (const u of ["file:///etc/passwd", "ftp://example.com/", "gopher://example.com/", "data:text/plain,x", "http://user:pw@example.com/", "http://localhost/", "http://foo.localhost/", "http://printer.local/",
    "http://metadata.google.internal/", "http://127.0.0.1/", "http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/", "http://127.1/", "http://[::1]/", "http://[::ffff:169.254.169.254]/", "http://169.254.169.254/latest/meta-data/", "http://localhost./"])
    assert.throws(() => checkUrl(u), code("ssrf_blocked"), u);
  assert.throws(() => checkUrl("not a url"), code("bad_url"));
  checkUrl("https://atp.fm/rss");
});

test("DNS answers are checked at connect time (rebinding)", async (t) => {
  t.mock.method(dns, "lookup", ((_h: string, _o: any, cb: any) => cb(null, [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }])) as any);
  await assert.rejects(safeFetch("http://rebind.example/", { maxBytes: 100 }), code("ssrf_blocked"));
});

test("redirects are re-checked: to loopback, metadata and other schemes", async () => {
  const s = await serve((req, res) => {
    if (req.url === "/file") res.writeHead(302, { location: "file:///etc/passwd" });
    else if (req.url === "/meta") res.writeHead(301, { location: "http://169.254.169.254/latest/meta-data/" });
    else if (req.url === "/loop") res.writeHead(302, { location: "/loop" });
    else if (req.url === "/other") res.writeHead(307, { location: "http://127.0.0.1:1/" });
    res.end();
  });
  const allowHosts = new Set([s.host]);
  try {
    for (const p of ["/file", "/meta", "/other"]) await assert.rejects(safeFetch(s.url + p, { maxBytes: 100, allowHosts }), code("ssrf_blocked"), p);
    await assert.rejects(safeFetch(s.url + "/loop", { maxBytes: 100, allowHosts }), code("too_many_redirects"));
    await assert.rejects(safeFetch(s.url + "/", { maxBytes: 100 }), code("ssrf_blocked"));
  } finally { await s.close(); }
});

test("size limit (also after decompression), prefix reads and time limit", async () => {
  const zlib = await import("node:zlib");
  const s = await serve((req, res) => {
    if (req.url === "/bomb") { res.writeHead(200, { "content-encoding": "gzip" }); res.end(zlib.gzipSync(Buffer.alloc(5_000_000))); }
    else if (req.url === "/slow") { res.writeHead(200); res.write("x"); }
    else if (req.url === "/hang") { /* never answers */ }
    else res.end(Buffer.alloc(10_000));
  });
  const allowHosts = new Set([s.host]);
  try {
    await assert.rejects(safeFetch(s.url + "/big", { maxBytes: 5_000, allowHosts }), code("too_large"));
    await assert.rejects(safeFetch(s.url + "/bomb", { maxBytes: 100_000, allowHosts }), code("too_large"));
    assert.equal((await safeFetch(s.url + "/big", { maxBytes: 100, prefixOnly: true, allowHosts })).bytes.length, 100);
    await assert.rejects(safeFetch(s.url + "/slow", { maxBytes: 100, timeoutMs: 300, allowHosts }), code("timeout"));
    await assert.rejects(safeOpen(s.url + "/hang", { timeoutMs: 300, allowHosts }), code("timeout"));
  } finally { await s.close(); }
});
