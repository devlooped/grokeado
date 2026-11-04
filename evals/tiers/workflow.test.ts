import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { CHECKS, assessmentSchema, evidenceSchema, moderatorModel, parseModerator, routingSchema, validateRouting, type Evidence, type Routing } from "./core.ts";
import { EXPERIMENT_VERSION, validateResume } from "./experiment.ts";
import { moderatorPrompt, researchPrompt } from "./prompts.ts";
import { renderReport, renderSufficiencyReport, summarizeModerators, type CaseReport } from "./report.ts";
import { evaluateSufficiency, SUFFICIENCY_CASES } from "./sufficiency-cases.ts";
import { adjudicateChallenges, BudgetExceededError, challengedGaps, resolveAssessment, runResearchLoop, type Dossier, type ResearchBatch, type ResearchOutcome } from "./workflow.ts";

const complete = SUFFICIENCY_CASES.find((c) => c.id === "complete-fact")!.dossier;
const missing = SUFFICIENCY_CASES.find((c) => c.id === "missing-primary")!.dossier;
function evidence(status: Evidence["status"] = "sufficient", check: keyof Evidence["checks"] = "access"): Evidence {
  const checks = Object.fromEntries(CHECKS.map((key) => [key, { status: "satisfied", reason: "El documento contiene el dato y su definición.", sourceIds: ["S1"] }])) as Evidence["checks"];
  if (status !== "sufficient") checks[check] = { status: "missing", reason: "Falta la tabla primaria necesaria para este aspecto.", sourceIds: [] };
  return { status, covered: ["Edición definitiva del censo"], checks, gaps: status === "sufficient" ? [] : [
    { aspect: "Población residente", whyItMatters: "La cifra decide si se supera el umbral.", researchAction: "Buscar la tabla definitiva en el sitio estadístico o su copia oficial." },
  ] };
}
function route(status: Evidence["status"] = "sufficient", tier: Routing["tier"] = "fact"): Routing {
  return { tier, action: status === "sufficient" ? "verify" : "research_more", reason: "Se requiere una cifra explícita en una tabla primaria, sin inferencias complejas.",
    sourceIds: ["S1"], evidence: evidence(status), escalationReason: null };
}
const batch = (dossier: Dossier): ResearchBatch => ({ contributions: dossier.contributions, researchChecks: dossier.researchChecks });

test("contracts reject contradictory sufficiency/action states and Spanish identifiers; Gateway schemas remain serializable", () => {
  assert(!evidenceSchema.safeParse({ ...evidence("insufficient"), status: "sufficient" }).success);
  assert(!evidenceSchema.safeParse({ ...evidence("uncertain"), gaps: [] }).success);
  assert(!evidenceSchema.safeParse({ ...evidence(), status: "insufficient", gaps: evidence("insufficient").gaps }).success);
  assert(!routingSchema.safeParse({ ...route("insufficient"), action: "verify" }).success);
  assert(!routingSchema.safeParse({ ...route(), action: "research_more" }).success);
  assert(!routingSchema.safeParse({ ...route(), action: "escalate" }).success);
  assert(!routingSchema.safeParse({ ...route(), tier: "dato" }).success);
  assert(!evidenceSchema.safeParse({ ...evidence(), status: "insuficiente" }).success);
  assert(z.toJSONSchema(routingSchema).properties);
  assert(z.toJSONSchema(assessmentSchema).properties);
});

test("mechanical checks reject unknown citations within nested checks and unsupported sufficient dossiers", () => {
  const invalid = route();
  invalid.evidence.checks.fit.sourceIds = ["S99"];
  assert.throws(() => validateRouting(invalid, complete.sources), /unknown source/);
  const empty = route();
  empty.sourceIds = [];
  for (const key of CHECKS) empty.evidence.checks[key].sourceIds = [];
  assert.throws(() => validateRouting(empty, []), /retrieved sources/);
});

