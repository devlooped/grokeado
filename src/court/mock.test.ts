import assert from "node:assert/strict";
import { test } from "node:test";
import { COUNSEL, project, type CourtEvent, type Submission, type UnifiedSource } from "../domain/court.ts";
import { createMockSeat, mockAiEnabled } from "./mock.ts";
import { runSeat } from "./seat.ts";
import { conductTurn, type TurnSpec } from "./turns.ts";

const submission: Submission = { kind: "text", text: "Texto arbitrario enviado para probar las respuestas simuladas." };
const claims: CourtEvent = { type: "claims_entered", claims: [{ id: "A1", quote: "", text: "Una afirmación sintética para probar el flujo." }] };
const sources: UnifiedSource[] = ["support", "opposition", "unreliable"].map((side, i) => ({
  id: "S" + (i + 1),
  title: "SIMULACIÓN LOCAL: documento " + side,
  url: "https://sources.example.test/A1/" + side,
  contributions: COUNSEL.map((by, j) => ({
    id: "P" + (i * 4 + j + 1), by, claimId: "A1", title: "SIMULACIÓN LOCAL: documento " + side,
    url: "https://sources.example.test/A1/" + side,
    excerpt: "SIMULACIÓN LOCAL: fragmento ficticio del documento.",
    stance: side === "support" ? "supports" as const : side === "opposition" ? "opposes" as const : "context" as const,
  })),
}));
const filed: CourtEvent[] = [claims, ...sources.flatMap((s) => s.contributions.map((evidence): CourtEvent => ({ type: "evidence_filed", evidence })))];
const unified: CourtEvent[] = [...filed, { type: "evidence_unified", sources }];
const admitted: CourtEvent[] = [...unified, ...sources.map((s): CourtEvent => ({ type: "source_decided", sourceId: s.id, excluded: s.id === "S3" })), { type: "instruction_closed" }];

function runMock(spec: TurnSpec, record: readonly CourtEvent[], input = submission) {
  return conductTurn({ submission: input, today: "hoy", simulated: true }, spec, record, 0, async ({ prompt, tools, done }) =>
    runSeat({ model: { id: "unused-live-provider" }, research: spec.kind === "instruction", prompt, tools, done, mock: { spec, record, submission: input } }));
}

test("mock mode is explicit, defaults to live, and rejects a misspelled mode", (t) => {
  const previous = process.env.COURT_AI_MODE;
  t.after(() => { if (previous === undefined) delete process.env.COURT_AI_MODE; else process.env.COURT_AI_MODE = previous; });
  delete process.env.COURT_AI_MODE;
  assert.equal(mockAiEnabled(), false);
  process.env.COURT_AI_MODE = "mock";
  assert.equal(mockAiEnabled(), true);
  process.env.COURT_AI_MODE = "invalid";
  assert.throws(mockAiEnabled, /debe ser live o mock/);
});

test("mock intake fetches submitted links locally and labels its claim as fictitious", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("No network allowed in mock mode"); });
  const outcome = await runMock({ kind: "intake" }, [], { kind: "link", url: "https://example.org/submitted" });
  assert.equal(outcome.done, true);
  const entered = outcome.events.find((e) => e.type === "claims_entered");
  assert(entered?.type === "claims_entered");
  assert.match(entered.claims[0].text, /SIMULACIÓN LOCAL/);
});

