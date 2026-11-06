import { illustrateCase, liveCoverDeps, type CoverModels } from "../court/cover.ts";
import { loadModels } from "../court/model-config.ts";
import { counselModels, courtModel, DEFAULT_MODELS, MOCK_MODEL_ID, modelEffort, modelSnapshot, seatModel, type CourtModel, type ModelConfig } from "../court/models.ts";
import { playTurn } from "../court/play.ts";
import { resolveCaseLanguage } from "../court/language.ts";
import { holdSession } from "../court/procedure.ts";
import type { Docket, TurnOutcome, TurnSpec } from "../court/turns.ts";
import type { CourtEvent, RecordedEvent, Submission, SubmissionContext } from "../domain/court.ts";
import { languageInstruction } from "../domain/language.ts";
import { collectEvidenceBase } from "../evidence/collect.ts";
import { imageDescriber } from "../evidence/describe.ts";
import { liveContributionDeps, saveContributedSources } from "../evidence/contributions.ts";
import { translateFiledEvidence, translatorFor } from "../evidence/translate.ts";
import { archiveEvidence } from "../evidence/archive.ts";
import { blobConfigured, caseArtifactStore } from "../evidence/blob.ts";
import { runEvidenceStep, type EvidenceStepResult } from "../evidence/sandbox.ts";
import type { EvidenceSeat, EvidenceStage } from "../evidence/schema.ts";
import { closeCase, openCase, saveEvents } from "./steps.ts";
import { getCase, getImage, recordCaseToolActivity, revokeSandboxBindings, saveCaseLanguage, saveCaseModels } from "../store.ts";
import { collectInstruction } from "../instruction/intake.ts";
import { fatalSourceFailure, liveSourceDependencies, SourceService } from "../instruction/sources.ts";
import { sourceDownloader } from "../instruction/research.ts";
import { mockInstructionArtifacts, mockInstructionSources, mockResearchWorker } from "../instruction/mock.ts";
import { createMockSeat } from "../court/mock.ts";
import { advanceSharedTurn } from "../court/settled-play.ts";
import { settleEvidence } from "../evidence/settled.ts";
import { caseSourceService } from "../instruction/proxy.ts";
import { deleteCaseSandboxes } from "../instruction/preparation.ts";

// One snapshot per session: every turn uses, and the case records, the same models.
async function configuredModels(caseId: string, shared = false): Promise<ModelConfig> {
  "use step";
  if (shared) {
    const stored = await getCase(caseId);
    if (stored?.models) return Object.fromEntries(Object.entries(stored.models).map(([role, model]) => [role, courtModel(model.id, model.effort)])) as ModelConfig;
  }
  const models = await loadModels();
  await saveCaseModels(caseId, modelSnapshot(models));
  return models;
}

async function collectShared(caseId: string, submission: Submission, simulated: boolean, models: ModelConfig) {
  "use step";
  const sources = simulated ? mockInstructionSources : liveSourceDependencies(models.translator, caseId);
  if (!simulated) sources.download = sourceDownloader(models["research.x"], caseId);
  try {
    return await collectInstruction(caseId, submission, models, simulated, {
      sources, artifacts: simulated ? mockInstructionArtifacts : caseArtifactStore, getImage, saveLanguage: saveCaseLanguage, detect: resolveCaseLanguage,
      ...(simulated ? { describe: async () => ({ text: "SIMULACIÓN LOCAL: Imagen ficticia para el procedimiento.", tool: "fixture", confidence: 1 }) } : {}),
    });
  } catch (error) { throw fatalSourceFailure(error); }
}

// One unit of a shared turn: a preparation call or a decision generation. The
// workflow loops over units, so no step lasts as long as the whole turn.
async function advanceShared(caseId: string, docket: Docket, spec: TurnSpec, record: readonly CourtEvent[], attempt: number): Promise<TurnOutcome | null> {
  "use step";
  const stored = await getCase(caseId);
  if (!stored) throw new Error("Shared case unavailable");
  let outcome: TurnOutcome | undefined;
  try {
    outcome = await advanceSharedTurn(caseId, docket, spec, record, attempt, docket.simulated ? {
      record: stored, reader: new SourceService(caseId, docket.language!, mockInstructionSources), artifacts: mockInstructionArtifacts,
      model: createMockSeat({ spec, record, submission: docket.submission, shared: true }, false).model,
      prepare: async () => "SIMULACIÓN LOCAL: Análisis preparatorio ficticio; no agrega pruebas.", worker: mockResearchWorker,
      audit: async () => {}, activity: recordCaseToolActivity,
    } : undefined);
  } catch (error) { throw fatalSourceFailure(error); }
  return outcome ? linkEvidenceRun(outcome, undefined, docket.simulated, docket.models) : null;
}

