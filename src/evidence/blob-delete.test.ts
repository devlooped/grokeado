import assert from "node:assert/strict";
import { test } from "node:test";
import { deleteCaseBlobs } from "./blob.ts";
import { startFakeR2 } from "./r2-fake.ts";

test("lists every page and removes only the requested case and alias artifacts", async (t) => {
  const r2 = await startFakeR2({ pageSize: 1 });
  t.after(() => r2.close());
  for (const key of ["cases/AA-123-BB/evidence/base/raw/a.pdf", "cases/AA-123-BB/case.zip", "cases/old_id/transcript.jsonl", "cases/AA-123-BBC/case.zip", "cases/other/case.zip"]) r2.store(key, Buffer.from("x"));
  await deleteCaseBlobs(["AA-123-BB", "old_id"]);
  assert.deepEqual([...r2.objects.keys()].sort(), ["cases/AA-123-BBC/case.zip", "cases/other/case.zip"]);
  const order = r2.requests.map((request) => request.method === "POST" ? "delete" : `${request.query.get("prefix")}${request.query.get("continuation-token") ? ":" + request.query.get("continuation-token") : ""}`);
  assert.deepEqual(order, ["cases/AA-123-BB/", "cases/AA-123-BB/:1", "delete", "cases/old_id/", "delete"]);
});
