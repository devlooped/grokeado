import type { generateText } from "ai";
import type { Counsel } from "../domain/court.ts";

export interface CourtModel {
  id: string;
  providerOptions?: Parameters<typeof generateText>[0]["providerOptions"];
}

export const MOCK_MODEL_ID = "court-fixture";

// Only report explicitly configured effort; provider defaults are not known.
export function modelEffort(model: CourtModel): string | null {
  const options = model.providerOptions as Record<string, Record<string, unknown>> | undefined;
  const provider = model.id.split("/", 1)[0];
  const value = provider === "spacexai" ? options?.xai?.reasoningEffort
    : provider === "google" ? (options?.google?.thinkingConfig as Record<string, unknown> | undefined)?.thinkingLevel
    : provider === "anthropic" ? options?.anthropic?.effort
    : provider === "openai" ? options?.openai?.reasoningEffort
    : undefined;
  return typeof value === "string" && value ? value : null;
}

// AI Gateway catalog IDs, shared by execution and the recorded acta.
export const JUDGE_MODEL: CourtModel = { id: "spacexai/grok-4.7", providerOptions: { xai: { reasoningEffort: "high" } } };

export const COUNSEL_MODELS: Record<Counsel, CourtModel> = {
  grok: JUDGE_MODEL,
  gemini: { id: "google/gemini-4-argon", providerOptions: { google: { thinkingConfig: { thinkingLevel: "high" } } } },
  chatgpt: { id: "openai/gpt-5.5" },
  claude: { id: "anthropic/claude-opus-5.5", providerOptions: { anthropic: { effort: "high" } } },
};
