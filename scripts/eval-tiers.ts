import nextEnv from "@next/env";
import { gateway } from "ai";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { AS_OF, CASES } from "../evals/tiers/cases.ts";
import { assessmentSchema, EVALUATORS, gapRulingSchema, gradingSchema, groundResearch, modelFor, researchSchema, routingSchema, type Evidence, type Observation, type Tier } from "../evals/tiers/core.ts";
import type { CourtModel } from "../src/court/models.ts";
import type { Counsel } from "../src/domain/court.ts";
import { generateSubmission } from "../evals/tiers/submission.ts";
import { adjudicateChallenges, BudgetExceededError, challengedGaps, dossierForPrompt, resolveAssessment, runResearchLoop, type Adjudication, type ChallengedGap, type Dossier, type Effort, type ResearchBatch, type RetrievalIssue, type RoutingTurn } from "../evals/tiers/workflow.ts";
import { assessmentPrompt, dataBoundary, gapRulingPrompt, moderatorPrompt, researchPrompt } from "../evals/tiers/prompts.ts";
import { renderReport, renderSufficiencyReport, type AssessmentReport, type CaseReport } from "../evals/tiers/report.ts";
import { EXPERIMENT_VERSION, validateResume } from "../evals/tiers/experiment.ts";
import { evaluateSufficiency, SUFFICIENCY_CASES, type SufficiencyReport } from "../evals/tiers/sufficiency-cases.ts";

nextEnv.loadEnvConfig(process.cwd(), true);