test("a missing PDF triggers targeted research and re-moderation at medium, without elevating fact complexity", async () => {
  const requests: unknown[] = [];
  const efforts: string[] = [];
  const outcome = await runResearchLoop({ claim: complete.claim, asOf: complete.asOf, maxResearchRounds: 2,
    research: async (gaps, round, dossier) => { requests.push({ gaps, round, sources: dossier.sources.length }); return batch(round === 0 ? missing : complete); },
    moderate: async (dossier, effort, round) => {
      efforts.push(effort);
      assert.equal(dossier.sources[0].id, "S1");
      if (round === 1) assert.equal(dossier.sources[1].contributions[0].retrieval, "full_document");
      const result = route(round === 0 ? "insufficient" : "sufficient");
      if (round === 1) result.sourceIds = ["S2"];
      return result;
    } });
  assert.equal(outcome.stopReason, "sufficient");
  assert.equal(outcome.researchRounds, 1);
  assert.deepEqual(efforts, ["medium", "medium"]);
  assert.equal(outcome.route?.tier, "fact");
  assert.deepEqual(requests, [{ gaps: [], round: 0, sources: 0 }, { gaps: evidence("insufficient").gaps, round: 1, sources: 1 }]);
  assert.equal(outcome.dossier.sources.length, 2);
  assert.equal(outcome.dossier.researchChecks[0].retrievalIssues.length, 1, "failed access remains auditable after repair");
});

for (const fixtureId of ["period-mismatch", "unit-mismatch", "unresolved-conflict"]) {
  test(`${fixtureId}: unresolved gaps exhaust research with an abstention, retaining the original complexity`, async () => {
    const fixture = SUFFICIENCY_CASES.find((c) => c.id === fixtureId)!;
    let calls = 0;
    const pending = route("insufficient", fixture.expectedTier);
    pending.evidence = evidence("insufficient", fixture.missingChecks[0]);
    const outcome = await runResearchLoop({ claim: fixture.dossier.claim, asOf: complete.asOf, maxResearchRounds: 1,
      research: async () => { calls++; return batch(fixture.dossier); }, moderate: async () => pending });
    assert.equal(calls, 2, "one initial batch and one follow-up");
    assert.equal(outcome.stopReason, "iteration_limit");
    assert.equal(outcome.route?.tier, fixture.expectedTier);
    assert.deepEqual(outcome.route?.evidence.gaps, pending.evidence.gaps);
    assert.equal(resolveAssessment(assessment(), outcome).effectiveVerdict, "unverifiable");
  });
}

test("only explicit substantive judgment escalation enables high effort, with a bounded second decision", async () => {
  const efforts: string[] = [];
  const escalate: Routing = { ...route("uncertain", "assessment"), action: "escalate", escalationReason: "substantive_judgment" };
  const outcome = await runResearchLoop({ claim: complete.claim, asOf: complete.asOf, maxResearchRounds: 2,
    research: async () => batch(complete), moderate: async (_, effort) => { efforts.push(effort); return escalate; } });
  assert.deepEqual(efforts, ["medium", "high"]);
  assert.equal(outcome.stopReason, "unresolved_judgment");
  assert.equal(outcome.researchRounds, 0);
});

test("high effort can request missing documents rather than bypass sufficiency", async () => {
  const efforts: string[] = [];
  const outcome = await runResearchLoop({ claim: complete.claim, asOf: complete.asOf, maxResearchRounds: 1,
    research: async () => batch(complete), moderate: async (_, effort, round) => {
      efforts.push(effort);
      if (round === 1) return route();
      return effort === "medium" ? { ...route("uncertain"), action: "escalate", escalationReason: "substantive_judgment" } : route("insufficient");
    } });
  assert.deepEqual(efforts, ["medium", "high", "medium"]);
  assert.equal(outcome.stopReason, "sufficient");
});

test("spend exhaustion retains partial research and pending gaps without another moderation call", async () => {
  let moderationCalls = 0;
  const outcome = await runResearchLoop({ claim: complete.claim, asOf: complete.asOf, maxResearchRounds: 2,
    research: async (_, round) => ({ ...batch(missing), budgetExhausted: round === 1 }),
    moderate: async () => { moderationCalls++; return route("insufficient"); } });
  assert.equal(moderationCalls, 1);
  assert.equal(outcome.stopReason, "budget_exhausted");
  assert.equal(outcome.dossier.contributions.length, 2);
  assert(outcome.route?.evidence.gaps.length);
});

test("budget exhaustion before moderation produces no route, while unrelated errors propagate", async () => {
  const options = { claim: complete.claim, asOf: complete.asOf, maxResearchRounds: 0,
    research: async () => batch(complete), moderate: async (): Promise<Routing> => { throw new BudgetExceededError(); } };
  const outcome = await runResearchLoop(options);
  assert.equal(outcome.stopReason, "budget_exhausted");
  assert.equal(outcome.route, null);
  await assert.rejects(runResearchLoop({ ...options, moderate: async () => { throw new Error("Provider failed"); } }), /Provider failed/);
});

