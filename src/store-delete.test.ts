import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Pool } from "pg";
import { deleteCase, withCaseWriteLock } from "./store.ts";

function fakeDatabase(t: TestContext, status: string | undefined) {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://example.invalid/test";
  t.after(() => { if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous; });
  const calls: string[] = [];
  t.mock.method(Pool.prototype, "query", (async () => ({ rows: [] })) as unknown as typeof Pool.prototype.query);
  t.mock.method(Pool.prototype, "connect", (async () => ({
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.startsWith("SELECT status")) return { rows: status ? [{ status }] : [] };
      if (sql.startsWith("SELECT old_id")) return { rows: [{ old_id: "old-id" }] };
      if (sql.startsWith("SELECT id")) return { rows: status ? [{ id: "AA-123-BB" }] : [] };
      return { rows: [] };
    },
    release: () => { calls.push("release"); },
  })) as unknown as typeof Pool.prototype.connect);
  return calls;
}

test("deletes aliases and all related blobs before committing the cascading case delete", async (t) => {
  const calls = fakeDatabase(t, "resolved");
  assert.equal(await deleteCase("AA-123-BB", async (ids) => { calls.push("blob"); assert.deepEqual(ids, ["AA-123-BB", "old-id"]); }), "deleted");
  assert.deepEqual(calls, ["BEGIN", "SELECT status FROM cases WHERE id = $1 FOR UPDATE", "SELECT old_id FROM case_aliases WHERE case_id = $1", "blob", "DELETE FROM cases WHERE id = $1", "COMMIT", "release"]);
});

test("does not delete active or missing cases and rolls back if blob cleanup fails", async (t) => {
  for (const [status, expected] of [["queued", "active"], ["in_session", "active"], [undefined, "missing"]] as const) {
    await t.test(String(status), async (sub) => {
      const calls = fakeDatabase(sub, status);
      assert.equal(await deleteCase("AA-123-BB", async () => { throw new Error("unexpected"); }), expected);
      assert.ok(calls.includes("ROLLBACK"));
      assert.ok(!calls.some((sql) => sql.startsWith("DELETE")));
    });
  }
  await t.test("failed cleanup", async (sub) => {
    const calls = fakeDatabase(sub, "failed");
    await assert.rejects(deleteCase("AA-123-BB", async () => { throw new Error("storage failed"); }), /storage failed/);
    assert.ok(calls.includes("ROLLBACK"));
    assert.ok(!calls.some((sql) => sql.startsWith("DELETE")));
  });
});

test("writes hold a shared case lock and stop if the case has been deleted", async (t) => {
  await t.test("existing", async (sub) => {
    const calls = fakeDatabase(sub, "resolved");
    assert.equal(await withCaseWriteLock("AA-123-BB", async () => { calls.push("write"); return 42; }), 42);
    assert.deepEqual(calls, ["BEGIN", "SELECT id FROM cases WHERE id = $1 FOR KEY SHARE", "write", "COMMIT", "release"]);
  });
  await t.test("deleted", async (sub) => {
    const calls = fakeDatabase(sub, undefined);
    await assert.rejects(withCaseWriteLock("AA-123-BB", async () => { throw new Error("must not write"); }), /ya no existe/);
    assert.ok(calls.includes("ROLLBACK"));
  });
});