const { values } = parseArgs({ options: {
  case: { type: "string" }, out: { type: "string" }, resume: { type: "boolean", default: false },
  "retry-failed": { type: "boolean", default: false }, "max-usd": { type: "string", default: "8" },
  "max-research-rounds": { type: "string", default: "2" },
  suite: { type: "string", default: "claims" },
} });
const suite = values.suite;
if (suite !== "claims" && suite !== "sufficiency") throw new Error("Suite desconocida. Elegí claims o sufficiency.");
const cases = values.case ? CASES.filter((c) => c.id === values.case) : [...CASES];
const sufficiencyCases = values.case ? SUFFICIENCY_CASES.filter((c) => c.id === values.case) : SUFFICIENCY_CASES;
if (!(suite === "claims" ? cases : sufficiencyCases).length) throw new Error("Caso desconocido. Elegí: " + (suite === "claims" ? CASES : SUFFICIENCY_CASES).map((c) => c.id).join(", "));
if (values.resume && !values.out) throw new Error("--resume requiere --out <directorio existente>.");
const maxUsd = Number(values["max-usd"]);
if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error("--max-usd debe ser un número positivo.");
const maxResearchRounds = Number(values["max-research-rounds"]);
if (!Number.isInteger(maxResearchRounds) || maxResearchRounds < 0 || maxResearchRounds > 5) throw new Error("--max-research-rounds debe ser un entero entre 0 y 5.");
const outputDir = resolve(values.out ?? "test-results/tier-evals/" + new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(outputDir, { recursive: true });
const manifestPath = resolve(outputDir, "run.json");
const existing = await readJson(manifestPath);
if (existing && !values.resume) throw new Error("El directorio ya contiene una corrida. Usá --resume para evitar llamadas pagadas duplicadas.");
if (!existing && values.resume) throw new Error("No se encontró run.json para reanudar.");
if (existing) validateResume(existing, maxResearchRounds, maxUsd, suite);
if (process.env.COURT_AI_MODE === "mock") throw new Error("Este eval requiere AI Gateway real; quitá COURT_AI_MODE=mock.");
if (!process.env.AI_GATEWAY_API_KEY && !process.env.VERCEL_OIDC_TOKEN) throw new Error("Falta la credencial de AI Gateway; ver README.md.");
if (existing) await writeJson(resolve(outputDir, "run-before-resume-" + Date.now() + ".json"), existing);
const started = existing?.started ?? new Date().toISOString();
const before = await gateway.getCredits();
const initialUsed = Number(existing?.initialUsed ?? before.totalUsed);
const manifest = { version: EXPERIMENT_VERSION, suite, started, asOf: AS_OF, initialUsed, maxUsd, maxResearchRounds, purpose: "evidence sufficiency pilot, not a statistically powered benchmark" };
await writeJson(manifestPath, manifest);
console.log("Artefactos: " + outputDir);

// Fail before spending on inference if a configured model is absent from Gateway.
const catalog = await gateway.getAvailableModels();
const modelIds = suite === "sufficiency" ? [modelFor("grok", "assessment").id]
  : [...new Set(EVALUATORS.flatMap((by) => (["fact", "comparison", "assessment"] as const).map((t) => modelFor(by, t).id)))];
for (const id of modelIds) if (!catalog.models.some((m) => m.id === id)) throw new Error("Modelo no disponible en Gateway: " + id);
await writeJson(resolve(outputDir, "models.json"), catalog.models.filter((m) => modelIds.includes(m.id)));

type CallRecord = {
  key: string; model: CourtModel; prompt: string; status: "running" | "ok" | "error";
  output?: unknown; error?: string; elapsedMs: number; observations: Observation[];
  usage?: unknown; warnings?: unknown; steps: unknown[]; retrievalIssues: RetrievalIssue[];
};
const caseReports: Record<string, CaseReport> = existing?.caseReports ?? {};
const sufficiencyReports: Record<string, SufficiencyReport> = existing?.sufficiencyReports ?? {};
const failures: string[] = [];
const completedCalls = new Map<string, CallRecord>();

async function readJson(path: string): Promise<any> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function writeJson(path: string, value: unknown) { await writeFile(path, JSON.stringify(value, null, 2) + "\n"); }
async function checkBudget() {
  const used = Number((await gateway.getCredits()).totalUsed) - initialUsed;
  if (used >= maxUsd) throw new BudgetExceededError("Se alcanzó el límite de gasto Gateway: USD " + used.toFixed(4));
}
function safeError(error: unknown) {
  let message = error instanceof Error ? error.message : String(error);
  for (const name of ["AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN", "DATABASE_URL", "POSTGRES_URL"]) {
    const secret = process.env[name];
    if (secret) message = message.replaceAll(secret, "[REDACTED]");
  }
  return message.slice(0, 2500);
}

async function call<T>(key: string, model: CourtModel, prompt: string, schema: z.ZodType<T>, research = false) {
  const fingerprint = createHash("sha256").update(JSON.stringify({ model, prompt, schema: z.toJSONSchema(schema), research, version: EXPERIMENT_VERSION })).digest("hex").slice(0, 16);
  const path = resolve(outputDir, key + "-" + fingerprint + ".json");
  const cached = await readJson(path) as CallRecord | undefined;
  if (cached?.status === "ok") { completedCalls.set(key, cached); console.log("REUTILIZADO " + key); return { output: schema.parse(cached.output), record: cached }; }
  if (cached && !values["retry-failed"]) throw new Error(key + " tiene un intento fallido o interrumpido; revisá la traza y usá --retry-failed explícitamente.");
  if (cached) await writeJson(path.replace(/\.json$/, ".previous-" + Date.now() + ".json"), cached);
  await checkBudget();
  const time = performance.now();
  const record: CallRecord = { key, model, prompt, status: "running", elapsedMs: 0, observations: [], steps: [], retrievalIssues: [] };
  await writeJson(path, record);
  console.log("INICIO " + key + " / " + model.id);
  try {
    const { output, result } = await generateSubmission({
      model, prompt, schema, research,
      onStepFinish: async (step) => {
        // Persist retrieval output, never request headers, secrets or private reasoning.
        record.steps.push({ toolCalls: step.toolCalls, toolResults: step.toolResults, text: step.text,
          usage: step.usage, providerMetadata: step.providerMetadata, finishReason: step.finishReason });
        for (const result of step.toolResults) {
          const value = result.output as any;
          if (result.toolName === "web_search" && Array.isArray(value?.results)) {
            for (const item of value.results) {
              if (typeof item.url === "string" && /^https?:\/\//.test(item.url)) record.observations.push({ url: item.url, text: (item.excerpts ?? []).join("\n"), tool: "web_search" });
            }
          }
          if (result.toolName === "web_fetch" && value?.statusCode >= 200 && value?.statusCode < 300 && typeof value.content === "string") {
            const input = result.input as { url?: string };
            if (input.url) record.observations.push({ url: input.url, text: value.content, tool: "web_fetch" });
          }
          if (result.toolName === "web_fetch" && !(value?.statusCode >= 200 && value?.statusCode < 300 && typeof value.content === "string")) {
            record.retrievalIssues.push({ url: (result.input as { url?: string }).url ?? "", tool: result.toolName, reason: "No se obtuvo contenido legible; estado HTTP: " + (value?.statusCode ?? "desconocido") });
          }
        }
        for (const error of step.content.filter((part) => part.type === "tool-error")) {
          record.retrievalIssues.push({ url: typeof error.input === "object" && error.input !== null && "url" in error.input ? String(error.input.url) : "",
            tool: error.toolName, reason: safeError(error.error) });
        }
        record.elapsedMs = performance.now() - time;
        await writeJson(path, record);
      },
    });
    record.status = "ok"; record.output = output; record.usage = result.totalUsage; record.warnings = result.warnings;
    return { output, record };
  } catch (error) {
    record.status = "error"; record.error = safeError(error); throw new Error(key + ": " + record.error);
  } finally {
    record.elapsedMs = performance.now() - time;
    completedCalls.set(key, record);
    await writeJson(path, record);
    console.log((record.status === "ok" ? "COMPLETADO" : "ERROR") + " " + key + " / " + Math.round(record.elapsedMs) + "ms");
  }
}

if (suite === "sufficiency") for (const entry of sufficiencyCases) {
  try {
    sufficiencyReports[entry.id] = await evaluateSufficiency(entry, async (dossier, effort) =>
      (await call(`${entry.id}-moderator-${effort}`, modelFor("grok", "assessment", effort),
        "Este es un expediente ficticio controlado. Evaluá solo los documentos provistos; no uses recuerdos sobre el mundo real.\n" + moderatorPrompt(dossier), routingSchema)).output);
    await writeJson(resolve(outputDir, entry.id + "-report.json"), sufficiencyReports[entry.id]);
  } catch (error) { failures.push(entry.id + ": " + safeError(error)); }
  await writeJson(manifestPath, { ...manifest, sufficiencyReports, failures });
}

if (suite === "claims") for (const entry of cases) {
  try {
    // Reference labels, URLs and rubrics never enter subject prompts.
    // Sequential paid calls let the account guard run before every request.
    const research = async (gaps: Evidence["gaps"], round: number, dossier: Dossier) => {
      const batch: ResearchBatch = { contributions: [], researchChecks: [] };
      for (const by of EVALUATORS) {
        const key = `${entry.id}-research-${round}-${by}`;
        try {
          const result = await call(key, modelFor(by, "fact"), researchPrompt(dossier, gaps), researchSchema, true);
          const grounded = groundResearch(by, result.output, result.record.observations);
          batch.contributions.push(...grounded);
          batch.researchChecks.push({ by, round, passed: grounded.length > 0 && grounded.every((e) => e.grounded), filed: grounded.length,
            grounded: grounded.filter((e) => e.grounded).length, observedPages: result.record.observations.length,
            gaps: result.output.gaps, fetches: result.record.observations.filter((o) => o.tool === "web_fetch").length,
            retrievalIssues: result.record.retrievalIssues });
        } catch (error) {
          if (error instanceof BudgetExceededError) { batch.budgetExhausted = true; break; }
          failures.push(entry.id + ": " + safeError(error));
          const record = completedCalls.get(key);
          batch.researchChecks.push({ by, round, passed: false, filed: 0, grounded: 0,
            observedPages: record?.observations.length ?? 0, fetches: record?.observations.filter((o) => o.tool === "web_fetch").length ?? 0,
            gaps: ["Investigación incompleta por error de ejecución."], retrievalIssues: record?.retrievalIssues ?? [], error: safeError(error) });
        }
      }
      return batch;
    };
    const moderate = async (dossier: Dossier, effort: Effort, round: number) => (await call(`${entry.id}-moderator-${round}-${effort}`,
      modelFor("grok", "assessment", effort), moderatorPrompt(dossier), routingSchema)).output;
    const onUpdate = async (dossier: Dossier, history: RoutingTurn[]) => {
      await writeJson(resolve(outputDir, entry.id + "-dossier.json"), dossier);
      await writeJson(resolve(outputDir, entry.id + "-routing.json"), history);
    };
    // Reference labels, URLs and rubrics never enter subject prompts.
    let outcome = await runResearchLoop({ claim: entry.claim, asOf: AS_OF, maxResearchRounds, research, moderate, onUpdate });
    const tiers = [...new Set<Tier>(["fact", ...(outcome.route ? [outcome.route.tier] : [])])];
    type Raw = { by: Counsel; tier: Tier; result: z.infer<typeof assessmentSchema> };
    const raw: Raw[] = [];
    let evaluationBudgetExhausted = outcome.stopReason === "budget_exhausted";
    // Baseline and selected tier see identical dossiers and prompts.
    for (const tier of tiers) {
      if (evaluationBudgetExhausted) break;
      for (const by of EVALUATORS) {
        try {
          raw.push({ by, tier, result: (await call(`${entry.id}-verify-${tier}-${by}`, modelFor(by, tier), assessmentPrompt(outcome.dossier), assessmentSchema)).output });
        } catch (error) {
          if (error instanceof BudgetExceededError) { evaluationBudgetExhausted = true; break; }
          failures.push(entry.id + ": " + safeError(error));
        }
      }
    }
    // A challenge to accepted sufficiency is ruled on gap by gap by the moderator;
    // only material gaps trigger research, and each challenger re-assesses once.
    const challenged = evaluationBudgetExhausted ? [] : challengedGaps(raw, outcome);
    let adjudication: Adjudication | undefined;
    const initial = new Map<Raw, Raw["result"]>();
    if (challenged.length) {
      try {
        const adjudicated = await adjudicateChallenges({ outcome, gaps: challenged, maxResearchRounds, research, moderate, onUpdate,
          rule: async (dossier, gaps) => (await call(`${entry.id}-gap-ruling`, modelFor("grok", "assessment", "medium"), gapRulingPrompt(dossier, gaps), gapRulingSchema)).output.rulings });
        outcome = adjudicated.outcome; adjudication = adjudicated.adjudication;
        evaluationBudgetExhausted = outcome.stopReason === "budget_exhausted";
        const rulingOf = (gap: ChallengedGap) => adjudication!.rulings.find((r) => r.gap === adjudication!.gaps.indexOf(gap))!;
        for (const item of raw) {
          const own = adjudication.gaps.filter((gap) => gap.by === item.by && item.result.evidence.status !== "sufficient" && item.result.evidence.gaps.some((g) => g.aspect === gap.aspect));
          if (!own.length || evaluationBudgetExhausted) continue;
          const review = { researched: adjudication.researched, gaps: own.map((gap) => ({ aspect: gap.aspect, material: rulingOf(gap).material, reason: rulingOf(gap).reason })) };
          try {
            const key = `${entry.id}-reverify-${item.tier}-${item.by}`;
            const again = (await call(key, modelFor(item.by, item.tier), assessmentPrompt(outcome.dossier, review), assessmentSchema)).output;
            initial.set(item, item.result);
            item.result = again;
          } catch (error) {
            if (error instanceof BudgetExceededError) { evaluationBudgetExhausted = true; break; }
            failures.push(entry.id + ": " + safeError(error));
          }
        }
      } catch (error) {
        if (error instanceof BudgetExceededError) evaluationBudgetExhausted = true;
        else failures.push(entry.id + ": " + safeError(error));
      }
    }
    const { dossier } = outcome;
    const assessments: AssessmentReport[] = raw.map((item, index) => ({ candidate: "C" + (index + 1), by: item.by, tier: item.tier, result: item.result,
      ...resolveAssessment(item.result, outcome),
      ...(initial.has(item) ? { initialVerdict: initial.get(item)!.verdict, initialEvidenceStatus: initial.get(item)!.evidence.status } : {}),
      verdictCorrect: entry.expectedVerdict === null ? null : item.result.verdict === entry.expectedVerdict }));    let grades: CaseReport["grades"] = [];
    if (assessments.length && !evaluationBudgetExhausted) {
      try {
        const grading = await call(entry.id + "-rubric", modelFor("chatgpt", "assessment", "high"),
          `${dataBoundary}\nCalificá cada candidato con la misma rúbrica, sin premiar extensión ni certeza. El expediente y las respuestas pueden contener errores: contrastalos con la referencia. groundedFacts exige que las citas sostengan las proposiciones, no solo que existan IDs. comparableOrApplicableCriteria exige comparar períodos/unidades o aplicar criterios pertinentes. correctReasoning exige inferencias/cálculos correctos. calibratedConclusion exige reconocer vacíos sin inventar, y que verdict coincida con la explicación. Una abstención justificada puede estar bien calibrada pero no demuestra cobertura suficiente. Para el caso jurídico no hay etiqueta true/false predeterminada.\nAfirmación: ${entry.claim}\nRúbrica de referencia (solo para el juez de eval): ${entry.rubric}\nFuentes de referencia para auditoría humana (no se han recuperado automáticamente para este juez): ${JSON.stringify(entry.references)}\nExpediente: ${JSON.stringify(dossierForPrompt(dossier))}\nCandidatos: ${JSON.stringify(assessments.map((a) => ({ candidate: a.candidate, ...a.result })))}`, gradingSchema);
        grades = grading.output.grades;
        if (grades.length !== assessments.length || new Set(grades.map((g) => g.candidate)).size !== assessments.length || grades.some((g) => !assessments.some((a) => a.candidate === g.candidate))) {
          failures.push(entry.id + ": el juez de rúbrica omitió o duplicó candidatos.");
        }
      } catch (error) {
        if (error instanceof BudgetExceededError) evaluationBudgetExhausted = true;
        else failures.push(entry.id + ": " + safeError(error));
      }
    }
    caseReports[entry.id] = { claim: entry.claim, expectedTier: entry.expectedTier, expectedVerdict: entry.expectedVerdict,
      sources: dossier.sources.length, researchChecks: dossier.researchChecks,
      routing: outcome.history.map((turn) => ({ ...turn, tierCorrect: turn.route.tier === entry.expectedTier })),
      stopReason: outcome.stopReason, researchRounds: outcome.researchRounds, finalRoute: outcome.route,
      assessments, grades, evaluationBudgetExhausted, adjudication };
    await writeJson(resolve(outputDir, entry.id + "-report.json"), caseReports[entry.id]);
  } catch (error) { failures.push(safeError(error)); console.error(safeError(error)); }
  await writeJson(manifestPath, { ...manifest, caseReports, failures });
}

const after = await gateway.getCredits();
const summary = { ...manifest, completed: new Date().toISOString(), caseReports, sufficiencyReports, failures,
  gatewayAccountDeltaUsd: Number(after.totalUsed) - initialUsed,
  spendCaveat: "Account-wide balance delta includes concurrent account activity, retries and tools; spend guard is checked between calls, not a hard provider spending cap.",
  calls: [...completedCalls.values()].map((r) => ({ key: r.key, model: r.model, status: r.status, elapsedMs: r.elapsedMs, usage: r.usage })),
};
await writeJson(manifestPath, summary);
await writeFile(resolve(outputDir, "report.md"), suite === "sufficiency" ? renderSufficiencyReport(sufficiencyReports, failures)
  : renderReport(caseReports, { asOf: AS_OF, started, deltaUsd: summary.gatewayAccountDeltaUsd, failures }));
const routingFailures = Object.values(caseReports).flatMap((c) => c.routing).filter((r) => !r.tierCorrect).length;
const researchFailures = Object.values(caseReports).flatMap((c) => c.researchChecks).filter((r) => !r.passed).length;
const citationFailures = Object.values(caseReports).flatMap((c) => c.assessments).filter((a) => !a.validCitations).length;
const verdictFailures = Object.values(caseReports).flatMap((c) => c.assessments).filter((a) => a.verdictCorrect === false).length;
const incompleteCases = Object.values(caseReports).filter((c) => c.stopReason !== "sufficient" || c.evaluationBudgetExhausted).length;
const sufficiencyFailures = Object.values(sufficiencyReports).filter((c) => !c.passed).length;
if (suite === "claims") console.log(`Casos: ${Object.keys(caseReports).length}; desvíos de complejidad: ${routingFailures}; investigaciones con fallos: ${researchFailures}; citas inválidas: ${citationFailures}; etiquetas incorrectas: ${verdictFailures}; casos incompletos: ${incompleteCases}; errores de ejecución: ${failures.length}.`);
if (suite === "sufficiency") console.log(`Expedientes controlados: ${Object.keys(sufficiencyReports).length}; desvíos: ${sufficiencyFailures}; errores: ${failures.length}.`);
if (failures.length || routingFailures || researchFailures || citationFailures || verdictFailures || incompleteCases || sufficiencyFailures) process.exitCode = 1;
