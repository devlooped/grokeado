import assert from "node:assert/strict";
import test from "node:test";
import { isIP } from "node:net";
import { downloadUrl, isBlockedAddress, shouldEscalateToBrowser, sniffExtension } from "./download.ts";

const lookup = async (host: string) => (isIP(host) ? [host] : ["8.8.8.8"]);

function response(body: BodyInit | null, status: number, headers?: HeadersInit): Response {
  return new Response(body, { status, headers });
}

test("blocks private, link-local, loopback and multicast addresses", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fc00::1", "fd00::1", "::ffff:127.0.0.1"]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  assert.equal(isBlockedAddress("8.8.8.8"), false);
  assert.equal(isBlockedAddress("1.1.1.1"), false);
});

test("rejects non-public URLs before downloading", async () => {
  let called = false;
  const fetchImpl: typeof fetch = async () => {
    called = true;
    return response("nope", 200);
  };
  for (const url of ["file:///etc/passwd", "https://user:pass@evil.test/a", "http://localhost/secret", "http://2130706433/", "http://metadata.google.internal/", "not a url"]) {
    const result = await downloadUrl(url, { fetchImpl, lookup });
    assert.equal(result.ok, false, url);
  }
  assert.equal(called, false);
});

test("stops redirects that land on a private address", async () => {
  const fetchImpl: typeof fetch = async () => response(null, 302, { location: "http://127.0.0.1/secret" });
  const result = await downloadUrl("https://evil.test/start", { fetchImpl, lookup });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /non-public/);
});

test("reports HTTP errors, redirect loops, empty bodies and size limits", async () => {
  const http = await downloadUrl("https://evil.test/missing", {
    lookup,
    fetchImpl: async () => response("missing", 404),
  });
  assert.deepEqual(http, { ok: false, error: "HTTP 404", status: 404 });

  const loop = await downloadUrl("https://evil.test/loop", {
    lookup,
    maxRedirects: 1,
    fetchImpl: async () => response(null, 302, { location: "/again" }),
  });
  assert.equal(loop.ok, false);
  if (!loop.ok) assert.equal(loop.error, "Too many redirects");

  const empty = await downloadUrl("https://evil.test/empty", {
    lookup,
    fetchImpl: async () => response("", 200),
  });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.error, "Downloaded file is empty");

  const declared = await downloadUrl("https://evil.test/big", {
    lookup,
    maxBytes: 4,
    fetchImpl: async () => response("hello", 200, { "content-length": "9" }),
  });
  assert.equal(declared.ok, false);
  if (!declared.ok) assert.equal(declared.error, "Response exceeds the size limit");

  const streamed = await downloadUrl("https://evil.test/stream", {
    lookup,
    maxBytes: 4,
    fetchImpl: async () => response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello world"));
        controller.close();
      },
    }), 200),
  });
  assert.equal(streamed.ok, false);
  if (!streamed.ok) assert.equal(streamed.error, "Response exceeds the size limit");
});

test("downloads a public response and counts redirects", async () => {
  let calls = 0;
  const result = await downloadUrl("https://evil.test/file", {
    lookup,
    fetchImpl: async (url) => {
      calls += 1;
      if (calls === 1) return response(null, 302, { location: "/final.txt" });
      assert.match(String(url), /\/final\.txt$/);
      return response("hello evidence", 200, { "content-type": "text/plain" });
    },
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(new TextDecoder().decode(result.bytes), "hello evidence");
    assert.equal(result.redirects, 1);
    assert.equal(result.finalUrl, "https://evil.test/final.txt");
  }
});

test("times out without following the body", async () => {
  const result = await downloadUrl("https://evil.test/slow", {
    lookup,
    fetchImpl: async () => {
      const error = new Error("timed out");
      error.name = "TimeoutError";
      throw error;
    },
  });
  assert.deepEqual(result, { ok: false, error: "Download timed out" });
});

test("sniffs file types from bytes before the declared type", () => {
  assert.equal(sniffExtension(Uint8Array.of(0x25, 0x50, 0x44, 0x46, 0x2d), "text/plain", "x.bin"), "pdf");
  assert.equal(sniffExtension(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), "application/octet-stream", "x"), "png");
  assert.equal(sniffExtension(new TextEncoder().encode("<html>"), "text/html", "page"), "html");
  assert.equal(sniffExtension(new TextEncoder().encode("a,b"), "text/csv", "table.csv"), "csv");
  assert.equal(sniffExtension(Uint8Array.of(1, 2, 3), "application/octet-stream", "notes.txt"), "txt");
});

