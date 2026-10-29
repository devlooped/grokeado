import type { ModelSelection } from "@cursor/sdk";
import type { Counsel } from "../domain/court.ts";

export const JUDGE_MODEL: ModelSelection = { id: "grok-4.7", params: [{ id: "reasoning_effort", value: "high" }] };

export const COUNSEL_MODELS: Record<Counsel, ModelSelection> = {
  grok: { id: "grok-4.7", params: [{ id: "reasoning_effort", value: "high" }] },
  gemini: { id: "gemini-4-argon", params: [{ id: "reasoning_effort", value: "high" }] },
  claude: { id: "claude-opus-5-5", params: [{ id: "effort", value: "high" }] },
};