// A turn makes progress or spends its time budget at every unit; this bound
// only stops a defect from looping without end.
const MAX_TURN_UNITS = 100;

async function playShared(caseId: string, docket: Docket, spec: TurnSpec, record: readonly CourtEvent[], attempt: number): Promise<TurnOutcome> {
  for (let unit = 0; unit < MAX_TURN_UNITS; unit++) {
    const outcome = await advanceShared(caseId, docket, spec, record, attempt);
    if (outcome) return outcome;
  }
  throw new Error("Shared turn did not finish within " + MAX_TURN_UNITS + " steps");
}

async function settleShared(caseId: string, language: string, events: readonly RecordedEvent[], simulated: boolean) {
  "use step";
  await revokeSandboxBindings(caseId);
  const stored = await getCase(caseId);
  if (!stored) throw new Error("Shared case unavailable");
  try {
    return await settleEvidence(caseId, language, events, simulated ? new SourceService(caseId, language, mockInstructionSources) : caseSourceService(stored), simulated ? mockInstructionArtifacts : caseArtifactStore);
  } catch (error) { throw fatalSourceFailure(error); }
}

async function revokeShared(caseId: string) {
  "use step";
  await revokeSandboxBindings(caseId);
}

// Case files are in storage by now; the VMs and their snapshots are not needed.
// Never fail a case over cleanup: snapshot retention and expiry bound the rest.
async function disposeSandboxes(caseId: string) {
  "use step";
  try { await deleteCaseSandboxes(caseId); }
  catch (error) { console.warn("Could not delete case sandboxes:", error); }
}

async function collect(caseId: string, submission: Submission, simulated: boolean, describer: CourtModel) {
  "use step";
  const describe = !simulated && submission.kind === "image" ? imageDescriber(describer, submission.note, caseId) : undefined;
  return collectEvidenceBase(caseId, submission, simulated, describe);
}

async function determineLanguage(caseId: string, submission: Submission, context: SubmissionContext | undefined, simulated: boolean, model: CourtModel): Promise<string> {
  "use step";
  const language = await resolveCaseLanguage(caseId, submission, context, simulated, undefined, model);
  if (!submission.resolvedLanguage) await saveCaseLanguage(caseId, language);
  return language;
}

// Keep source processing separate from the paid court turn so a retry need not
// repeat the analyst's model call.
async function collectSources(caseId: string, events: CourtEvent[], language: string, translator: CourtModel): Promise<void> {
  "use step";
  if (blobConfigured()) await saveContributedSources(caseId, events, language, liveContributionDeps(translator, caseId));
}

async function translateContributions(caseId: string, outcome: TurnOutcome, language: string, translator: CourtModel): Promise<TurnOutcome> {
  "use step";
  return { ...outcome, events: await translateFiledEvidence(outcome.events, language, translatorFor(translator, caseId)) };
}

async function archive(caseId: string): Promise<void> {
  "use step";
  if (blobConfigured()) await archiveEvidence(caseId);
}

// A missing cover never fails a case: the home page shows a placeholder instead.
async function illustrate(caseId: string, simulated: boolean, models: CoverModels): Promise<void> {
  "use step";
  if (simulated) return;
  try {
    await illustrateCase(caseId, liveCoverDeps(models, caseId));
  } catch (err) {
    console.warn("Cover for case " + caseId + " failed:", err);
  }
}

async function play(
  caseId: string,
  docket: Docket,
  spec: TurnSpec,
  record: readonly CourtEvent[],
  attempt: number,
  evidence?: EvidenceStepResult
) {
  "use step";
  const outcome = await playTurn(caseId, docket, spec, record, attempt, evidence);
  return linkEvidenceRun(outcome, evidence?.runId, docket.simulated, docket.models);
}

export function linkEvidenceRun(outcome: TurnOutcome, runId?: string, simulated = false, models: ModelConfig = DEFAULT_MODELS): TurnOutcome {
  return { ...outcome, events: outcome.events.map((event) => event.type === "statement" ? {
    ...event, modelId: simulated ? MOCK_MODEL_ID : seatModel(models, event.by).id, effort: simulated ? null : modelEffort(seatModel(models, event.by)), ...(runId ? { evidenceRunId: runId } : {}),
  } : event) };
}

