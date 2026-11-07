import assert from "node:assert/strict";
import { test } from "node:test";
import { stoppedRunSettled } from "./stopped-run.ts";

test("stopped runs must have no possibly executing steps across all pages", async () => {
  const calls: (string | undefined)[] = [];
  const list = async (_id: string, cursor?: string) => {
    calls.push(cursor);
    return cursor ? { data: [{ status: "running" }], hasMore: false, cursor: null } : { data: [{ status: "completed" }], hasMore: true, cursor: "next" };
  };
  assert.equal(await stoppedRunSettled("run", list), false);
  assert.deepEqual(calls, [undefined, "next"]);
  for (const step of [{ status: "pending" }, { status: "completed" }, { status: "failed" }]) {
    assert.equal(await stoppedRunSettled("run", async () => ({ data: [step], hasMore: false, cursor: null })), true);
  }
  for (const step of [{ status: "cancelled" }, { status: "pending", startedAt: new Date() }]) {
    assert.equal(await stoppedRunSettled("run", async () => ({ data: [step], hasMore: false, cursor: null })), false);
  }
  await assert.rejects(stoppedRunSettled("run", async () => ({ data: [], hasMore: true, cursor: null })), /cursor/);
});
