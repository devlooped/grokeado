import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { getCaseProgress, type CaseProgress } from "./store.ts";

test("progress reads a single consistent, parameterized snapshot without loading event bodies", async (t) => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://example.invalid/test";
  t.after(() => { if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous; });
  let rows: CaseProgress[] = [{ status: "in_session", revision: 2, seq: 10 }];
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  t.mock.method(Pool.prototype, "query", (async (sql: string, values?: unknown[]) => {
    queries.push({ sql, values });
    return { rows: sql.startsWith("SELECT status, revision") ? rows : [] };
  }) as unknown as typeof Pool.prototype.query);
  const id = "case'; DROP TABLE cases; --";
  assert.deepEqual(await getCaseProgress(id), rows[0]);
  const query = queries.find(({ sql }) => sql.startsWith("SELECT status, revision"))!;
  assert.deepEqual(query.values, [id]);
  assert.match(query.sql, /COALESCE\(\(SELECT MAX\(seq\).*WHERE case_id = cases.id/);
  assert.match(query.sql, /FROM cases WHERE id = \$1$/);
  assert.doesNotMatch(query.sql, /body|submission|owner_id|audit/);
  rows = [];
  assert.equal(await getCaseProgress("missing"), undefined);
});
