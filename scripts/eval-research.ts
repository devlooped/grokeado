import nextEnv from "@next/env";
import { gateway } from "ai";
import { FatalError } from "workflow";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { RESEARCH_CASES, type ResearchCase } from "../evals/research/cases.ts";
import { renderResearchReport, summarize, type CaseResult, type GatherRecord } from "../evals/research/report.ts";
import { runCall, type Definition } from "../sandbox/harness/instruction-agent.ts";
import { loadModels } from "../src/court/model-config.ts";
import { modelSnapshot, seatModel } from "../src/court/models.ts";
import { MemoryPhaseRepository, type PhaseSession } from "../src/court/phase-session.ts";
import { holdSession } from "../src/court/procedure.ts";
import { playSharedTurn } from "../src/court/settled-play.ts";
import { COUNSEL, project, type CaseRecord, type Counsel, type RecordedEvent } from "../src/domain/court.ts";
import { MemoryArtifactStore } from "../src/evidence/artifacts.ts";
import { COLLECTION_BATCH, collectEvidence, fetchProposedUrls, proposedUrls, type FetchedUrl, type RejectedProposal } from "../src/instruction/collection.ts";
import { criticismIndex } from "../src/instruction/criticism-index.ts";
import { NATIVE_CALL_MARGIN_MS } from "../src/instruction/preparation.ts";
import { sourceDownloader } from "../src/instruction/research.ts";
import { MemoryOperationRepository } from "../src/instruction/source-store.ts";
import { fatalSourceFailure, liveSourceDependencies, SourceService } from "../src/instruction/sources.ts";

// Pipeline 3 research, in this process, with no sandbox and no database: the
// production prompt builders and native tool table, the harness's call
// function with this machine's Gateway credential, and live source
// acquisition over memory stores. Each case runs intake, instruction, host
// collection and source review, then stops before the debate.
nextEnv.loadEnvConfig(process.cwd(), true);

const { values } = parseArgs({ options: {
  case: { type: "string" }, out: { type: "string" }, resume: { type: "boolean", default: false }, "max-usd": { type: "string", default: "8" },
} });
const cases = values.case ? RESEARCH_CASES.filter((c) => c.id === values.case) : RESEARCH_CASES;
if (!cases.length) throw new Error("Caso desconocido. Elegí: " + RESEARCH_CASES.map((c) => c.id).join(", "));
if (values.resume && !values.out) throw new Error("--resume requiere --out <directorio existente>.");
const maxUsd = Number(values["max-usd"]);
if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error("--max-usd debe ser un número positivo.");
if (process.env.COURT_AI_MODE === "mock") throw new Error("Este eval requiere AI Gateway real; quitá COURT_AI_MODE=mock.");
if (!process.env.AI_GATEWAY_API_KEY && !process.env.VERCEL_OIDC_TOKEN) throw new Error("Falta la credencial de AI Gateway; ver README.md.");

