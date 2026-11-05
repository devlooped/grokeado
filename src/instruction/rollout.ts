import { blobConfigured } from "../evidence/blob.ts";
import { requireLocalDatabase } from "../lib/local-database.ts";
import { instructionBridgeConfig } from "./config.ts";

// New cases use shared instruction on a normal deployment. The explicit legacy
// switch is a rollback for new cases; stored case versions are never rewritten.
export function requestedPipeline(_caseId: string, simulated: boolean): 1 | 2 {
  const version = process.env.COURT_PIPELINE_VERSION;
  if (version === "1") return 1;
  if (version && version !== "2") throw new Error("COURT_PIPELINE_VERSION must be 1 or 2");
  if (simulated) { requireLocalDatabase(); return 2; }
  instructionBridgeConfig();
  if (!blobConfigured() || !process.env.EVIDENCE_AI_GATEWAY_API_KEY?.trim() || process.env.EVIDENCE_AI_GATEWAY_API_KEY.trim() === "placeholder") throw new Error("Durable storage and the authenticated sandbox bridge are required before research");
  return 2;
}