function assessment() {
  return assessmentSchema.parse({ verdict: "true", evidence: evidence(), rationale: "La tabla definitiva registra una población que supera tres millones de habitantes.",
    sourceIds: ["S1"], calculations: [], criteria: [], limitations: [] });
}
function acceptedOutcome(): ResearchOutcome {
  return { dossier: complete, route: route(), history: [], researchRounds: 0, stopReason: "sufficient" };
}

test("an evaluator can challenge accepted sufficiency; unsafe raw verdicts remain auditable", () => {
  const result = assessment();
  assert.equal(resolveAssessment(result, acceptedOutcome()).effectiveVerdict, "true");
  result.evidence = evidence("insufficient");
  const resolved = resolveAssessment(result, acceptedOutcome());
  assert.equal(resolved.sufficiencyChallenged, true);
  assert.equal(resolved.effectiveVerdict, "unverifiable");
  assert.equal(result.verdict, "true");
  const invalid = assessment();
  invalid.evidence.checks.support.sourceIds = ["S99"];
  assert.equal(resolveAssessment(invalid, acceptedOutcome()).effectiveVerdict, "unverifiable");
});

test("a moderator can dismiss a challenged gap without research; material gaps trigger one shared research round", async () => {
  const accepted = acceptedOutcome();
  const gaps = challengedGaps([{ by: "grok", result: { ...assessment(), evidence: evidence("insufficient") } }, { by: "gemini", result: assessment() }], accepted);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].by, "grok");
  const reason = "El extracto oficial ya trae el dato explícito y su período.";
  let researched = 0;
  const base = { outcome: accepted, gaps, maxResearchRounds: 1,
    research: async () => { researched++; return batch(complete); }, moderate: async () => route() };
  const dismissed = await adjudicateChallenges({ ...base, rule: async () => [{ gap: 0, material: false, reason }] });
  assert.equal(researched, 0);
  assert.equal(dismissed.outcome, accepted);
  const material = await adjudicateChallenges({ ...base, rule: async () => [{ gap: 0, material: true, reason }] });
  assert.equal(researched, 1);
  assert.equal(material.adjudication.researched, true);
  assert.equal(material.outcome.researchRounds, 1);
  assert.equal(material.outcome.stopReason, "sufficient");
  const unresolved = await adjudicateChallenges({ ...base, rule: async () => [{ gap: 0, material: true, reason }], moderate: async () => route("insufficient") });
  assert.equal(unresolved.outcome.stopReason, "iteration_limit");
  assert.equal(resolveAssessment(assessment(), unresolved.outcome).effectiveVerdict, "unverifiable");
  const exhausted = await adjudicateChallenges({ ...base, maxResearchRounds: 0, rule: async () => [{ gap: 0, material: true, reason }] });
  assert.equal(exhausted.adjudication.researched, false);
  await assert.rejects(adjudicateChallenges({ ...base, rule: async () => [] }), /exactly once/);
});

test("challenges are only collected against an accepted sufficiency", () => {
  const challenger = { by: "claude" as const, result: { ...assessment(), evidence: evidence("insufficient") } };
  assert.equal(challengedGaps([challenger], { ...acceptedOutcome(), stopReason: "iteration_limit" }).length, 0);
  assert.equal(challengedGaps([challenger], acceptedOutcome()).length, 1);
});

test("an empty dossier can be researched but cannot be accepted as sufficient", async () => {
  const insufficient = route("insufficient", "assessment");
  insufficient.sourceIds = [];
  for (const key of CHECKS) insufficient.evidence.checks[key].sourceIds = [];
  const outcome = await runResearchLoop({ claim: "Afirmación compleja sin fuentes", asOf: complete.asOf, maxResearchRounds: 0,
    research: async () => ({ contributions: [], researchChecks: [] }), moderate: async () => insufficient });
  assert.equal(outcome.stopReason, "iteration_limit");
  assert.equal(outcome.route?.tier, "assessment");
});

