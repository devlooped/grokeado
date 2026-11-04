import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { courtSession, linkEvidenceRun } from "./court-session.ts";
import type { TurnOutcome } from "../court/turns.ts";
import { COUNSEL_MODELS, MOCK_MODEL_ID } from "../court/models.ts";

test("links only statements to the promoted evidence run for their own attempt", () => {
  const outcome: TurnOutcome = { done: false, events: [
    { type: "statement", id: "I1", by: "grok", stage: "closing", text: "Argumento", evidenceIds: [], at: "2026-01-01T00:00:00.000Z" },
    { type: "vote", by: "grok", claimId: "A1", verdict: "verdadero", rationale: "Motivo", at: "2026-01-01T00:00:01.000Z" },
  ] };
  assert.deepEqual(linkEvidenceRun(outcome).events[0], { ...outcome.events[0], modelId: COUNSEL_MODELS.grok.id, effort: "high" });
  const linked = linkEvidenceRun(outcome, "run-1");
  assert.deepEqual(linked.events[0], { ...outcome.events[0], evidenceRunId: "run-1", modelId: COUNSEL_MODELS.grok.id, effort: "high" });
  assert.deepEqual(linkEvidenceRun(outcome, undefined, true).events[0], { ...outcome.events[0], modelId: MOCK_MODEL_ID, effort: null });
  assert.deepEqual(linked.events[1], outcome.events[1]);
  assert.notEqual(linked.events[0], outcome.events[0]);
});

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
    models: null as Record<string, { id: string; effort: string | null }> | null,
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
    if (sql.startsWith("CREATE TABLE") || sql.startsWith("SELECT case_id, seq, body FROM events") || sql.startsWith("SELECT role, model_id, effort FROM model_settings")) return { rows: [] };
    if (sql.startsWith("SELECT mime_type, bytes FROM images")) {
      assert.deepEqual(values, [caseId]);
      assert.equal(row.status, "in_session");
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE cases SET models = $2")) {
      assert.equal(values![0], caseId);
      row.models = JSON.parse(values![1] as string);
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
  assert.deepEqual(row.models?.judge, { id: "spacexai/grok-4.7", effort: "high" }, "the case keeps the models configured when it opened");
});
