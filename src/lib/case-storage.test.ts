import assert from "node:assert/strict";
import test from "node:test";
import type { StoredCaseRecord } from "../store.ts";
import { detectMissingCaseStorage, MISSING_CASE_STORAGE } from "./case-storage.ts";

const record = (status: StoredCaseRecord["status"]): StoredCaseRecord => ({ id: "AA-123-BB", createdAt: "2026-11-01T00:00:00.000Z", status, submission: { kind: "text", text: "x" }, revision: 3, pipelineVersion: 2 });

function deps(options: { configured?: boolean; exists?: boolean; updated?: boolean } = {}) {
  const calls: unknown[][] = [];
  return {
    calls,
    configured: () => options.configured ?? true,
    exists: async (id: string) => { calls.push(["exists", id]); return options.exists ?? false; },
    fail: async (id: string, revision: number, error: string) => { calls.push(["fail", id, revision, error]); return options.updated ?? true; },
  };
}

test("a resolved case without stored files becomes a failed run that can be rerun", async () => {
  const d = deps();
  const c = await detectMissingCaseStorage(record("resolved"), d);
  assert.equal(c.status, "failed");
  assert.equal(c.error, MISSING_CASE_STORAGE);
  assert.deepEqual(d.calls, [["exists", "AA-123-BB"], ["fail", "AA-123-BB", 3, MISSING_CASE_STORAGE]]);
});

test("cases with files, without storage, still running or already failed are left alone", async () => {
  for (const [c, d] of [[record("resolved"), deps({ exists: true })], [record("resolved"), deps({ configured: false })], [record("in_session"), deps()], [record("queued"), deps()], [record("failed"), deps()]] as const) {
    assert.equal(await detectMissingCaseStorage(c, d), c);
    assert.ok(!d.calls.some(([name]) => name === "fail"));
  }
});

test("a concurrent rerun keeps its state when the failure is not recorded", async () => {
  const c = record("resolved");
  assert.equal(await detectMissingCaseStorage(c, deps({ updated: false })), c);
});