test("Spanish reports translate identifiers and retain reasons, gaps and original versus effective verdicts", () => {
  const result = assessment();
  const report: CaseReport = { claim: complete.claim, expectedTier: "fact", expectedVerdict: "true", sources: 1, researchChecks: [],
    routing: [{ round: 0, effort: "medium", route: route("insufficient"), sourceCount: 1, tierCorrect: true }], stopReason: "iteration_limit",
    researchRounds: 0, finalRoute: route("insufficient"), assessments: [{ candidate: "C1", by: "grok", tier: "fact", result,
      ...resolveAssessment(result, { ...acceptedOutcome(), stopReason: "iteration_limit" }), verdictCorrect: true }], grades: [], evaluationBudgetExhausted: false };
  const markdown = renderReport({ test: report }, { asOf: complete.asOf, started: complete.asOf, deltaUsd: 0, failures: [] });
  assert.match(markdown, /Insuficiente/);
  assert.match(markdown, /Investigar más/);
  assert.match(markdown, /\*\*No verificable\*\*/);
  assert.match(markdown, /respuesta original: Verdadero/);
  assert.match(markdown, /Buscar la tabla definitiva/);
  assert.doesNotMatch(markdown, /research_more|iteration_limit|\binsufficient\b|\bfact\b/);
});

test("subject prompts expose dossier defects but never sufficiency reference labels; historical runs cannot resume", () => {
  for (const fixture of SUFFICIENCY_CASES) {
    const prompt = moderatorPrompt(fixture.dossier);
    assert(!prompt.includes("expectedStatuses"));
    assert(!prompt.includes("expectedTier"));
    assert(!prompt.includes("missingChecks"));
    assert(prompt.includes(fixture.dossier.claim));
  }
  assert.match(researchPrompt(missing, evidence("insufficient").gaps), /Población residente/);
  assert.throws(() => validateResume({ version: 1 }, 2, 8), /histórico/);
  assert.throws(() => validateResume({ version: EXPERIMENT_VERSION, maxResearchRounds: 1, maxUsd: 8 }, 2, 8), /límites originales/);
  assert.doesNotThrow(() => validateResume({ version: EXPERIMENT_VERSION, maxResearchRounds: 2, maxUsd: 8 }, 2, 8));
  assert.throws(() => validateResume({ version: EXPERIMENT_VERSION, maxResearchRounds: 2, maxUsd: 8, suite: "sufficiency" }, 2, 8), /suite original/);
});

test("controlled eval scores actual moderator decisions against hidden sufficiency and complexity references", async () => {
  for (const fixture of SUFFICIENCY_CASES) {
    const result = route(fixture.expectedStatuses[0], fixture.expectedTier);
    if (!fixture.dossier.sources.length) {
      result.sourceIds = [];
      for (const key of CHECKS) result.evidence.checks[key].sourceIds = [];
    }
    if (fixture.missingChecks.length) {
      for (const key of fixture.missingChecks) result.evidence.checks[key].status = "missing";
    }
    const report = await evaluateSufficiency(fixture, async (received, effort) => {
      assert.strictEqual(received, fixture.dossier);
      assert.equal(effort, "medium");
      return result;
    });
    assert.equal(report.passed, true, fixture.id);
  }
  const fixture = SUFFICIENCY_CASES.find((c) => c.id === "period-mismatch")!;
  const mistaken = await evaluateSufficiency(fixture, async () => route("sufficient", "comparison"));
  assert.equal(mistaken.passed, false);
  assert.equal(mistaken.statusCorrect, false);
  assert.equal(mistaken.gapsDetected, false);
  const inflated = await evaluateSufficiency(SUFFICIENCY_CASES[0], async () => route("sufficient", "assessment"));
  assert.equal(inflated.tierCorrect, false);
  const efforts: string[] = [];
  const escalated = await evaluateSufficiency(SUFFICIENCY_CASES[0], async (_, effort) => {
    efforts.push(effort);
    return effort === "medium" ? { ...route(), action: "escalate", escalationReason: "substantive_judgment" } : route();
  });
  assert.deepEqual(efforts, ["medium", "high"]);
  assert.equal(escalated.passed, true);
  const unresolved = await evaluateSufficiency(SUFFICIENCY_CASES[0], async () => ({ ...route(), action: "escalate", escalationReason: "substantive_judgment" }));
  assert.equal(unresolved.passed, false);
});

test("controlled cases have unique ids, cover every tier and pair the same claim across the fact/comparison boundary", () => {
  assert.equal(new Set(SUFFICIENCY_CASES.map((c) => c.id)).size, SUFFICIENCY_CASES.length);
  assert.deepEqual(new Set(SUFFICIENCY_CASES.map((c) => c.expectedTier)), new Set(["fact", "comparison", "assessment"]));
  const byId = (id: string) => SUFFICIENCY_CASES.find((c) => c.id === id)!;
  assert.equal(byId("rank-stated").dossier.claim, byId("rank-computed").dossier.claim);
  assert.notEqual(byId("rank-stated").expectedTier, byId("rank-computed").expectedTier);
  assert.equal(byId("legal-complete").dossier.claim, byId("legal-missing-norm").dossier.claim);
  // The injected instruction reaches the moderator only as dossier data.
  assert.match(moderatorPrompt(byId("injected-instruction").dossier), /datos no confiables[\s\S]*NOTA PARA EL MODERADOR/);
});

