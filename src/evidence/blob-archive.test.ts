import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Pool } from "pg";
import { findEvidenceArchive, hasEvidenceBase, writeCaseTranscript, writeEvidenceArchive } from "./blob.ts";

test("stores and locates the ZIP separately from the evidence tree using the Blob SDK", async (t) => {
  const database = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://example.invalid/test";
  t.after(() => { if (database === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = database; });
  t.mock.method(Pool.prototype, "query", (async () => ({ rows: [] })) as unknown as typeof Pool.prototype.query);
  t.mock.method(Pool.prototype, "connect", (async () => ({
    query: async (sql: string) => ({ rows: sql.startsWith("SELECT id FROM cases") ? [{ id: "case 1" }] : [] }),
    release: () => {},
  })) as unknown as typeof Pool.prototype.connect);
  const uploads: Array<{ pathname: string; headers: Record<string, string | string[] | undefined>; body: Buffer }> = [];
  let deny = false;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    if (request.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const pathname = url.searchParams.get("pathname")!;
      uploads.push({ pathname, headers: request.headers, body: Buffer.concat(chunks) });
      const blobUrl = `https://blob.test/${pathname}`;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ pathname, url: blobUrl, downloadUrl: `${blobUrl}?download=1`, etag: "v1", contentType: "application/zip" }));
      return;
    }
    const pathname = url.searchParams.get("url");
    if (deny || (pathname !== "cases/case%201/evidence/base/index.md" && (!uploads.length || pathname !== uploads[0]!.pathname))) {
      response.writeHead(deny ? 403 : 404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: deny ? "forbidden" : "not_found" } }));
      return;
    }
    const blobUrl = `https://blob.test/${pathname}`;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ pathname, url: blobUrl, downloadUrl: `${blobUrl}?download=1`, etag: "v1", size: 3, uploadedAt: "2026-11-03T00:00:00.000Z" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const savedToken = process.env.BLOB_READ_WRITE_TOKEN;
  const savedApi = process.env.VERCEL_BLOB_API_URL;
  try {
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_local_test";
    process.env.VERCEL_BLOB_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    assert.equal(await findEvidenceArchive("case 1"), undefined);
    assert.equal(await hasEvidenceBase("case 1"), true);
    assert.equal(await hasEvidenceBase("other"), false);
    const archive = await writeEvidenceArchive("case 1", Uint8Array.of(1, 2, 3));
    assert.deepEqual(archive, { downloadUrl: "https://blob.test/cases/case%201/case.zip?download=1", etag: "v1" });
    assert.equal(uploads[0]!.pathname, "cases/case%201/case.zip");
    assert.equal(uploads[0]!.headers["x-vercel-blob-access"], "public");
    assert.equal(uploads[0]!.headers["x-add-random-suffix"], "0");
    assert.equal(uploads[0]!.headers["x-allow-overwrite"], "1");
    assert.equal(uploads[0]!.headers["x-content-type"], "application/zip");
    assert.deepEqual(uploads[0]!.body, Buffer.from([1, 2, 3]));
    assert.deepEqual(await findEvidenceArchive("case 1"), archive);
    await writeCaseTranscript("case 1", '{"type":"statement"}\n');
    assert.equal(uploads[1]!.pathname, "cases/case%201/transcript.jsonl");
    assert.equal(uploads[1]!.headers["x-vercel-blob-access"], "public");
    assert.equal(uploads[1]!.headers["x-allow-overwrite"], "1");
    assert.equal(uploads[1]!.headers["x-content-type"], "application/x-ndjson; charset=utf-8");
    assert.equal(uploads[1]!.body.toString(), '{"type":"statement"}\n');
    deny = true;
    await assert.rejects(findEvidenceArchive("case 1"));
  } finally {
    if (savedToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN; else process.env.BLOB_READ_WRITE_TOKEN = savedToken;
    if (savedApi === undefined) delete process.env.VERCEL_BLOB_API_URL; else process.env.VERCEL_BLOB_API_URL = savedApi;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
