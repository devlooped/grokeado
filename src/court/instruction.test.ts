import assert from "node:assert/strict";
import { test } from "node:test";
import { project, type CourtEvent } from "../domain/court.ts";
import { composePrompt, planTurn, type TurnPlan } from "./turns.ts";
import { toAiTools } from "./toolset.ts";

const submission = { kind: "text" as const, text: "Una afirmación verificable y otra afirmación verificable." };
const claims: CourtEvent = { type: "claims_entered", claims: [
  { id: "A1", quote: "", text: "Primera afirmación verificable." },
  { id: "A2", quote: "", text: "Segunda afirmación verificable." },
] };
const evidence: CourtEvent[] = [
  { type: "evidence_filed", evidence: { id: "P1", by: "grok", claimId: "A1", title: "Informe oficial", url: "https://example.org/report#table1", excerpt: "Datos que apoyan la primera afirmación.", stance: "supports" } },
  { type: "evidence_filed", evidence: { id: "P2", by: "gemini", claimId: "A2", title: "Otra tabla del informe", url: "https://example.org/report#table2", excerpt: "Datos que contradicen la segunda afirmación.", stance: "opposes" } },
  { type: "evidence_filed", evidence: { id: "P3", by: "claude", claimId: "A1", title: "Fuente independiente", url: "https://example.org/other", excerpt: "Otra perspectiva sobre la primera afirmación.", stance: "context" } },
];

async function execute(plan: TurnPlan, name: string, input: unknown) {
  return toAiTools(plan.tools)[name].execute(plan.tools[name].schema.parse(input));
}

async function unifiedRecord(): Promise<CourtEvent[]> {
  const record = [claims, ...evidence];
  const plan = planTurn({ kind: "unification" }, record, submission);
  await execute(plan, "unify_evidence", { groups: [{ evidenceIds: ["P1", "P2"] }, { evidenceIds: ["P3"] }] });
  return [...record, ...plan.produced];
}

test("instruction requires explicit bilateral search reports for every claim, including missing evidence", async () => {
  const plan = planTurn({ kind: "instruction", counsel: "grok" }, [claims], submission);
  assert.deepEqual(Object.keys(plan.tools).sort(), ["file_evidence", "finish_instruction"]);
  assert.match(plan.instruction, /A FAVOR como EN CONTRA/);
  assert.match(plan.instruction, /No inventes pruebas/);
  const report = { claimId: "A1", supporting: "Busqué documentos a favor, sin resultados verificables.", opposing: "Busqué documentos en contra, sin resultados verificables." };
  await assert.rejects(execute(plan, "finish_instruction", { searches: [{ claimId: "A1", supporting: report.supporting }] }));
  assert.deepEqual(await execute(plan, "finish_instruction", { searches: [report] }), { error: "Documentá la búsqueda a favor y en contra exactamente una vez por cada afirmación." });
  assert.equal(plan.done(), false);
  await execute(plan, "finish_instruction", { searches: [report, { ...report, claimId: "A2" }] });
  assert.equal(plan.done(), true, "honest unsuccessful searches may complete instruction");
  const filed = evidence[0];
  assert(filed.type === "evidence_filed");
  assert.deepEqual(await execute(plan, "file_evidence", filed.evidence), { error: "Tu aporte de pruebas ya está cerrado." });
  assert.equal(plan.produced.length, 1);
});

test("moderator unification preserves all authors, excerpts, claims and stances while merging URL fragments", async () => {
  const record = await unifiedRecord();
  const sources = [...project(record).sources.values()];
  assert.equal(sources.length, 2);
  assert.equal(sources[0].url, "https://example.org/report");
  assert.deepEqual(sources[0].contributions, evidence.slice(0, 2).flatMap((e) => e.type === "evidence_filed" ? [e.evidence] : []));
  assert.deepEqual(sources.map((s) => s.id), ["S1", "S2"]);
  const prompt = composePrompt({ seat: "chatgpt", docket: { submission, today: "hoy" }, record, instruction: "Revisá las fuentes.", attempt: 0 });
  assert.match(prompt, /Aporte de Grok sobre A1 \(a favor\)/);
  assert.match(prompt, /Aporte de Gemini sobre A2 \(en contra\)/);
  assert.match(prompt, /PENDIENTE DE CRÍTICA/);
});

