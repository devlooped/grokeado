import { z } from "zod";
import { courtModel } from "../court/models.ts";
import type { CaseRecord, RecordedEvent } from "../domain/court.ts";
import type { ArtifactStore } from "../evidence/artifacts.ts";
import { EvidenceReadSchema, loadSettledCorpus, readEvidence } from "../evidence/settled.ts";
import { sha256 } from "../evidence/validate.ts";
import { assertToolCapability, type InstructionPhase } from "./authorization.ts";
import { discover } from "./research.ts";
import { normalizeSourceUrl, SourceReadSchema, type SourceService } from "./sources.ts";

export const DiscoveryInput = z.object({ query: z.string().min(3).max(4000), reviewSourceId: z.string().regex(/^E[1-9]\d*$/).optional() }).strict();
export const SourceInput = SourceReadSchema.extend({ reviewSourceId: z.string().regex(/^E[1-9]\d*$/).optional() }).strict();
export const SourceToolSchemas = { read_source: SourceInput, read_evidence: EvidenceReadSchema, web_search: DiscoveryInput, x_search: DiscoveryInput };
export type SourceTool = keyof typeof SourceToolSchemas;
export function sourceToolsFor(phase: InstructionPhase): SourceTool[] {
  return phase === "debate" ? ["read_evidence"] : phase === "intake" ? ["read_source"] : ["read_source", "web_search", "x_search"];
}

// Used unchanged by participating host seats and SDK-authenticated sandboxes.
export async function executeSourceTool(call: { tool: SourceTool; input: unknown; callId: string }, context: { record: CaseRecord; events: readonly RecordedEvent[]; phase: InstructionPhase; seat: string; turnId: string; reader: SourceService; artifacts: ArtifactStore; worker?: Parameters<typeof discover>[4] }) {
  const { record, events, phase, reader, artifacts, seat, turnId } = context;
  assertToolCapability(phase, call.tool);
  if (call.tool === "read_evidence") return readEvidence(await loadSettledCorpus(record.id, events, artifacts), EvidenceReadSchema.parse(call.input));
  const input = call.tool === "read_source" ? SourceInput.parse(call.input) : DiscoveryInput.parse(call.input);
  if (phase === "criticism") {
    const unified = events.find((event) => event.type === "evidence_unified");
    if (unified?.type !== "evidence_unified" || !unified.sources.some((source) => source.id === input.reviewSourceId)) throw new Error("review_source_required");
  } else if (input.reviewSourceId) throw new Error("review_context_not_available");
  if (call.tool === "read_source" && "url" in input) {
    if (phase === "intake" && (record.submission.kind !== "link" || normalizeSourceUrl(record.submission.url) !== normalizeSourceUrl(input.url))) throw new Error("intake_source_forbidden");
    const { reviewSourceId, ...sourceInput } = input;
    const result = await reader.read(sourceInput);
    const path = `instruction/research/${seat}/${turnId}/${sha256(call.callId)}-${result.status}.json`;
    await artifacts.write(record.id, new Map([[path, JSON.stringify({ provenance: reviewSourceId ? "review_context" : "source_read", ...(reviewSourceId ? { reviewSourceId } : {}), sourceId: result.sourceId, input: sourceInput, status: result.status })]]));
    return result;
  }
  if (!("query" in input) || (call.tool !== "web_search" && call.tool !== "x_search")) throw new Error("invalid_discovery");
  const model = record.models?.[call.tool === "x_search" ? "research.x" : seat === "judge" ? "judge" : `counsel.${seat}`];
  if (!model) throw new Error("research_snapshot_unavailable");
  return discover({ ...input, kind: call.tool, seat, turnId, callId: call.callId }, reader, artifacts, courtModel(model.id, model.effort), context.worker);
}
