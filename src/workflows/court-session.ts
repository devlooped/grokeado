import { illustrateCase, liveCoverDeps, type CoverModels } from "../court/cover.ts";
import { loadModels } from "../court/model-config.ts";
import { counselModels, courtModel, DEFAULT_MODELS, MOCK_MODEL_ID, modelEffort, modelSnapshot, seatModel, type CourtModel, type ModelConfig } from "../court/models.ts";
import { playTurn } from "../court/play.ts";
import { resolveCaseLanguage } from "../court/language.ts";
import { holdSession } from "../court/procedure.ts";
import { holdQuickSession, type QuickAnswer, type QuickEntry, type QuickFailure } from "../court/quick.ts";
import { quickAnswer, quickTiebreak, quickVote, simulatedQuickDependencies } from "../court/quick-play.ts";
import type { Docket, TurnOutcome, TurnSpec } from "../court/turns.ts";
import { checkType, sharedPipeline, type CaseRecord, type Counsel, type CourtEvent, type RecordedEvent, type Submission, type SubmissionContext } from "../domain/court.ts";
import { languageRule } from "../domain/language.ts";
import { collectEvidenceBase } from "../evidence/collect.ts";
import { imageDescriber } from "../evidence/describe.ts";
import { liveContributionDeps, saveContributedSources } from "../evidence/contributions.ts";
import { translateFiledEvidence, translatorFor } from "../evidence/translate.ts";
import { archiveEvidence, casePromptLocalization } from "../evidence/archive.ts";
import { cachePromptTranslations } from "../evidence/prompt-translation.ts";
import { blobConfigured, caseArtifactStore } from "../evidence/blob.ts";
import { runEvidenceStep, type EvidenceStepResult } from "../evidence/sandbox.ts";
import type { EvidenceSeat, EvidenceStage } from "../evidence/schema.ts";
import { closeCase, openCase, saveEvents } from "./steps.ts";
import { getCase, getCaseAuditRecords, getImage, recordCaseToolActivity, revokeSandboxBindings, saveCaseAuditRecord, saveCaseLanguage, saveCaseModels } from "../store.ts";
import { collectEvidence, fetchProposedUrls, rejectionRecord, type FetchedUrl } from "../instruction/collection.ts";
import { COLLECTION_BATCH, proposedUrls } from "../instruction/proposed-urls.ts";
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
      model: createMockSeat({ spec, record, submission: docket.submission, shared: true, native: stored.pipelineVersion === 3 }, false).model,
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

function collectionReader(caseId: string, language: string, simulated: boolean, stored: CaseRecord) {
  return simulated ? new SourceService(caseId, language, mockInstructionSources) : caseSourceService(stored);
}

// Pipeline 3 collection: a few proposed URLs per step, then one step that
// matches the quotes and files the evidence.
async function fetchProposals(caseId: string, language: string, urls: string[], simulated: boolean): Promise<FetchedUrl[]> {
  "use step";
  const stored = await getCase(caseId);
  if (!stored) throw new Error("Shared case unavailable");
  try { return await fetchProposedUrls(collectionReader(caseId, language, simulated, stored), urls); } catch (error) { throw fatalSourceFailure(error); }
}

async function collectProposals(caseId: string, language: string, events: readonly RecordedEvent[], fetched: FetchedUrl[], simulated: boolean): Promise<CourtEvent[]> {
  "use step";
  const stored = await getCase(caseId);
  if (!stored) throw new Error("Shared case unavailable");
  const collected = await collectEvidence(events, fetched, collectionReader(caseId, language, simulated, stored));
  if (!simulated) for (const proposal of collected.rejected) { const record = rejectionRecord(proposal); await saveCaseAuditRecord(caseId, record.id, record); }
  return collected.events;
}