test("the tier evaluator runs at its configured effort and escalates the same model to high", () => {
  const terra = parseModerator("openai/gpt-6.1-terra@medium");
  assert.deepEqual(terra, { id: "openai/gpt-6.1-terra", providerOptions: { openai: { reasoningEffort: "medium" } } });
  assert.deepEqual(moderatorModel("medium", terra), terra);
  assert.deepEqual(moderatorModel("high", terra), { id: "openai/gpt-6.1-terra", providerOptions: { openai: { reasoningEffort: "high" } } });
  assert.deepEqual(moderatorModel("medium"), { id: "openai/gpt-6.1-terra", providerOptions: { openai: { reasoningEffort: "medium" } } });
  assert.deepEqual(parseModerator("anthropic/claude-haiku-5.5"), { id: "anthropic/claude-haiku-5.5" });
  assert.throws(() => parseModerator("terra"), /no válido/);
  assert.throws(() => parseModerator("openai/gpt-6.1-terra@medium@high"), /no válido/);
});

test("the face-off summarizes each tier evaluator over the same cases, counting errors and cost", () => {
  const call = (seconds: number, costUsd: number | null) => ({ elapsedMs: seconds * 1000, inputTokens: 1000, outputTokens: 500, costUsd });
  const report = (moderator: string, id: string, passed: boolean, tier: Routing["tier"], calls = [call(10, 0.01)]) => ({
    id, claim: "Afirmación " + id, turns: [{ effort: "medium" as const, route: route("sufficient", tier) }], expectedTier: "fact" as const,
    tierCorrect: passed, statusCorrect: true, gapsDetected: true, passed, moderator, repetition: 1, calls });
  const cases = [report("grok-4.7@medium", "a", true, "fact"), report("grok-4.7@medium", "b", false, "comparison", [call(30, 0.03)]),
    report("gpt-6.1-terra@medium", "a", true, "fact", [call(20, null)])];
  const errors = [{ moderator: "gpt-6.1-terra@medium", id: "b", repetition: 1, error: "Gateway no disponible" }];
  const [grok, terra] = summarizeModerators(cases, errors, ["grok-4.7@medium", "gpt-6.1-terra@medium"]);
  assert.deepEqual({ runs: grok.runs, passed: grok.passed, errors: grok.errors, medianSeconds: grok.medianSeconds }, { runs: 2, passed: 1, errors: 0, medianSeconds: 20 });
  assert.ok(Math.abs(grok.costUsd! - 0.04) < 1e-9);
  assert.deepEqual({ runs: terra.runs, errors: terra.errors, costUsd: terra.costUsd }, { runs: 1, errors: 1, costUsd: null });
  const markdown = renderSufficiencyReport(Object.fromEntries(cases.map((c, i) => [String(i), c])), [], { moderators: ["grok-4.7@medium", "gpt-6.1-terra@medium"], errors });
  assert.match(markdown, /\| grok-4\.7@medium \| 1\/2 \(50%\)/);
  assert.match(markdown, /\| b \| Dato \| 0\/1 correctos · Comparación \| 0\/1 correctos · sin respuesta · 1 error \|/);
  assert.doesNotMatch(markdown, /\bcomparison\b|\bsufficient\b/);
});

test("a run resumes only with the same tier evaluators and repetitions", () => {
  const setup = { moderators: ["grok-4.7@medium", "gpt-6.1-terra@medium"], repeat: 3 };
  const existing = { version: EXPERIMENT_VERSION, maxResearchRounds: 2, maxUsd: 8, suite: "sufficiency", setup };
  assert.doesNotThrow(() => validateResume(existing, 2, 8, "sufficiency", setup));
  assert.throws(() => validateResume(existing, 2, 8, "sufficiency", { ...setup, repeat: 1 }), /evaluadores de nivel/);
  assert.throws(() => validateResume(existing, 2, 8, "sufficiency", { moderators: ["grok-4.7@medium"], repeat: 3 }), /evaluadores de nivel/);
});