test("default impit client still blocks non-public URLs before touching the network", async () => {
  const result = await downloadUrl("http://127.0.0.1/secret", { escalate: false });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /non-public/);
});

test("detects bot blocks, WAF challenges and JS SPA shells without escalating static pages or 404s", () => {
  assert.equal(shouldEscalateToBrowser({ ok: false, error: "HTTP 403", status: 403 }), true);
  assert.equal(shouldEscalateToBrowser({ ok: false, error: "HTTP 429", status: 429 }), true);
  assert.equal(shouldEscalateToBrowser({ ok: false, error: "HTTP 503", status: 503 }), true);
  assert.equal(shouldEscalateToBrowser({ ok: false, error: "Download timed out" }), true);
  assert.equal(shouldEscalateToBrowser({ ok: false, error: "HTTP 404", status: 404 }), false);
  assert.equal(shouldEscalateToBrowser({ ok: false, error: "URL resolves to a non-public address" }), false);
  assert.equal(shouldEscalateToBrowser({ ok: false, error: "Response exceeds the size limit", status: 200 }), false);

  const encode = (s: string) => new TextEncoder().encode(s);
  assert.equal(
    shouldEscalateToBrowser({
      ok: true,
      bytes: encode("<html><head><title>Just a moment...</title></head><body><script src='/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1'></script></body></html>"),
      contentType: "text/html",
      finalUrl: "https://portal.example.test/news",
      redirects: 0,
    }),
    true
  );
  assert.equal(
    shouldEscalateToBrowser({
      ok: true,
      bytes: encode("<!doctype html><html><body><div id='root'></div><script type='module' src='/assets/index.js'></script></body></html>"),
      contentType: "text/html",
      finalUrl: "https://spa.example.test/app",
      redirects: 0,
    }),
    true
  );
  assert.equal(
    shouldEscalateToBrowser({
      ok: true,
      bytes: encode("<!doctype html><html><body><article><h1>Informe oficial</h1><p>" + "palabra ".repeat(60) + "</p></article></body></html>"),
      contentType: "text/html",
      finalUrl: "https://portal.example.test/article",
      redirects: 0,
    }),
    false
  );
  assert.equal(
    shouldEscalateToBrowser({
      ok: true,
      bytes: Uint8Array.of(0x25, 0x50, 0x44, 0x46, 0x2d),
      contentType: "application/pdf",
      finalUrl: "https://portal.example.test/doc.pdf",
      redirects: 0,
    }),
    false
  );
});

test("escalates 403 and SPA shells to browserFetch while enforcing SSRF checks on browser redirects", async () => {
  const screenshot = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  let browserCalls = 0;

  const escalated = await downloadUrl("https://protected.example.test/article", {
    lookup,
    fetchImpl: async () => response("Attention Required! | Cloudflare", 403, { "content-type": "text/html" }),
    browserFetch: async (url, opts) => {
      browserCalls += 1;
      const allowed = await opts.assertPublic(url);
      assert.equal(allowed.ok, true);
      return {
        ok: true,
        bytes: new TextEncoder().encode("<!doctype html><html><body><article><p>Contenido renderizado tras challenge</p></article></body></html>"),
        contentType: "text/html; charset=utf-8",
        finalUrl: url,
        redirects: 0,
        via: "browserbase",
        screenshot,
      };
    },
  });
  assert.equal(browserCalls, 1);
  assert.equal(escalated.ok, true);
  if (escalated.ok) {
    assert.equal(escalated.via, "browserbase");
    assert.deepEqual(escalated.screenshot, screenshot);
    assert.match(new TextDecoder().decode(escalated.bytes), /Contenido renderizado/);
  }

  // Does not escalate on 404.
  await downloadUrl("https://protected.example.test/missing", {
    lookup,
    fetchImpl: async () => response("Not found", 404),
    browserFetch: async () => {
      browserCalls += 1;
      return { ok: false, error: "should not run" };
    },
  });
  assert.equal(browserCalls, 1);

  // Preserves SSRF block if the browser session navigates to a private IP.
  const ssrfBlocked = await downloadUrl("https://protected.example.test/spa", {
    lookup,
    fetchImpl: async () => response("<html><body><div id='__next'></div><script src='/main.js'></script></body></html>", 200, { "content-type": "text/html" }),
    browserFetch: async (_url, opts) => opts.assertPublic("http://127.0.0.1/admin") as Promise<never>,
  });
  assert.equal(ssrfBlocked.ok, false);
  if (!ssrfBlocked.ok) assert.match(ssrfBlocked.error, /non-public/);
});
