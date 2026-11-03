import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { findEvidenceArchive, hasEvidenceBase, writeEvidenceArchive } from "./blob.ts";

test("stores and locates the ZIP separately from the evidence tree using the Blob SDK", async () => {
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
    assert.deepEqual(archive, { downloadUrl: "https://blob.test/cases/case%201/expediente.zip?download=1", etag: "v1" });
    assert.equal(uploads[0]!.pathname, "cases/case%201/expediente.zip");
    assert.equal(uploads[0]!.headers["x-vercel-blob-access"], "public");
    assert.equal(uploads[0]!.headers["x-add-random-suffix"], "0");
    assert.equal(uploads[0]!.headers["x-allow-overwrite"], "1");
    assert.equal(uploads[0]!.headers["x-content-type"], "application/zip");
    assert.deepEqual(uploads[0]!.body, Buffer.from([1, 2, 3]));
    assert.deepEqual(await findEvidenceArchive("case 1"), archive);
    deny = true;
    await assert.rejects(findEvidenceArchive("case 1"));
  } finally {
    if (savedToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN; else process.env.BLOB_READ_WRITE_TOKEN = savedToken;
    if (savedApi === undefined) delete process.env.VERCEL_BLOB_API_URL; else process.env.VERCEL_BLOB_API_URL = savedApi;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
