import assert from "node:assert/strict";
import { test } from "node:test";
import { caseCardImageUrl, caseCardVotes } from "./case-card.ts";
import { project, type CourtEvent } from "./court.ts";

test("card voters are paired with each judged claim and exclude dissenters and absent analysts", () => {
  const events: CourtEvent[] = [
    { type: "claims_entered", claims: [
      { id: "A1", quote: "one", text: "one" }, { id: "A2", quote: "two", text: "two" }, { id: "A3", quote: "three", text: "three" },
    ] },
    { type: "vote", by: "grok", claimId: "A1", verdict: "falso", rationale: "" },
    { type: "vote", by: "gemini", claimId: "A1", verdict: "verdadero", rationale: "" },
    { type: "vote", by: "grok", claimId: "A2", verdict: "verdadero", rationale: "" },
    { type: "vote", by: "claude", claimId: "A2", verdict: "verdadero", rationale: "" },
    { type: "judgment", claimId: "A1", verdict: "falso", method: "judge", reasoning: "" },
    { type: "judgment", claimId: "A2", verdict: "verdadero", method: "consensus", reasoning: "" },
  ];
  assert.deepEqual(caseCardVotes(project(events)), [
    { id: "A1", verdict: "falso", models: ["grok"] },
    { id: "A2", verdict: "verdadero", models: ["grok", "claude"] },
  ]);
});

test("case card URLs encode the id and cover version", () => {
  assert.equal(caseCardImageUrl("A B"), "/c/A%20B/card");
  assert.equal(caseCardImageUrl("A", "v&1"), "/c/A/card?v=v%261");
});
