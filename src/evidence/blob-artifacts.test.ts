import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Pool } from "pg";
import { caseArtifactStore, writeEvidenceTree } from "./blob.ts";

test("the Blob artifact boundary uses no-overwrite writes, accepts identical retries, and verifies all published hashes", async (t) => {
  const saved = { database: process.env.DATABASE_URL, token: process.env.BLOB_READ_WRITE_TOKEN, api: process.env.VERCEL_BLOB_API_URL };
  process.env.DATABASE_URL = "postgres://example.invalid/test";
  t.mock.method(Pool.prototype, "query", (async () => ({ rows: [] })) as unknown as typeof Pool.prototype.query);
  t.mock.method(Pool.prototype, "connect", (async () => ({ query: async (sql: string) => ({ rows: sql.startsWith("SELECT id FROM cases") ? [{ id: "fixture" }] : [] }), release: () => {} })) as unknown as typeof Pool.prototype.connect);
  const stored = new Map<string, Buffer>();
  const overwriteHeaders: string[] = [];
  let base = "";
  const metadata = (pathname: string) => ({ pathname, url: `${base}/bytes/${encodeURIComponent(pathname)}`, downloadUrl: `${base}/bytes/${encodeURIComponent(pathname)}`, etag: "fixture-v1", size: stored.get(pathname)!.byteLength, uploadedAt: "2026-11-05T00:00:00.000Z" });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    if (url.pathname.startsWith("/bytes/")) {
      const bytes = stored.get(decodeURIComponent(url.pathname.slice("/bytes/".length)));
      response.writeHead(bytes ? 200 : 404); response.end(bytes); return;
    }
    const json = (status: number, value: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    if (request.method === "PUT") {
      overwriteHeaders.push(String(request.headers["x-allow-overwrite"]));
      const pathname = url.searchParams.get("pathname")!;
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (stored.has(pathname)) { json(409, { error: { code: "pathname_conflict" } }); return; }
      stored.set(pathname, Buffer.concat(chunks));
      json(200, metadata(pathname)); return;
    }
    const prefix = url.searchParams.get("prefix");
    if (prefix) { json(200, { blobs: [...stored.keys()].filter((path) => path.startsWith(prefix)).map(metadata), hasMore: false }); return; }
    const pathname = url.searchParams.get("url")!;
    json(stored.has(pathname) ? 200 : 404, stored.has(pathname) ? metadata(pathname) : { error: { code: "not_found" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_local_test";
  process.env.VERCEL_BLOB_API_URL = base;
  try {
    const files = new Map([["instruction/sources/src_a/original.bin", "source"], ["evidence/E1.md", "canonical"], ["discussion/grok/run/draft.md", "analysis"], ["case.json", '{"usage":[]}']]);
    await caseArtifactStore.write("fixture", files);
    await caseArtifactStore.write("fixture", files);
    assert.ok(overwriteHeaders.length >= 6);
    assert.ok(overwriteHeaders.every((header) => header === "0"));
    assert.deepEqual([...await caseArtifactStore.read("fixture")].map(([path, bytes]) => [path, new TextDecoder().decode(bytes)]), [...files]);
    await assert.rejects(caseArtifactStore.write("fixture", new Map([["evidence/E1.md", "changed"]])));
    await assert.rejects(writeEvidenceTree("fixture", new Map([["evidence/E1.md", "changed"]])), /immutable host artifact writer/);
    stored.set("cases/fixture/evidence/partial.md", Buffer.from("unpublished"));
    assert.equal((await caseArtifactStore.read("fixture")).has("evidence/partial.md"), false);
    stored.set("cases/fixture/evidence/E1.md", Buffer.from("tampered"));
    await assert.rejects(caseArtifactStore.read("fixture"), /hash verification failed/);
  } finally {
    for (const [key, value] of [["DATABASE_URL", saved.database], ["BLOB_READ_WRITE_TOKEN", saved.token], ["VERCEL_BLOB_API_URL", saved.api]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
