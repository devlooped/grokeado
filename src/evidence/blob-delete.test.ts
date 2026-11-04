import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { deleteCaseBlobs } from "./blob.ts";

test("lists every page and removes only the requested case and alias artifacts", async () => {
  const requests: string[] = [];
  const deleted: string[][] = [];
  const blob = (pathname: string) => ({ pathname, url: "https://blob.test/" + pathname, downloadUrl: "https://blob.test/" + pathname, size: 1, uploadedAt: "2026-01-01T00:00:00.000Z", etag: "v1" });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    if (req.method === "POST") {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push("delete"); deleted.push(JSON.parse(Buffer.concat(chunks).toString()).urls);
      res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); return;
    }
    const prefix = url.searchParams.get("prefix")!;
    const cursor = url.searchParams.get("cursor");
    requests.push(prefix + (cursor ? ":" + cursor : ""));
    const first = prefix === "cases/AA-123-BB/" && !cursor;
    const pathname = prefix + (first ? "evidence/base/raw/a.pdf" : cursor ? "case.zip" : "transcript.jsonl");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ blobs: [blob(pathname)], hasMore: first, ...(first ? { cursor: "next" } : {}) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const token = process.env.BLOB_READ_WRITE_TOKEN, api = process.env.VERCEL_BLOB_API_URL;
  try {
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_local_test";
    process.env.VERCEL_BLOB_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await deleteCaseBlobs(["AA-123-BB", "old_id"]);
    assert.deepEqual(requests, ["cases/AA-123-BB/", "cases/AA-123-BB/:next", "delete", "cases/old_id/", "delete"]);
    assert.deepEqual(deleted, [["https://blob.test/cases/AA-123-BB/evidence/base/raw/a.pdf", "https://blob.test/cases/AA-123-BB/case.zip"], ["https://blob.test/cases/old_id/transcript.jsonl"]]);
  } finally {
    if (token === undefined) delete process.env.BLOB_READ_WRITE_TOKEN; else process.env.BLOB_READ_WRITE_TOKEN = token;
    if (api === undefined) delete process.env.VERCEL_BLOB_API_URL; else process.env.VERCEL_BLOB_API_URL = api;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