async function collectProposedEvidence(caseId: string, language: string, events: readonly RecordedEvent[], simulated: boolean): Promise<CourtEvent[]> {
  const urls = proposedUrls(events), fetched: FetchedUrl[] = [];
  for (let start = 0; start < urls.length; start += COLLECTION_BATCH) fetched.push(...await fetchProposals(caseId, language, urls.slice(start, start + COLLECTION_BATCH), simulated));
  return collectProposals(caseId, language, events, fetched, simulated);
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

// case.jsonl translates the prompts of the case into its language. A few new
// translations per step, saved in the database cache, so the archive step only
// reads them. Says whether some are still missing.
const PROMPT_TRANSLATIONS_PER_STEP = 8;
const MAX_PROMPT_TRANSLATION_STEPS = 50;

async function translatePrompts(caseId: string): Promise<boolean> {
  "use step";
  const stored = await getCase(caseId);
  if (!blobConfigured() || !stored) return false;
  const { language, cache, translate, modelId } = casePromptLocalization(stored);
  const { missing } = await cachePromptTranslations(await getCaseAuditRecords(caseId), language, cache, translate, modelId, PROMPT_TRANSLATIONS_PER_STEP);
  return missing > 0;
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
  const language = languageRule(targetLanguage) + "\n\n";
  if (spec.kind === "instruction") {
    return { seat: spec.counsel, stage: "exposicion", task: language + "Examine the base case file and produce neutral passages and a draft argument for the statement." };
  }
  if (spec.kind === "statement") {
    return { seat: spec.counsel, stage: spec.stage === "opening" ? "exposicion" : "objecion", task: language + "Prepare passages and a draft argument for this intervention, checking any passage from another seat against the original file." };
  }
  if (spec.kind === "objection") {
    return { seat: spec.counsel, stage: "objecion", task: language + "Review the base material and the passages of the other seats to find evidence that supports or refutes an objection." };
  }
  if (spec.kind === "closing") {
    return { seat: spec.counsel, stage: "conclusion", task: language + "Prepare a synthesis of the evidence and a draft conclusion, pointing out limits and contradictions." };
  }
}

async function prepareEvidence(caseId: string, spec: TurnSpec, simulated: boolean, language: string, models: ModelConfig): Promise<EvidenceStepResult | undefined> {
  const request = evidenceTask(spec, language);
  if (!request) return undefined;
  return runEvidenceStep(caseId, request.seat, request.stage, request.task, simulated, language, { seat: seatModel(models, request.seat), translator: models.translator });
}

// A Quick check: one step per generation, so a completed paid answer is not
// paid again when the workflow replays.
async function answerQuick(caseId: string, submission: Submission, language: string, model: CourtModel, by: Counsel, attempt: number, simulated: boolean) {
  "use step";
  return quickAnswer(caseId, submission, language, model, by, attempt, simulated ? simulatedQuickDependencies("answer") : undefined);
}

async function voteQuick(caseId: string, submission: Submission, language: string, model: CourtModel, by: Counsel, answer: QuickAnswer, attempt: number, retry: QuickFailure | undefined, simulated: boolean) {
  "use step";
  return quickVote(caseId, submission, language, model, by, answer, attempt, retry, simulated ? simulatedQuickDependencies("vote") : undefined);
}

async function tiebreakQuick(caseId: string, submission: Submission, language: string, model: CourtModel, entries: QuickEntry[], attempt: number, simulated: boolean) {
  "use step";
  return quickTiebreak(caseId, submission, language, model, entries, attempt, simulated ? simulatedQuickDependencies("tiebreak") : undefined);
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
    shared = sharedPipeline(pipelineVersion);
    const models = await configuredModels(caseId, shared);
    const counsel = counselModels(models);
    const effort = (model: CourtModel) => simulated ? null : modelEffort(model);
    const seats = {
      models: { judge: models.judge.id, counsel: { grok: counsel.grok.id, gemini: counsel.gemini.id, claude: counsel.claude.id, chatgpt: counsel.chatgpt.id } },
      efforts: { judge: effort(models.judge), counsel: { grok: effort(counsel.grok), gemini: effort(counsel.gemini), claude: effort(counsel.claude), chatgpt: effort(counsel.chatgpt) } },
    };
    if (checkType(submission) === "quick") {
      // No intake, instruction or sandbox (nothing to revoke on failure): each
      // analyst answers and votes.
      shared = false;
      const language = await determineLanguage(caseId, submission, undefined, simulated, models.language);
      await holdQuickSession({
        submission, simulated, ...seats,
        answer: (by, attempt) => answerQuick(caseId, submission, language, counsel[by], by, attempt, simulated),
        vote: (by, answer, attempt, retry) => voteQuick(caseId, submission, language, counsel[by], by, answer, attempt, retry, simulated),
        tiebreak: (entries, attempt) => tiebreakQuick(caseId, submission, language, models.judge, entries, attempt, simulated),
        commit: (events: readonly RecordedEvent[]) => saveEvents(caseId, [...events]),
      });
      await illustrate(caseId, simulated, models);
      if (!simulated) await archive(caseId);
      await closeCase(caseId, "resolved");
      return;
    }
    const collected = shared ? await collectShared(caseId, submission, simulated, models) : undefined;
    const submissionContext = collected?.context ?? (shared ? undefined : await collect(caseId, submission, simulated, models["image.description"]));
    const language = collected?.language ?? await determineLanguage(caseId, submission, submissionContext, simulated, models.language);
    const docket: Docket = { submission: collected?.submission ?? submission, today, simulated, language, models, ...(submissionContext ? { submissionContext } : {}) };
    await holdSession({
      submission,
      simulated,
      ...seats,
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
      ...(pipelineVersion === 3 ? { collect: (events: readonly RecordedEvent[]) => collectProposedEvidence(caseId, language, events, simulated) } : {}),
    });
    await illustrate(caseId, simulated, models);
    if (shared && !simulated) for (let step = 0; step < MAX_PROMPT_TRANSLATION_STEPS && await translatePrompts(caseId); step++);
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
