import { blobConfigured } from "../evidence/blob.ts";
import { requireLocalDatabase } from "../lib/local-database.ts";
import type { PipelineVersion } from "../domain/court.ts";
import { instructionBridgeConfig } from "./config.ts";

// New cases use shared instruction on a normal deployment. The explicit legacy
// switch is a rollback for new cases; stored case versions are never rewritten.
// COURT_PIPELINE_VERSION=3 opts new cases into native provider research.
export async function requestedPipeline(_caseId: string, simulated: boolean): Promise<PipelineVersion> {
  const version = process.env.COURT_PIPELINE_VERSION;
  if (version === "1") return 1;
  if (version && version !== "2" && version !== "3") throw new Error("COURT_PIPELINE_VERSION must be 1, 2 or 3");
  const shared = version === "3" ? 3 : 2;
  if (simulated) { requireLocalDatabase(); return shared; }
  await instructionBridgeConfig();
  if (!blobConfigured() || !process.env.AI_GATEWAY_API_KEY?.trim() || process.env.AI_GATEWAY_API_KEY.trim() === "placeholder") throw new Error("Durable storage and the authenticated sandbox bridge are required before research");
  return shared;
}