const outputDir = resolve(values.out ?? "test-results/research-evals/" + new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(outputDir, { recursive: true });
const manifestPath = resolve(outputDir, "run.json");
const existing = await readJson(manifestPath);
if (existing && !values.resume) throw new Error("El directorio ya contiene una corrida. Usá --resume para evitar llamadas pagadas duplicadas.");
if (!existing && values.resume) throw new Error("No se encontró run.json para reanudar.");
if (existing && existing.maxUsd !== maxUsd) throw new Error("--max-usd no coincide con la corrida a reanudar (USD " + existing.maxUsd + ").");

// Models follow the settings saved from /admin when a database is configured (read only).
const models = await loadModels();
const started = existing?.started ?? new Date().toISOString();
const initialUsed = Number(existing?.initialUsed ?? (await gateway.getCredits()).totalUsed);
const manifest = { started, initialUsed, maxUsd, models: modelSnapshot(models), purpose: "pipeline 3 research pilot: latency, quote matching, review coverage, cost" };
await writeJson(manifestPath, manifest);
console.log("Artefactos: " + outputDir);

const catalog = await gateway.getAvailableModels();
const modelIds = [...new Set([models.judge.id, models.translator.id, models["research.x"].id, ...COUNSEL.map((seat) => seatModel(models, seat).id)])];
for (const id of modelIds) if (!catalog.models.some((m) => m.id === id)) throw new Error("Modelo no disponible en Gateway: " + id);
// List prices from the catalog, per token; cache discounts and search fees are not included.
const prices = new Map(catalog.models.map((m) => [m.id, m.pricing ? { input: Number(m.pricing.input), output: Number(m.pricing.output) } : undefined]));
const costOf = (modelId: string, usage: unknown) => {
  const price = prices.get(modelId), tokens = usage as { inputTokens?: number; outputTokens?: number } | undefined;
  return price && tokens ? (tokens.inputTokens ?? 0) * price.input + (tokens.outputTokens ?? 0) * price.output : null;
};

class BudgetExceeded extends Error {}
async function checkBudget() {
  const used = Number((await gateway.getCredits()).totalUsed) - initialUsed;
  if (used >= maxUsd) throw new BudgetExceeded("Se alcanzó el límite de gasto Gateway: USD " + used.toFixed(4));
}
class StopAfterReview extends Error {}

async function readJson(path: string): Promise<any> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function writeJson(path: string, value: unknown) { await writeFile(path, JSON.stringify(value, null, 2) + "\n"); }
function safeError(error: unknown) {
  let message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  for (const name of ["AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN", "DATABASE_URL", "POSTGRES_URL"]) {
    const secret = process.env[name];
    if (secret) message = message.replaceAll(secret, "[REDACTED]");
  }
  return message.slice(0, 2500);
}

// Host collection as the court-session workflow runs it: a few URLs per step,
// and a step that fails is retried (the Workflow default, 3 retries) unless the
// failure is fatal. Source operations are durable, so a retry reads back what
// the failed attempt already read.
const STEP_MAX_RETRIES = 3, STEP_RETRY_DELAY_MS = 1000;
async function fetchInSteps(reader: SourceService, urls: readonly string[]): Promise<FetchedUrl[]> {
  const fetched: FetchedUrl[] = [];
  for (let start = 0; start < urls.length; start += COLLECTION_BATCH) {
    const batch = urls.slice(start, start + COLLECTION_BATCH);
    for (let attempt = 0; ; attempt++) {
      try { fetched.push(...await fetchProposedUrls(reader, batch)); break; }
      catch (error) {
        const failure = fatalSourceFailure(error);
        if (failure instanceof FatalError || attempt >= STEP_MAX_RETRIES) throw failure;
        console.log("REINTENTO recolección " + (start / COLLECTION_BATCH + 1) + " (" + (attempt + 1) + "/" + STEP_MAX_RETRIES + "): " + safeError(error));
        await new Promise((resolve) => setTimeout(resolve, STEP_RETRY_DELAY_MS));
      }
    }
  }
  return fetched;
}

async function runCase(entry: ResearchCase): Promise<CaseResult & { trace: unknown[] }> {
  const caseId = "eval-research-" + entry.id;
  const submission = { ...entry.submission, resolvedLanguage: "es" };
  const record: CaseRecord = { id: caseId, createdAt: new Date().toISOString(), status: "in_session", pipelineVersion: 3, submission, models: modelSnapshot(models) };
  const docket = { submission, today: new Date().toISOString().slice(0, 10), language: "es", models };
  const artifacts = new MemoryArtifactStore(), operations = new MemoryOperationRepository(), repository = new MemoryPhaseRepository();
  // No case ID for the live dependencies: they would record usage in the database.
  const dependencies = { ...liveSourceDependencies(models.translator), operations, artifacts, download: sourceDownloader(models["research.x"]) };
  const reader = new SourceService(caseId, "es", dependencies);
  const events: RecordedEvent[] = [], gathers: GatherRecord[] = [], trace: unknown[] = [];
  let rejected: RejectedProposal[] = [];
  const decisionCostUsd: Partial<Record<Counsel, number>> = {};

  // One call per preparation, as the VM would run it: native research with the
  // provider's tools, or (intake) an analysis without tools.
  const prepare = async (session: PhaseSession) => {
    const { state } = session, turn = state.activeTurn!;
    const definitions = JSON.parse(state.tools) as Definition[];
    const native = definitions.length > 0 && definitions.every((definition) => definition.type === "provider");
    const remainingMs = Date.parse(turn.expiresAt) - Date.now();
    await checkBudget();
    const time = performance.now();
    const label = `${entry.id} · ${state.seat} · ${state.phase}`;
    console.log("INICIO " + label + " / " + state.model.id);
    let gather: GatherRecord | undefined;
    const counsel = state.seat !== "judge" && (state.phase === "instruction" || state.phase === "criticism");
    try {
      const result = await runCall({ caseId, callId: `${turn.id}:0`, model: state.model, system: state.system, messages: state.messages, tools: definitions,
        toolChoice: native ? "auto" : "none", timeoutMs: native ? Math.max(1, remainingMs - NATIVE_CALL_MARGIN_MS) : 150_000,
        ...(native ? { maxOutputTokens: null } : {}), resultPath: "" }, { local: true });
      trace.push({ seat: state.seat, phase: state.phase, modelId: state.model.id, tools: definitions.map((d) => d.type === "provider" ? d.id : d.name), ...result, messages: undefined });
      if (counsel) gather = { seat: state.seat as Counsel, phase: state.phase as GatherRecord["phase"], modelId: state.model.id, tools: definitions.map((d) => d.type === "provider" ? d.id : d.name),
        elapsedMs: performance.now() - time, finishReason: result.finishReason, searches: result.searches ?? 0, sources: result.sources?.length ?? 0, costUsd: costOf(state.model.id, result.usage) };
      if (result.finishReason === "timeout") turn.timedOut = true;
      return result.text;
    } catch (error) {
      if (error instanceof BudgetExceeded || !counsel) throw error;
      // A provider that rejects a tool files nothing; the case goes on and the report names the tool.
      gather = { seat: state.seat as Counsel, phase: state.phase as GatherRecord["phase"], modelId: state.model.id, tools: definitions.map((d) => d.type === "provider" ? d.id : d.name),
        elapsedMs: performance.now() - time, finishReason: "error", searches: 0, sources: 0, costUsd: null, error: safeError(error) };
      return "";
    } finally {
      if (gather) gathers.push(gather);
      console.log("FIN " + label + " / " + Math.round(performance.now() - time) + " ms");
    }
  };

  let error: string | undefined;
  try {
    await holdSession({
      submission, models: { judge: models.judge.id, counsel: Object.fromEntries(COUNSEL.map((seat) => [seat, seatModel(models, seat).id])) as Record<Counsel, string> },
      commit: async (batch) => { events.push(...batch); },
      collect: async (log) => {
        const collected = await collectEvidence(log, await fetchInSteps(reader, proposedUrls(log)), reader);
        rejected = collected.rejected;
        return collected.events;
      },
      // The eval ends with source review; the debate is out of its scope.
      settle: async () => { throw new StopAfterReview(); },
      play: (spec, log, attempt) => playSharedTurn(caseId, docket, spec, log, attempt, {
        record, reader, artifacts, repository, prepare, activity: async () => {},
        audit: async (_caseId, _key, body) => {
          const step = body as { kind?: string; seat?: string; modelId?: string; data?: { usage?: unknown } };
          trace.push(body);
          if (step.kind !== "model_step" || !COUNSEL.includes(step.seat as Counsel)) return;
          const seat = step.seat as Counsel;
          decisionCostUsd[seat] = (decisionCostUsd[seat] ?? 0) + (costOf(step.modelId ?? "", step.data?.usage) ?? 0);
        },
      }),
    });
    if (events.some((event) => event.type === "dismissed")) error = "El moderador desestimó la presentación.";
  } catch (caught) {
    if (caught instanceof BudgetExceeded) throw caught;
    if (!(caught instanceof StopAfterReview)) error = safeError(caught);
  }
  let index = "";
  try { index = await criticismIndex([...project(events).sources.values()], reader); }
  catch (caught) { error ??= "Índice: " + safeError(caught); }
  return { id: entry.id, references: entry.references, events, rejected, index, gathers, decisionCostUsd, ...(error ? { error } : {}), trace };
}

const results: CaseResult[] = [];
let budgetStop: string | undefined;
for (const entry of cases) {
  const path = resolve(outputDir, entry.id + ".json");
  const done = await readJson(path) as CaseResult | undefined;
  if (done) { console.log("REUTILIZADO " + entry.id); results.push(done); continue; }
  try {
    await checkBudget();
    const result = await runCase(entry);
    await writeJson(path, result);
    results.push(result);
  } catch (error) {
    if (!(error instanceof BudgetExceeded)) throw error;
    budgetStop = error.message;
    console.error(budgetStop);
    break;
  }
}

const finished = new Date().toISOString();
const spentUsd = Number((await gateway.getCredits()).totalUsed) - initialUsed;
const summary = summarize(results);
await writeJson(manifestPath, { ...manifest, finished, spentUsd, budgetStop, cases: results.map((r) => r.id), summary,
  spendCaveat: "Account-wide balance delta includes concurrent account activity; the guard is checked before each call, not a hard provider cap." });
await writeFile(resolve(outputDir, "report.md"), renderResearchReport(results, { started, finished, spentUsd, maxUsd }) + (budgetStop ? "\n" + budgetStop + "\n" : ""));
console.log(`Casos: ${results.length}/${cases.length}; umbrales ${summary.passed ? "cumplidos" : "no cumplidos"}; gasto USD ${spentUsd.toFixed(3)}.`);
if (!summary.passed || budgetStop || results.length < cases.length) process.exitCode = 1;
