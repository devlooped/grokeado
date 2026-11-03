import { test } from "node:test";
import assert from "node:assert/strict";
import { majority, project, type CourtEvent } from "./court.ts";

test("three matching votes out of four are a consensus", () => {
  assert.equal(majority(["verdadero", "verdadero", "verdadero", "falso"]), "verdadero");
  assert.equal(majority(["falso", "no_verificable", "falso", "falso"]), "falso");
  assert.equal(majority(["no_verificable", "no_verificable", "no_verificable"]), "no_verificable");
  assert.equal(majority(["enganoso", "enganoso", "enganoso", "verdadero"]), "enganoso");
});

test("a three-way split or a missing majority goes to the judge", () => {
  assert.equal(majority(["verdadero", "falso", "no_verificable"]), undefined);
  assert.equal(majority(["verdadero"]), undefined);
  assert.equal(majority([]), undefined);
  assert.equal(majority(["verdadero", "verdadero", "falso", "falso"]), undefined);
  assert.equal(majority(["verdadero", "falso", "no_verificable", "enganoso"]), undefined);
});

test("historical and misleading verdicts have distinct labels in records and sharing metadata", async () => {
  const { caseShareMetadata, describe } = await import("./acta.ts");
  const c = { id: "abc", createdAt: "2026-10-31T00:00:00Z", status: "resolved" as const, submission: { kind: "text" as const, text: "Afirmación" } };
  const events: CourtEvent[] = [
    { type: "claims_entered", claims: [{ id: "A1", quote: "Afirmación", text: "Afirmación" }] },
    { type: "vote", by: "grok", claimId: "A1", verdict: "no_verificable", rationale: "Faltan pruebas." },
    { type: "judgment", claimId: "A1", verdict: "enganoso", method: "judge", reasoning: "Falta contexto." },
  ];
  assert.match(describe(events[1]), /Insostenible/);
  assert.match(describe(events[2]), /Engañoso/);
  const meta = caseShareMetadata(c, events);
  assert.match(meta.title, /❓ · ⚠️ Engañoso/);
  assert.match(meta.description, /⚠️ Engañoso/);
});

test("projection attaches votes and judgments to claims and strikes sustained objections", () => {
  const events: CourtEvent[] = [
    { type: "claims_entered", claims: [{ id: "A1", quote: "q", text: "t" }] },
    { type: "statement", id: "I1", by: "gemini", stage: "opening", text: "x", evidenceIds: [] },
    { type: "objection", id: "O1", by: "claude", against: "I1", grounds: "g" },
    { type: "ruling", objectionId: "O1", sustained: true, reason: "r" },
    { type: "vote", by: "grok", claimId: "A1", verdict: "falso", rationale: "r" },
    { type: "judgment", claimId: "A1", verdict: "falso", method: "judge", reasoning: "r" },
    { type: "case_summary", text: "El debate se centró en la evidencia disponible." },
    { type: "session_closed" },
  ];
  const view = project(events);
  assert.deepEqual([...view.struck], ["I1"]);
  assert.equal(view.claims[0].votes.grok?.verdict, "falso");
  assert.equal(view.claims[0].judgment?.method, "judge");
  assert.equal(view.summary, "El debate se centró en la evidencia disponible.");
  assert.equal(view.closed, true);
});

test("caseShareMetadata formats quoted content and voted outcomes with thumbs", async () => {
  const { caseShareMetadata } = await import("./acta.ts");
  const c = {
    id: "abc123",
    createdAt: "2026-10-31T00:00:00Z",
    status: "resolved" as const,
    submission: { kind: "text" as const, text: "El dulce de leche se inventó en la Argentina y la birome es un invento argentino." },
  };
  const events: CourtEvent[] = [
    {
      type: "claims_entered",
      claims: [
        { id: "A1", quote: "El dulce de leche se inventó en la Argentina", text: "El dulce de leche se inventó en la Argentina." },
        { id: "A2", quote: "la birome es un invento argentino", text: "La birome es un invento argentino." },
      ],
    },
    { type: "vote", by: "grok", claimId: "A1", verdict: "falso", rationale: "r" },
    { type: "vote", by: "gemini", claimId: "A1", verdict: "falso", rationale: "r" },
    { type: "vote", by: "claude", claimId: "A1", verdict: "falso", rationale: "r" },
    { type: "vote", by: "chatgpt", claimId: "A1", verdict: "verdadero", rationale: "r" },
    { type: "vote", by: "grok", claimId: "A2", verdict: "verdadero", rationale: "r" },
    { type: "vote", by: "gemini", claimId: "A2", verdict: "verdadero", rationale: "r" },
    { type: "vote", by: "claude", claimId: "A2", verdict: "verdadero", rationale: "r" },
    { type: "vote", by: "chatgpt", claimId: "A2", verdict: "verdadero", rationale: "r" },
    { type: "judgment", claimId: "A1", verdict: "falso", method: "consensus", reasoning: "" },
    { type: "judgment", claimId: "A2", verdict: "verdadero", method: "consensus", reasoning: "" },
    { type: "session_closed" },
  ];
  const meta = caseShareMetadata(c, events);
  assert.equal(meta.title, "Caso Nº abc123 · CheBot · 👎👎👎👍 · 👎 Falso / 👍👍👍👍 · 👍 Verdadero");
  assert.equal(
    meta.description,
    "«El dulce de leche se inventó en la Argentina y la birome es un invento argentino.»\n👎👎👎👍 · 👎 Falso\n👍👍👍👍 · 👍 Verdadero"
  );
});
