import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { deleteAdminNotification } from "./store.ts";

test("notification deletion uses a validated parameterized ID and reports missing rows", async (t) => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://example.invalid/test";
  t.after(() => { if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous; });
  let affectedRows = 1;
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  t.mock.method(Pool.prototype, "query", (async (sql: string, values?: unknown[]) => {
    queries.push({ sql, values });
    return { rows: [], rowCount: sql.startsWith("DELETE FROM admin_notifications") ? affectedRows : 0 };
  }) as unknown as typeof Pool.prototype.query);

  assert.equal(await deleteAdminNotification("42"), true);
  const deletion = queries.find(({ sql }) => sql.startsWith("DELETE FROM admin_notifications"));
  assert.ok(deletion);
  assert.match(deletion.sql, /^DELETE FROM admin_notifications WHERE id = \$1::bigint$/);
  assert.deepEqual(deletion.values, ["42"]);

  affectedRows = 0;
  assert.equal(await deleteAdminNotification("43"), false);
});
