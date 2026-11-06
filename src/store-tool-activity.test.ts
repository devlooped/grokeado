import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { getCaseToolActivities, recordCaseToolActivity } from "./store.ts";
import type { ToolActivity } from "./domain/tool-activity.ts";

test("activity uses idempotent parameterized writes, retains the first invocation time and reads only public tool records", async (t) => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://example.invalid/test";
  t.after(() => { if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous; });
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const rows = new Map<string, unknown>();
  t.mock.method(Pool.prototype, "query", (async (sql: string, values?: unknown[]) => {
    queries.push({ sql, values });
    if (sql.startsWith("INSERT INTO case_audit_records") && !rows.has(String(values![1]))) rows.set(String(values![1]), JSON.parse(String(values![2])));
    if (sql.startsWith("SELECT body FROM case_audit_records")) return { rows: [...rows.values(), { kind: "model_step", messages: "PRIVATE CHECKPOINT" }].map((body) => ({ body })) };
    return { rows: [], rowCount: 1 };
  }) as unknown as typeof Pool.prototype.query);
  const activity: ToolActivity = { schemaVersion: 2, id: "tool:first", kind: "tool_call", at: "2026-11-06T00:00:00.000Z", seat: "claude", modelId: "anthropic/test", effort: null, data: { tool: "x_search", query: "original public statement" } };
  const caseId = "case'; DROP TABLE cases; --";
  await recordCaseToolActivity(caseId, activity);
  await recordCaseToolActivity(caseId, { ...activity, at: "2026-11-06T00:00:05.000Z" });
  assert.deepEqual(await getCaseToolActivities(caseId), [activity]);
  const insert = queries.find(({ sql }) => sql.startsWith("INSERT INTO case_audit_records"))!;
  assert.match(insert.sql, /ON CONFLICT \(case_id, record_id\) DO NOTHING$/);
  assert.deepEqual(insert.values, [caseId, activity.id, JSON.stringify(activity)]);
  const select = queries.find(({ sql }) => sql.startsWith("SELECT body FROM case_audit_records"))!;
  assert.match(select.sql, /case_id = \$1 AND record_id LIKE 'tool:%'/);
  assert.deepEqual(select.values, [caseId]);
});
