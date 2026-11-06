import assert from "node:assert/strict";
import test from "node:test";
import { caseStorageExists } from "./blob.ts";
import { startFakeR2 } from "./r2-fake.ts";

test("detects whether a case folder exists, without matching other cases with the same prefix", async (t) => {
  const r2 = await startFakeR2();
  t.after(() => r2.close());
  r2.store("cases/AA-123-BBC/case.zip", Buffer.from("x"));
  assert.equal(await caseStorageExists("AA-123-BB"), false);
  r2.store("cases/AA-123-BB/instruction/base/submission.json", Buffer.from("{}"));
  assert.equal(await caseStorageExists("AA-123-BB"), true);
  assert.equal(r2.requests.at(-1)?.query.get("max-keys"), "1");
});
