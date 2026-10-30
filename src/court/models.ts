import type { generateText } from "ai";
import type { Counsel } from "../domain/court.ts";

export interface CourtModel {
  id: string;
  providerOptions?: Parameters<typeof generateText>[0]["providerOptions"];
}

// AI Gateway catalog IDs, shared by execution and the recorded acta.
export const JUDGE_MODEL: CourtModel = { id: "spacexai/grok-4.7", providerOptions: { xai: { reasoningEffort: "high" } } };

export const COUNSEL_MODELS: Record<Counsel, CourtModel> = {
  grok: JUDGE_MODEL,
  gemini: { id: "google/gemini-4-argon", providerOptions: { google: { thinkingConfig: { thinkingLevel: "high" } } } },
  chatgpt: { id: "openai/gpt-5.5" },
  claude: { id: "anthropic/claude-opus-5.5", providerOptions: { anthropic: { effort: "high" } } },
};
