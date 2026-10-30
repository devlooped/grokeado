import { test } from "node:test";
import assert from "node:assert/strict";
import { majority, project, type CourtEvent } from "./court.ts";

test("three matching votes out of four are a consensus", () => {
  assert.equal(majority(["verdadero", "verdadero", "verdadero", "falso"]), "verdadero");
  assert.equal(majority(["falso", "no_verificable", "falso", "falso"]), "falso");
  assert.equal(majority(["no_verificable", "no_verificable", "no_verificable"]), "no_verificable");
});

test("a three-way split or a missing majority goes to the judge", () => {
  assert.equal(majority(["verdadero", "falso", "no_verificable"]), undefined);
  assert.equal(majority(["verdadero"]), undefined);
  assert.equal(majority([]), undefined);
  assert.equal(majority(["verdadero", "verdadero", "falso", "falso"]), undefined);
});

test("projection attaches votes and judgments to claims and strikes sustained objections", () => {
  const events: CourtEvent[] = [
    { type: "claims_entered", claims: [{ id: "A1", quote: "q", text: "t" }] },
    { type: "statement", id: "I1", by: "gemini", stage: "opening", text: "x", evidenceIds: [] },
    { type: "objection", id: "O1", by: "claude", against: "I1", grounds: "g" },
    { type: "ruling", objectionId: "O1", sustained: true, reason: "r" },
    { type: "vote", by: "grok", claimId: "A1", verdict: "falso", rationale: "r" },
    { type: "judgment", claimId: "A1", verdict: "falso", method: "judge", reasoning: "r" },
    { type: "session_closed" },
  ];
  const view = project(events);
  assert.deepEqual([...view.struck], ["I1"]);
  assert.equal(view.claims[0].votes.grok?.verdict, "falso");
  assert.equal(view.claims[0].judgment?.method, "judge");
  assert.equal(view.closed, true);
});
