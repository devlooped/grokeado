import type { CourtEvent } from "../domain/court.ts";
import { getImage } from "../store.ts";
import { COUNSEL_MODELS, JUDGE_MODEL } from "./models.ts";
import { runSeat, type SeatImage } from "./seat.ts";
import { conductTurn, type Docket, type TurnOutcome, type TurnSpec } from "./turns.ts";

async function imagesFor(caseId: string, docket: Docket): Promise<SeatImage[]> {
  if (docket.submission.kind !== "image") return [];
  const image = await getImage(caseId);
  if (!image) throw new Error("No se encontró la imagen del caso " + caseId + ".");
  return [{ data: image.bytes, mimeType: image.mimeType }];
}

// Workflow step body: one attempt of one seat, using AI Gateway for every model.
export async function playTurn(caseId: string, docket: Docket, spec: TurnSpec, record: readonly CourtEvent[], attempt: number): Promise<TurnOutcome> {
  const images = await imagesFor(caseId, docket);
  return conductTurn(docket, spec, record, attempt, async ({ seat, prompt, tools, done }) => {
    await runSeat({
      model: seat === "judge" ? JUDGE_MODEL : COUNSEL_MODELS[seat],
      research: spec.kind === "instruction",
      prompt,
      tools,
      done,
      images,
      mock: docket.simulated ? { spec, record, submission: docket.submission } : undefined,
    });
  });
}