function evidenceTask(spec: TurnSpec, targetLanguage: string): { seat: EvidenceSeat; stage: EvidenceStage; task: string } | undefined {
  const language = " " + languageInstruction(targetLanguage);
  if (spec.kind === "instruction") {
    return { seat: spec.counsel, stage: "exposicion", task: "Examiná el expediente base y producí fragmentos neutrales y un borrador de argumento para la exposición." + language };
  }
  if (spec.kind === "statement") {
    return { seat: spec.counsel, stage: spec.stage === "opening" ? "exposicion" : "objecion", task: "Prepará fragmentos y un borrador de argumento para esta intervención, contrastando cualquier fragmento ajeno con el archivo original." + language };
  }
  if (spec.kind === "objection") {
    return { seat: spec.counsel, stage: "objecion", task: "Revisá el material base y los fragmentos de los pares para identificar evidencia que sustente o refute una objeción." + language };
  }
  if (spec.kind === "closing") {
    return { seat: spec.counsel, stage: "conclusion", task: "Prepará una síntesis de evidencia y un borrador de conclusión, señalando límites y contradicciones." + language };
  }
}

async function prepareEvidence(caseId: string, spec: TurnSpec, simulated: boolean, language: string, models: ModelConfig): Promise<EvidenceStepResult | undefined> {
  const request = evidenceTask(spec, language);
  if (!request) return undefined;
  return runEvidenceStep(caseId, request.seat, request.stage, request.task, simulated, language, { seat: seatModel(models, request.seat), translator: models.translator });
}

function describeError(err: unknown): string {
  const message = typeof err === "object" && err !== null && "message" in err ? String((err as { message: unknown }).message) : String(err);
  return message.slice(0, 500);
}

export async function courtSession(caseId: string): Promise<void> {
  "use workflow";
  let shared = false;
  try {
    const { submission, today, simulated, pipelineVersion } = await openCase(caseId);
    shared = pipelineVersion === 2;
    const models = await configuredModels(caseId, shared);
    const counsel = counselModels(models);
    const collected = shared ? await collectShared(caseId, submission, simulated, models) : undefined;
    const submissionContext = collected?.context ?? (shared ? undefined : await collect(caseId, submission, simulated, models["image.description"]));
    const language = collected?.language ?? await determineLanguage(caseId, submission, submissionContext, simulated, models.language);
    const docket: Docket = { submission: collected?.submission ?? submission, today, simulated, language, models, ...(submissionContext ? { submissionContext } : {}) };
    const effort = (model: CourtModel) => simulated ? null : modelEffort(model);
    await holdSession({
      submission,
      simulated,
      models: {
        judge: models.judge.id,
        counsel: { grok: counsel.grok.id, gemini: counsel.gemini.id, claude: counsel.claude.id, chatgpt: counsel.chatgpt.id },
      },
      efforts: {
        judge: effort(models.judge),
        counsel: { grok: effort(counsel.grok), gemini: effort(counsel.gemini), claude: effort(counsel.claude), chatgpt: effort(counsel.chatgpt) },
      },
      play: async (spec, record, attempt) => {
        if (shared) return playShared(caseId, docket, spec, record, attempt);
        const evidence = await prepareEvidence(caseId, spec, simulated, language, models);
        let outcome = await play(caseId, docket, spec, record, attempt, evidence);
        if (!simulated && spec.kind === "instruction") {
          outcome = await translateContributions(caseId, outcome, language, models.translator);
          await collectSources(caseId, outcome.events, language, models.translator);
        }
        return outcome;
      },
      commit: (events: readonly RecordedEvent[]) => saveEvents(caseId, [...events]),
      ...(shared ? { settle: (events: readonly RecordedEvent[]) => settleShared(caseId, language, events, simulated) } : {}),
    });
    await illustrate(caseId, simulated, models);
    if (!shared || !simulated) await archive(caseId);
    if (shared) {
      await revokeShared(caseId);
      await disposeSandboxes(caseId);
    }
    await closeCase(caseId, "resolved");
  } catch (err) {
    if (shared) {
      try { await revokeShared(caseId); }
      catch (cleanupError) { console.warn("Could not revoke sandbox bindings:", cleanupError); }
      await disposeSandboxes(caseId);
    }
    await closeCase(caseId, "failed", describeError(err));
    throw err;
  }
}