test("unification rejects omissions, invented IDs, duplicates, split duplicates and unrelated sources atomically", async () => {
  const plan = planTurn({ kind: "unification" }, [claims, ...evidence], submission);
  for (const groups of [
    [{ evidenceIds: ["P1", "P2"] }],
    [{ evidenceIds: ["P1", "P2", "P99"] }],
    [{ evidenceIds: ["P1", "P2", "P2"] }],
    [{ evidenceIds: ["P1"] }, { evidenceIds: ["P2"] }, { evidenceIds: ["P3"] }],
    [{ evidenceIds: ["P1", "P2", "P3"] }],
  ]) {
    const result = await execute(plan, "unify_evidence", { groups });
    assert.equal(typeof result, "object");
    assert.equal(plan.done(), false);
    assert.equal(plan.produced.length, 0, "failed groups cannot partially enter the record");
  }
  await execute(plan, "unify_evidence", { groups: [{ evidenceIds: ["P1", "P2"] }, { evidenceIds: ["P3"] }] });
  assert.equal(plan.done(), true);
  const retry = planTurn({ kind: "unification" }, [...evidence, ...plan.produced], submission);
  assert.equal(retry.done(), true);
  assert.deepEqual(await execute(retry, "unify_evidence", { groups: [] }), { error: "La evidencia ya está unificada." });
});

test("source criticism records exactly one reasoned vote per analyst and source, including their own contributions", async () => {
  const record = await unifiedRecord();
  const plan = planTurn({ kind: "source_review", counsel: "grok" }, record, submission);
  assert.deepEqual(Object.keys(plan.tools), ["review_sources"]);
  const first = { sourceId: "S1", veto: true, reason: "El documento no identifica autores ni metodología." };
  const second = { sourceId: "S2", veto: false, reason: "Documento firmado con datos contrastables." };
  for (const votes of [[first], [first, first], [first, { ...second, sourceId: "S99" }]]) {
    const result = await execute(plan, "review_sources", { votes });
    assert.equal(typeof result, "object");
    assert.equal(plan.produced.length, 0);
    assert.equal(plan.done(), false);
  }
  await execute(plan, "review_sources", { votes: [first, second] });
  assert.equal(plan.done(), true);
  assert.deepEqual(project([...record, ...plan.produced]).sources.get("S1")?.votes.grok, { veto: true, reason: first.reason });
  const retry = planTurn({ kind: "source_review", counsel: "grok" }, [...record, ...plan.produced], submission);
  assert.equal(retry.done(), true);
  assert.deepEqual(await execute(retry, "review_sources", { votes: [first, second] }), { error: "Ya registraste tu crítica de fuentes." });
  assert.equal(retry.produced.length, 0);
});

test("all statement stages allow others' admitted sources and reject raw, unknown, pending or excluded sources", async () => {
  const record = await unifiedRecord();
  const input = { text: "Mi evaluación utiliza las fuentes compartidas del expediente.", evidenceIds: ["S1"] };
  const pending = planTurn({ kind: "statement", counsel: "chatgpt", stage: "opening" }, record, submission);
  assert.match(JSON.stringify(await execute(pending, "make_statement", input)), /pendientes de crítica/);
  record.push({ type: "source_decided", sourceId: "S1", excluded: true }, { type: "source_decided", sourceId: "S2", excluded: false }, { type: "instruction_closed" });
  for (const spec of [
    { kind: "statement" as const, counsel: "chatgpt" as const, stage: "opening" as const },
    { kind: "statement" as const, counsel: "chatgpt" as const, stage: "rebuttal" as const },
    { kind: "closing" as const, counsel: "chatgpt" as const },
  ]) {
    const plan = planTurn(spec, record, submission);
    assert.equal(plan.tools.file_evidence, undefined);
    for (const id of ["P1", "P3", "S1", "S99"]) {
      assert.equal(typeof await execute(plan, "make_statement", { ...input, evidenceIds: [id] }), "object");
      assert.equal(plan.produced.length, 0);
    }
    await execute(plan, "make_statement", { ...input, evidenceIds: ["S2"] });
    assert.equal(plan.produced.length, 1);
  }
  const prompt = composePrompt({ seat: "judge", docket: { submission, today: "hoy" }, record, instruction: "Decidí.", attempt: 0 });
  assert.match(prompt, /\[S1\] ANULADA/);
  assert.match(prompt, /\[S2\] ADMITIDA/);
});

test("statement tools accept only promoted OKF page citations in addition to shared sources", async () => {
  const record = await unifiedRecord();
  record.push({ type: "source_decided", sourceId: "S1", excluded: false }, { type: "source_decided", sourceId: "S2", excluded: false }, { type: "instruction_closed" });
  const citation = "/evidence/grok/passage.md#p2";
  const plan = planTurn({ kind: "statement", counsel: "chatgpt", stage: "opening" }, record, submission, [citation]);
  const input = { text: "La extracción recoge un pasaje que permite contrastar la afirmación.", evidenceIds: [citation] };
  await execute(plan, "make_statement", input);
  assert.equal(plan.produced[0]?.type, "statement");
  if (plan.produced[0]?.type === "statement") assert.deepEqual(plan.produced[0].evidenceIds, [citation]);

  const untrusted = planTurn({ kind: "statement", counsel: "chatgpt", stage: "opening" }, record, submission, [citation]);
  const result = await execute(untrusted, "make_statement", { ...input, evidenceIds: ["/evidence/grok/invented.md#p2"] });
  assert.match(JSON.stringify(result), /No están en el expediente común/);
  assert.equal(untrusted.produced.length, 0);
});
