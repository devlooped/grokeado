import { test } from "node:test";
import assert from "node:assert/strict";
import { majority, modelDetail, modelMark, modelName, project, seatModels, type CourtEvent } from "./court.ts";

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

test("historical content consensus is reported without inventing votes; new records need a judgment", async () => {
  const { contentOutcome, caseShareMetadata } = await import("./case.ts");
  const summary: CourtEvent = { type: "case_summary", text: "A1, Verdadero; A2, Falso. Los cuatro analistas coincidieron en considerar engañoso el enunciado completo." };
  const view = project([summary]);
  assert.deepEqual(contentOutcome(view), { verdict: "enganoso", method: "reported" });
  assert.deepEqual(view.contentVotes, {});
  assert.equal(contentOutcome(project([{ ...summary, text: "El enunciado podría ser engañoso." }])), undefined);
  assert.equal(contentOutcome(project([summary, { type: "absence", by: "grok", stage: "content" }])), undefined);
  assert.equal(contentOutcome(project([summary, { type: "dismissed", reason: "Sin afirmaciones" }])), undefined);
  const decision: CourtEvent = { type: "content_judgment", verdict: "verdadero", method: "judge", reasoning: "La evidencia respalda el conjunto." };
  assert.equal(contentOutcome(project([summary, decision]))?.verdict, "verdadero");
  const c = { id: "ABC", createdAt: "2026-01-01", status: "resolved" as const, submission: { kind: "text" as const, text: "Contenido" } };
  assert.match(caseShareMetadata(c, [summary]).title, /⚠️/);
});

test("historical and misleading verdicts have distinct labels in records and sharing metadata", async () => {
  const { caseShareMetadata, describe } = await import("./case.ts");
  const c = { id: "abc", createdAt: "2026-10-31T00:00:00Z", status: "resolved" as const, submission: { kind: "text" as const, text: "Afirmación" } };
  const events: CourtEvent[] = [
    { type: "claims_entered", claims: [{ id: "A1", quote: "Afirmación", text: "Afirmación" }] },
    { type: "vote", by: "grok", claimId: "A1", verdict: "no_verificable", rationale: "Faltan pruebas." },
    { type: "judgment", claimId: "A1", verdict: "enganoso", method: "judge", reasoning: "Falta contexto." },
  ];
  assert.match(describe(events[1]), /Insostenible/);
  assert.match(describe(events[2]), /Engañoso/);
  const meta = caseShareMetadata(c, events);
  assert.equal(meta.title, "Caso Nº abc · CheBot · ⚠️");
  assert.equal(meta.description, "«Afirmación» ⚠️");
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

test("caseShareMetadata uses one mixed outcome icon without vote icons", async () => {
  const { caseShareMetadata } = await import("./case.ts");
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
  assert.equal(meta.title, "Caso Nº abc123 · CheBot · ⚖️");
  assert.equal(meta.description, "«El dulce de leche se inventó en la Argentina. / La birome es un invento argentino.» ⚖️");
});

test("a model takes the mark and name of its provider's family; its detail drops the provider and adds the effort", () => {
  assert.equal(modelMark("spacexai/grok-4.7"), "grok");
  assert.equal(modelMark("anthropic/claude-opus-5.5"), "claude");
  assert.equal(modelMark("mistral/large"), undefined);
  assert.equal(modelName("openai/gpt-6.1-sol"), "ChatGPT");
  assert.equal(modelName("mistral/large"), "mistral");
  assert.equal(modelDetail({ id: "openai/gpt-6.1-sol", effort: "high" }), "gpt-6.1-sol high");
  assert.equal(modelDetail({ id: "google/gemini-3.5-flash-lite", effort: null }), "gemini-3.5-flash-lite");
});

test("the case's snapshot decides who sat where, over the opening event", () => {
  const opened: CourtEvent = { type: "session_opened", judgeModel: "spacexai/grok-4.7", counselModels: { grok: "spacexai/grok-4.7", gemini: "google/gemini-4-argon", claude: "anthropic/claude-opus-5.5", chatgpt: "openai/gpt-6.1-sol" } };
  const seats = seatModels({ models: { judge: { id: "anthropic/claude-opus-5.5", effort: "high" }, translator: { id: "google/x", effort: null } } }, [opened]);
  assert.deepEqual(seats.judge, { id: "anthropic/claude-opus-5.5", effort: "high" });
  assert.deepEqual(seats.gemini, { id: "google/gemini-4-argon", effort: null });
  assert.deepEqual(seatModels({}), {});
});
