import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Pool } from "pg";
import { playTurn } from "./play.ts";

test("persists every returned web research step as part of the evidence tree", async (t) => {
  const database = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://example.invalid/test";
  t.after(() => { if (database === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = database; });
  t.mock.method(Pool.prototype, "query", (async () => ({ rows: [] })) as unknown as typeof Pool.prototype.query);
  t.mock.method(Pool.prototype, "connect", (async () => ({
    query: async (sql: string) => ({ rows: sql.startsWith("SELECT id FROM cases") ? [{ id: "case-1" }] : [] }),
    release: () => {},
  })) as unknown as typeof Pool.prototype.connect);
  const uploads = new Map<string, Buffer>();
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url!, "http://localhost").searchParams.get("pathname")!;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    uploads.set(pathname, Buffer.concat(chunks));
    const url = `https://blob.test/${pathname}`;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ pathname, url, downloadUrl: url, etag: "v1", contentType: "application/octet-stream" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const api = process.env.VERCEL_BLOB_API_URL;
  try {
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_local_test";
    process.env.VERCEL_BLOB_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const submission = { kind: "text" as const, text: "Una afirmación verificable para analizar." };
    const outcome = await playTurn("case-1", { submission, today: "hoy", simulated: true }, { kind: "instruction", counsel: "grok" }, [
      { type: "claims_entered", claims: [{ id: "A1", quote: "", text: submission.text }] },
    ], 0);
    assert.equal(outcome.done, true);
    const files = [...uploads].filter(([path]) => path.startsWith("cases/case-1/evidence/grok/research/"));
    assert.ok(files.length >= 2);
    const contents = files.map(([, body]) => JSON.parse(body.toString()));
    assert.ok(contents.every((entry) => entry.modelId === "court-fixture" && entry.effort === null && entry.seat === "grok" && entry.attempt === 0));
    assert.match(JSON.stringify(contents), /Documento de prueba con aportes/);
    for (const [path] of files) assert.ok([...uploads.keys()].some((key) => key.startsWith("cases/case-1/evidence/.sha256/") && key.endsWith(path.slice("cases/case-1/evidence/".length) + ".json")));
  } finally {
    if (token === undefined) delete process.env.BLOB_READ_WRITE_TOKEN; else process.env.BLOB_READ_WRITE_TOKEN = token;
    if (api === undefined) delete process.env.VERCEL_BLOB_API_URL; else process.env.VERCEL_BLOB_API_URL = api;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
