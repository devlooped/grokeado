import assert from "node:assert/strict";
import { test } from "node:test";
import { caseShareMetadata } from "./case.ts";
import { type CaseRecord, type CourtEvent } from "./court.ts";

const c: CaseRecord = { id: "ABC", createdAt: "2026-01-01", status: "resolved", submission: { kind: "link", url: "https://example.org" } };
const claims: CourtEvent = { type: "claims_entered", claims: [{ id: "A1", quote: "Original", text: "La afirmación" }] };

test("sharing shows the claim and one overall outcome, not the submission or votes", () => {
  const events: CourtEvent[] = [claims,
    { type: "vote", by: "grok", claimId: "A1", verdict: "verdadero", rationale: "" },
    { type: "judgment", claimId: "A1", verdict: "falso", method: "judge", reasoning: "" },
  ];
  assert.deepEqual(caseShareMetadata(c, events), { title: "Caso Nº ABC · CheBot · 👎", description: "«La afirmación» 👎" });
});

test("unresolved, unjudged and dismissed cases do not invent an outcome", () => {
  assert.deepEqual(caseShareMetadata({ ...c, status: "queued" }, [claims]), { title: "Caso Nº ABC · CheBot", description: "«https://example.org»" });
  assert.deepEqual(caseShareMetadata(c, [claims]), { title: "Caso Nº ABC · CheBot", description: "«La afirmación»" });
  assert.deepEqual(caseShareMetadata(c, [claims, { type: "dismissed", reason: "No claim" }]), { title: "Caso Nº ABC · CheBot", description: "«La afirmación»" });
});
