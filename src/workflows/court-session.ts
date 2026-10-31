import { COUNSEL_MODELS, JUDGE_MODEL } from "../court/models.ts";
import { playTurn } from "../court/play.ts";
import { holdSession } from "../court/procedure.ts";
import type { Docket, TurnSpec } from "../court/turns.ts";
import type { CourtEvent, RecordedEvent, Submission } from "../domain/court.ts";
import { collectEvidenceBase } from "../evidence/collect.ts";
import { runEvidenceStep, type EvidenceStepResult } from "../evidence/sandbox.ts";
import type { EvidenceSeat, EvidenceStage } from "../evidence/schema.ts";
import { closeCase, openCase, saveEvents } from "./steps.ts";

async function collect(caseId: string, submission: Submission, simulated: boolean) {
  "use step";
  return collectEvidenceBase(caseId, submission, simulated);
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
  return playTurn(caseId, docket, spec, record, attempt, evidence);
}

function evidenceTask(spec: TurnSpec): { seat: EvidenceSeat; stage: EvidenceStage; task: string } | undefined {
  if (spec.kind === "instruction") {
    return { seat: spec.counsel, stage: "exposicion", task: "Examiná el expediente base y producí fragments neutrales y un borrador de argumento para la exposición." };
  }
  if (spec.kind === "statement") {
    return { seat: spec.counsel, stage: spec.stage === "opening" ? "exposicion" : "objecion", task: "Prepará fragments y un borrador de argumento para esta intervención, contrastando cualquier fragmento ajeno con el raw." };
  }
  if (spec.kind === "objection") {
    return { seat: spec.counsel, stage: "objecion", task: "Revisá el material base y los fragments de los pares para identificar evidencia que sustente o refute una objeción." };
  }
  if (spec.kind === "closing") {
    return { seat: spec.counsel, stage: "conclusion", task: "Prepará una síntesis de evidencia y un borrador de conclusión, señalando límites y contradicciones." };
  }
}

async function prepareEvidence(caseId: string, spec: TurnSpec, simulated: boolean): Promise<EvidenceStepResult | undefined> {
  const request = evidenceTask(spec);
  if (!request) return undefined;
  return runEvidenceStep(caseId, request.seat, request.stage, request.task, simulated);
}

function describeError(err: unknown): string {
  const message = typeof err === "object" && err !== null && "message" in err ? String((err as { message: unknown }).message) : String(err);
  return message.slice(0, 500);
}

export async function courtSession(caseId: string): Promise<void> {
  "use workflow";
  const { submission, today, simulated } = await openCase(caseId);
  const submissionContext = await collect(caseId, submission, simulated);
  const docket: Docket = { submission, today, simulated, ...(submissionContext ? { submissionContext } : {}) };
  try {
    await holdSession({
      submission,
      simulated,
      models: {
        judge: JUDGE_MODEL.id,
        counsel: { grok: COUNSEL_MODELS.grok.id, gemini: COUNSEL_MODELS.gemini.id, claude: COUNSEL_MODELS.claude.id, chatgpt: COUNSEL_MODELS.chatgpt.id },
      },
      play: async (spec, record, attempt) => {
        const evidence = await prepareEvidence(caseId, spec, simulated);
        return play(caseId, docket, spec, record, attempt, evidence);
      },
      commit: (events: readonly RecordedEvent[]) => saveEvents(caseId, [...events]),
    });
    await closeCase(caseId, "resolved");
  } catch (err) {
    await closeCase(caseId, "failed", describeError(err));
    throw err;
  }
}