test("mock instruction exercises searches in both directions and court schema validation without network", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("No network allowed in mock mode"); });
  const spec = { kind: "instruction" as const, counsel: "grok" as const };
  const mock = createMockSeat({ spec, record: [claims], submission }, true);
  const outcome = await conductTurn({ submission, today: "hoy" }, spec, [claims], 0, async ({ prompt, tools, done }) => {
    // Inject the scripted provider, retaining simulated research implementations.
    await runSeat({ model: { id: "unused-live-provider" }, research: true, prompt, tools, done, mock: { spec, record: [claims], submission } }, mock.model);
  });
  assert.equal(outcome.done, true);
  const filed = outcome.events.flatMap((e) => e.type === "evidence_filed" ? [e.evidence] : []);
  assert.deepEqual(filed.map((e) => e.stance), ["supports", "opposes", "context"]);
  assert.ok(filed.every((e) => e.url.startsWith("https://sources.example.test/") && e.title.includes("SIMULACIÓN LOCAL")));
  assert.equal(outcome.events.at(-1)?.type, "instruction_completed");
  const generatedCalls = mock.model.doGenerateCalls.flatMap((c) => c.prompt.flatMap((m) => m.role === "assistant" ? m.content.filter((p) => p.type === "tool-call") : []));
  const searches = generatedCalls.filter((c) => c.type === "tool-call" && c.toolName === "web_search");
  assert.equal(new Set(searches.map((c) => c.toolCallId)).size, 2, "count each search once, excluding the history repeated in later prompts");
});

test("mock moderator unification produces shared sources with all original authors", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("No network allowed in mock mode"); });
  const outcome = await runMock({ kind: "unification" }, filed);
  assert.equal(outcome.done, true);
  const shared = [...project([...filed, ...outcome.events]).sources.values()];
  assert.equal(shared.length, 3);
  assert.ok(shared.every((s) => s.contributions.length === 4));
});

test("mock criticism scripts three vetoes for the unreliable fixture and preserves both opposing documents", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("No network allowed in mock mode"); });
  const outcomes = await Promise.all(COUNSEL.map((counsel) => runMock({ kind: "source_review", counsel }, unified)));
  assert.ok(outcomes.every((o) => o.done));
  const view = project([...unified, ...outcomes.flatMap((o) => o.events)]);
  assert.equal(COUNSEL.filter((c) => view.sources.get("S3")?.votes[c]?.veto).length, 3);
  assert.ok(["S1", "S2"].every((id) => COUNSEL.every((c) => view.sources.get(id)?.votes[c]?.veto === false)));
});

test("mock statements and final votes use admitted shared sources and no live model", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("No network allowed in mock mode"); });
  for (const spec of [
    { kind: "statement" as const, stage: "opening" as const, counsel: "grok" as const },
    { kind: "statement" as const, stage: "rebuttal" as const, counsel: "gemini" as const },
    { kind: "closing" as const, counsel: "claude" as const },
  ]) {
    const outcome = await runMock(spec, admitted);
    assert.equal(outcome.done, true);
    const statement = outcome.events.find((e) => e.type === "statement");
    assert(statement?.type === "statement");
    assert.deepEqual(statement.evidenceIds, ["S1", "S2"]);
    assert.match(statement.text, /SIMULACIÓN LOCAL/);
    if (spec.kind === "closing") assert.ok(outcome.events.some((e) => e.type === "vote" && e.verdict === "no_verificable"));
  }
});

test("isolated mock objection, reply, ruling and tiebreak fixtures all complete through the AI tool loop", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("No network allowed in mock mode"); });
  const record: CourtEvent[] = [...admitted,
    { type: "statement", id: "I1", by: "grok", stage: "opening", text: "SIMULACIÓN LOCAL: exposición de prueba.", evidenceIds: ["S1"] },
    { type: "objection", id: "O1", by: "gemini", against: "I1", grounds: "SIMULACIÓN LOCAL: objeción de prueba." },
  ];
  for (const spec of [
    { kind: "objection", counsel: "gemini", speaker: "grok", statementId: "I1" },
    { kind: "reply", speaker: "grok", objector: "gemini", objectionId: "O1" },
    { kind: "ruling", objectionId: "O1" },
    { kind: "tiebreak" },
  ] satisfies TurnSpec[]) {
    const outcome = await runMock(spec, record);
    assert.equal(outcome.done, true, spec.kind);
    assert.equal(outcome.events.length, 1);
  }
});
