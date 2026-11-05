import assert from "node:assert/strict";
import test from "node:test";
import { MemoryOperationRepository } from "./source-store.ts";

test("one claimant owns a stage across independent callers, and publication is owner-only", async () => {
  const repository = new MemoryOperationRepository();
  const claims = await Promise.all(Array.from({ length: 4 }, () => repository.claim("fixture", "download", "acquisition", 1000)));
  assert.equal(claims.filter((claim) => claim.owned).length, 1);
  const winner = claims.find((claim) => claim.owned)!;
  assert.ok(winner.owned);
  await assert.rejects(repository.publish("fixture", "download", "impostor", {}), /ownership/);
  await repository.publish("fixture", "download", winner.owner, { hash: "verified" });
  assert.equal((await repository.claim("fixture", "download", "acquisition", 1000)).operation.status, "ready");
  assert.deepEqual((await repository.get("fixture", "download"))?.result, { hash: "verified" });
  assert.equal((await repository.claim("other-case", "download", "acquisition", 1000)).owned, true);
});

test("expired external work becomes uncertain and requires explicit reasoned recovery", async () => {
  let now = 0;
  const repository = new MemoryOperationRepository(() => now);
  const first = await repository.claim("fixture", "ocr", "extraction", 1000);
  assert.ok(first.owned);
  now = 1001;
  const retry = await repository.claim("fixture", "ocr", "extraction", 1000);
  assert.equal(retry.owned, false);
  assert.equal(retry.operation.status, "uncertain");
  await assert.rejects(repository.publish("fixture", "ocr", first.owner, {}), /ownership/);
  await assert.rejects(repository.recover("fixture", "ocr", ""), /reason/);
  await repository.recover("fixture", "ocr", "Operator confirmed retry after worker loss");
  const recovered = await repository.claim("fixture", "ocr", "extraction", 1000);
  assert.ok(recovered.owned);
  assert.equal(recovered.operation.recoveries.length, 1);
  await repository.publish("fixture", "ocr", recovered.owner, {});
  await assert.rejects(repository.recover("fixture", "ocr", "repeat paid stage"), /Only failed/);
});

test("known failures and verified aliases are shared without automatic retry", async () => {
  const repository = new MemoryOperationRepository();
  const claim = await repository.claim("fixture", "translate", "translation", 1000);
  assert.ok(claim.owned);
  await repository.fail("fixture", "translate", claim.owner, "Translation unavailable", false);
  assert.equal((await repository.claim("fixture", "translate", "translation", 1000)).operation.status, "failed");
  assert.equal(await repository.alias("fixture", "https://example.test/", "src_a"), "src_a");
  assert.equal(await repository.alias("fixture", "https://example.test/", "src_b"), "src_a");
  assert.equal(await repository.resolve("fixture", "https://example.test/"), "src_a");
  assert.equal(await repository.resolve("other", "https://example.test/"), undefined);
});
