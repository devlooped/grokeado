import assert from "node:assert/strict";
import test from "node:test";
import { isCaseId, newCaseId } from "./case-id.ts";

test("case ids follow the AA-NNN-AA plate format", () => {
  for (let i = 0; i < 1000; i++) assert.ok(isCaseId(newCaseId()));
});

test("case ids span the whole alphabet and every digit", () => {
  assert.equal(newCaseId(() => 0), "AA-000-AA");
  assert.equal(newCaseId((max) => max - 1), "ZZ-999-ZZ");
});

test("legacy base64url ids are not plate ids", () => {
  assert.equal(isCaseId("IMAK5-uD"), false);
  assert.equal(isCaseId("ab-123-cd"), false);
});
