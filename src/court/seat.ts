import { gateway, generateText, stepCountIs, type LanguageModel } from "ai";
import type { CourtModel } from "./models.ts";
import { createMockSeat, type MockTurn } from "./mock.ts";
import { researchTools } from "./research.ts";
import { toAiTools, type Toolset } from "./toolset.ts";

export interface SeatImage {
  data: Uint8Array;
  mimeType: string;
}

export interface SeatRun {
  model: CourtModel;
  research: boolean;
  prompt: string;
  tools: Toolset;
  done?(): boolean;
  images?: SeatImage[];
  mock?: MockTurn;
}

// One stateless conversation per durable workflow step. Court tools only mutate
// this turn's in-memory events; the workflow commits them after the step returns.
export async function runSeat(run: SeatRun, model?: LanguageModel): Promise<void> {
  const mock = run.mock ? createMockSeat(run.mock, run.research) : undefined;
  await generateText({
    model: model ?? mock?.model ?? gateway(run.model.id),
    providerOptions: run.model.providerOptions,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: run.prompt },
        ...(run.images ?? []).map((image) => ({ type: "file" as const, data: image.data, mediaType: image.mimeType })),
      ],
    }],
    tools: { ...(mock?.research ?? researchTools(run.research)), ...toAiTools(run.tools) },
    // Decision turns must call a court tool; a prose answer never enters the
    // record. Instruction ends only after the analyst explicitly closes it.
    toolChoice: run.done ? "required" : "auto",
    stopWhen: [stepCountIs(20), () => run.done?.() ?? false],
    // Keep a turn below the function duration; the court can retry unfinished turns.
    abortSignal: AbortSignal.timeout(Number(process.env.COURT_TURN_TIMEOUT_MS ?? 270_000)),
    maxRetries: 2,
  });
}
