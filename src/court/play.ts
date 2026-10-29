import type { SDKCustomTool, SDKImage } from "@cursor/sdk";
import type { CourtEvent } from "../domain/court.ts";
import { getImage } from "../store.ts";
import { COUNSEL_MODELS, JUDGE_MODEL } from "./models.ts";
import { runSeat } from "./seat.ts";
import { conductTurn, type Docket, type TurnOutcome, type TurnSpec } from "./turns.ts";
import { openXTools } from "./x.ts";

let xTools: Promise<Record<string, SDKCustomTool>> | undefined;

function xToolset(): Promise<Record<string, SDKCustomTool>> {
  xTools ??= openXTools().catch((err: unknown) => {
    xTools = undefined;
    console.error("Sin búsqueda en X: " + (err instanceof Error ? err.message : String(err)));
    return {};
  });
  return xTools;
}

async function imagesFor(caseId: string, docket: Docket): Promise<SDKImage[]> {
  if (docket.submission.kind !== "image") return [];
  const image = await getImage(caseId);
  return image ? [{ data: image.bytes.toString("base64"), mimeType: image.mimeType }] : [];
}

// Workflow step body: one attempt of one seat, with the real agent behind it.
export async function playTurn(caseId: string, docket: Docket, spec: TurnSpec, record: readonly CourtEvent[], attempt: number): Promise<TurnOutcome> {
  const images = await imagesFor(caseId, docket);
  return conductTurn(docket, spec, record, attempt, async ({ seat, prompt, tools }) => {
    if (seat === "judge") {
      await runSeat({ name: "Moderador", model: JUDGE_MODEL, builtinTools: ["webFetch"], prompt, tools, images });
    } else {
      await runSeat({
        name: seat,
        model: COUNSEL_MODELS[seat],
        builtinTools: ["webSearch", "webFetch"],
        extraTools: await xToolset(),
        prompt,
        tools,
        images,
      });
    }
  });
}
