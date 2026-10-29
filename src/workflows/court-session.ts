import { COUNSEL_MODELS, JUDGE_MODEL } from "../court/models.ts";
import { playTurn } from "../court/play.ts";
import { holdSession } from "../court/procedure.ts";
import type { Docket, TurnSpec } from "../court/turns.ts";
import type { CourtEvent, RecordedEvent } from "../domain/court.ts";
import { closeCase, openCase, saveEvents } from "./steps.ts";

async function play(caseId: string, docket: Docket, spec: TurnSpec, record: readonly CourtEvent[], attempt: number) {
  "use step";
  return playTurn(caseId, docket, spec, record, attempt);
}

function describeError(err: unknown): string {
  const message = typeof err === "object" && err !== null && "message" in err ? String((err as { message: unknown }).message) : String(err);
  return message.slice(0, 500);
}

export async function courtSession(caseId: string): Promise<void> {
  "use workflow";
  const { submission, today } = await openCase(caseId);
  const docket: Docket = { submission, today };
  try {
    await holdSession({
      submission,
      models: {
        judge: JUDGE_MODEL.id,
        counsel: { grok: COUNSEL_MODELS.grok.id, gemini: COUNSEL_MODELS.gemini.id, claude: COUNSEL_MODELS.claude.id },
      },
      play: (spec, record, attempt) => play(caseId, docket, spec, record, attempt),
      commit: (events: readonly RecordedEvent[]) => saveEvents(caseId, [...events]),
    });
    await closeCase(caseId, "resolved");
  } catch (err) {
    await closeCase(caseId, "failed", describeError(err));
    throw err;
  }
}
