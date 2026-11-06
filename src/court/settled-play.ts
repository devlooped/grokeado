import { gateway, generateText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { z } from "zod";
import type { CaseRecord, CourtEvent, RecordedEvent } from "../domain/court.ts";
import type { ArtifactStore } from "../evidence/artifacts.ts";
import { caseArtifactStore } from "../evidence/blob.ts";
import { loadSettledCorpus } from "../evidence/settled.ts";
import { sha256 } from "../evidence/validate.ts";
import { CourtActionSchemas, createCourtActions, phaseActions, turnPhase } from "../instruction/court-tools.ts";
import { caseSourceService } from "../instruction/proxy.ts";
import { preparationDefinitions, prepareInSandbox } from "../instruction/preparation.ts";
import type { SourceService } from "../instruction/sources.ts";
import { executeSourceTool, SourceToolSchemas, sourceToolsFor } from "../instruction/tools.ts";
import { getCase, recordCaseToolActivity, saveCaseAuditRecord } from "../store.ts";
import { modelEffort, seatModel } from "./models.ts";
import { PhaseSession, phaseSystem, type PhaseRepository } from "./phase-session.ts";
import { seatOf, type Docket, type TurnOutcome, type TurnSpec } from "./turns.ts";

export type SharedTurnDependencies = {
  reader: SourceService; artifacts: ArtifactStore; record: CaseRecord;
  repository?: PhaseRepository; model?: LanguageModel;
  prepare?(session: PhaseSession): Promise<string>;
  worker?: Parameters<typeof executeSourceTool>[1]["worker"];
  audit: typeof saveCaseAuditRecord;
  activity: typeof recordCaseToolActivity;
};

export async function playSharedTurn(caseId: string, docket: Docket, spec: TurnSpec, record: readonly CourtEvent[], attempt: number, injected?: SharedTurnDependencies): Promise<TurnOutcome> {
  const stored = injected?.record ?? await getCase(caseId);
  if (!stored || stored.pipelineVersion !== 2 || !docket.models || !docket.language) throw new Error("Shared pipeline requires its durable processing snapshot");
  const artifacts = injected?.artifacts ?? caseArtifactStore;
  const reader = injected?.reader ?? caseSourceService(stored);
  const audit = injected?.audit ?? saveCaseAuditRecord;
  const activity = injected?.activity ?? recordCaseToolActivity;
  const seat = seatOf(spec), phase = turnPhase(spec), model = seatModel(docket.models, seat);
  const corpus = phase === "debate" ? await loadSettledCorpus(caseId, record as RecordedEvent[], artifacts) : undefined;
  const initial = corpus
    ? `question.json:\n${corpus.question}\n\nindex.md:\n${corpus.index}`
    : JSON.stringify({ today: docket.today, submission: docket.submission, context: docket.submissionContext });
  const id = sha256(JSON.stringify([spec, attempt, ...record.map((event) => (event as RecordedEvent).seq || 0)]));
  const plan = createCourtActions(docket, spec, record, reader, corpus).plan;
  const task = `${JSON.stringify(spec)}\n${plan.instruction.replaceAll("web_fetch", "read_source")}\n${phase === "instruction" ? "file_evidence requiere sourceId y blockIds leídos con read_source; el host completa título y pasaje. unify_evidence no recibe grupos: el host agrupa por identidad canónica." : ""}`;
  const normalize = async (text: string) => (await reader.normalize("", text)).body;
  const localizedTask = await normalize(task);

  const preparation = await PhaseSession.open(caseId, { phase, seat, channel: "preparation", model,
    system: await normalize(phaseSystem(phase, seat, docket.language, "preparation")), tools: JSON.stringify(preparationDefinitions(phase)), initial }, injected?.repository);
  const prepTurn = await preparation.begin(id, record, localizedTask);
  let draft = prepTurn.draft ?? "";
  if (!prepTurn.complete) {
    draft = await (injected?.prepare ?? prepareInSandbox)(preparation);
    if (!prepTurn.complete) { prepTurn.draft = draft; await preparation.finish(); }
  }
  const names = phaseActions(phase, seat);
  const schemas = Object.fromEntries([...sourceToolsFor(phase).map((name) => [name, z.toJSONSchema(SourceToolSchemas[name], { target: "draft-7" })]), ...names.map((name) => [name, z.toJSONSchema(CourtActionSchemas[name], { target: "draft-7" })])]);
  const session = await PhaseSession.open(caseId, { phase, seat, channel: "decision", model,
    system: await normalize(phaseSystem(phase, seat, docket.language, "decision")), tools: JSON.stringify(schemas), initial }, injected?.repository);
  const normalizedDraft = draft ? (await reader.normalize("", draft)).body : "";
  const draftPath = `${phase === "debate" ? "discussion" : "instruction/runs"}/${seat}/${id}/draft.md`;
  if (normalizedDraft) await artifacts.write(caseId, new Map([[draftPath, normalizedDraft]]));
  const turn = await session.begin(id, record, JSON.stringify({ task: localizedTask, preparation: normalizedDraft }));
  if (turn.complete) return { events: turn.events, done: turn.done };
  const actions = createCourtActions(docket, spec, [...record, ...turn.events], reader, corpus);
  let pending = Promise.resolve();
  const serialize = <T>(run: () => Promise<T>): Promise<T> => { const result = pending.then(run); pending = result.then(() => {}, () => {}); return result; };
  const tools: ToolSet = {};
  for (const name of sourceToolsFor(phase)) tools[name] = {
    description: name, inputSchema: SourceToolSchemas[name],
    execute: (input, options) => executeSourceTool({ tool: name, input, callId: options.toolCallId }, { record: stored, events: record as RecordedEvent[], phase, seat, turnId: id, reader, artifacts, worker: injected?.worker, activity }),
  };
  for (const name of names) tools[name] = {
    description: name, inputSchema: CourtActionSchemas[name],
    execute: (input: unknown, options: { toolCallId: string }) => serialize(async () => {
      const signature = JSON.stringify([name, input]);
      const previous = turn.results[options.toolCallId];
      if (previous) { if (previous.input !== signature) throw new Error("Court tool-call ID was reused"); return previous.output; }
      const first = actions.plan.produced.length;
      const output = await actions.run(name, input);
      turn.events.push(...actions.plan.produced.slice(first));
      turn.done = actions.plan.done();
      turn.results[options.toolCallId] = { input: signature, output };
      await session.save();
      return output;
    }),
  };
  try {
    while ((!turn.done || turn.inFlightStep) && turn.steps < 20 && Date.now() < Date.parse(turn.expiresAt)) {
      const stepId = turn.inFlightStep ?? `decision:${session.state.id}:${id}:${turn.steps}`;
      turn.inFlightStep = stepId;
      await session.save();
      const result = await reader.hostStage(stepId, "decision-generation", async () => {
        const root = `${phase === "debate" ? "discussion" : "instruction/runs"}/${seat}/${id}/decision-${turn.steps}`;
        const requestPath = `${root}/request.json`, resultPath = `${root}/result.json`;
        const request = JSON.stringify({ modelId: model.id, providerOptions: session.state.model.providerOptions, system: session.state.system, messages: session.state.messages, tools: schemas });
        const generated = await generateText({ model: injected?.model ?? gateway(model.id), providerOptions: session.state.model.providerOptions,
          system: session.state.system, messages: session.state.messages, tools, toolChoice: "required", stopWhen: stepCountIs(1),
          maxRetries: 0, abortSignal: AbortSignal.timeout(Math.max(1, Date.parse(turn.expiresAt) - Date.now())),
        });
        // AI SDK 7 accumulates all assistant/tool messages here, not on finalStep.
        const result = { messages: generated.responseMessages, usage: generated.usage, at: new Date().toISOString(), toolCalls: generated.toolCalls.map(({ toolName, toolCallId, input }) => ({ toolName, toolCallId, input })) };
        await artifacts.write(caseId, new Map([[requestPath, request], [resultPath, JSON.stringify(result)]]));
        return { ...result, requestPath, resultPath };
      });
      await audit(caseId, stepId, { schemaVersion: 2, id: `step:${stepId}`, kind: "model_step", at: result.at, seat, phase, modelId: model.id, effort: modelEffort(model), data: { sessionId: session.state.id, turnId: id, channel: "decision", sequence: session.state.messages.length, step: turn.steps, usage: result.usage, toolCalls: result.toolCalls, request: result.requestPath, result: result.resultPath } });
      delete turn.inFlightStep;
      await session.append(result.messages as ModelMessage[]);
    }
    if (turn.inFlightStep) throw new Error("Uncheckpointed model step blocks phase continuation");
    await session.finish();
    return { events: turn.events, done: turn.done };
  } finally {
    if (session.state.activeTurn) { delete session.state.activeTurn; await session.save(); }
  }
}
