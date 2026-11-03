import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { courtSession } from "./court-session.ts";

test("a collection failure after opening marks the case as failed and rethrows", async (t) => {
  const env = ["DATABASE_URL", "COURT_AI_MODE", "BLOB_READ_WRITE_TOKEN", "VERCEL_OIDC_TOKEN", "BLOB_STORE_ID"] as const;
  const originalEnv = env.map((key) => [key, process.env[key]] as const);
  t.after(() => {
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.DATABASE_URL = "postgres://example.invalid/test";
  process.env.COURT_AI_MODE = "live";
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.VERCEL_OIDC_TOKEN;
  delete process.env.BLOB_STORE_ID;

  const caseId = "missing-image";
  const row = {
    id: caseId,
    created_at: "2026-11-03T00:00:00.000Z",
    status: "queued",
    submission: { kind: "image", mimeType: "image/png" },
    owner_id: null,
    error: null as string | null,
  };
  const closingUpdates: unknown[][] = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "DELETE FROM events WHERE case_id = $1") return { rows: [] };
      if (sql.startsWith("UPDATE cases SET status = 'in_session'")) {
        assert.deepEqual(values, [caseId]);
        row.status = "in_session";
        return { rows: [row] };
      }
      throw new Error(`Unexpected client query: ${sql}`);
    },
    release: () => {},
  };
  t.mock.method(Pool.prototype, "connect", (async () => client) as unknown as typeof Pool.prototype.connect);
  t.mock.method(Pool.prototype, "query", (async (sql: string, values?: unknown[]) => {
    if (sql.startsWith("CREATE TABLE") || sql.startsWith("SELECT case_id, seq, body FROM events")) return { rows: [] };
    if (sql.startsWith("SELECT mime_type, bytes FROM images")) {
      assert.deepEqual(values, [caseId]);
      assert.equal(row.status, "in_session");
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE cases SET status = $1, error = $2")) {
      closingUpdates.push(values!);
      row.status = values![0] as string;
      row.error = values![1] as string;
      return { rows: [] };
    }
    throw new Error(`Unexpected pool query: ${sql}`);
  }) as typeof Pool.prototype.query);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network access"); });

  const message = `No se encontró la imagen original del caso ${caseId}.`;
  await assert.rejects(courtSession(caseId), { message });
  assert.deepEqual(closingUpdates, [["failed", message, caseId]]);
  assert.equal(row.status, "failed");
  assert.equal(row.error, message);
});
