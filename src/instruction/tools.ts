import { z } from "zod";
import { courtModel } from "../court/models.ts";
import { project, seatModels, type CaseRecord, type RecordedEvent, type Seat } from "../domain/court.ts";
import type { ToolActivity, ToolActivityData } from "../domain/tool-activity.ts";
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
export async function executeSourceTool(call: { tool: SourceTool; input: unknown; callId: string }, context: { record: CaseRecord; events: readonly RecordedEvent[]; phase: InstructionPhase; seat: string; turnId: string; reader: SourceService; artifacts: ArtifactStore; worker?: Parameters<typeof discover>[4]; activity?: (caseId: string, activity: ToolActivity) => Promise<void> }) {
  const { record, events, phase, reader, artifacts, seat, turnId } = context;
  assertToolCapability(phase, call.tool);
  const publish = async (data: ToolActivityData) => {
    const caller = seatModels(record, events)[seat as Seat];
    await context.activity?.(record.id, {
      schemaVersion: 2, kind: "tool_call", id: `tool:${sha256(JSON.stringify([phase, seat, turnId, call.callId, call.tool, call.input]))}`,
      at: new Date().toISOString(), seat: seat as Seat,
      ...(caller ? { modelId: caller.id, effort: caller.effort } : {}), data,
    });
  };
  if (call.tool === "read_evidence") {
    const input = EvidenceReadSchema.parse(call.input);
    const source = project(events).sources.get(input.id);
    if (!source || source.excluded !== false) throw new Error("Evidence ID is not admitted");
    await publish({ tool: "read_evidence", id: input.id, url: source.url });
    return readEvidence(await loadSettledCorpus(record.id, events, artifacts), input);
  }
  const input = call.tool === "read_source" ? SourceInput.parse(call.input) : DiscoveryInput.parse(call.input);
  if (phase === "criticism") {
    const unified = events.find((event) => event.type === "evidence_unified");
    if (unified?.type !== "evidence_unified" || !unified.sources.some((source) => source.id === input.reviewSourceId)) throw new Error("review_source_required");
  } else if (input.reviewSourceId) throw new Error("review_context_not_available");
  if (call.tool === "read_source" && "url" in input) {
    if (phase === "intake" && (record.submission.kind !== "link" || normalizeSourceUrl(record.submission.url) !== normalizeSourceUrl(input.url))) throw new Error("intake_source_forbidden");
    await publish({ tool: "read_source", url: normalizeSourceUrl(input.url) });
    const { reviewSourceId, ...sourceInput } = input;
    const result = await reader.read(sourceInput);
    const path = `instruction/research/${seat}/${turnId}/${sha256(call.callId)}-${result.status}.json`;
    await artifacts.write(record.id, new Map([[path, JSON.stringify({ provenance: reviewSourceId ? "review_context" : "source_read", ...(reviewSourceId ? { reviewSourceId } : {}), sourceId: result.sourceId, input: sourceInput, status: result.status })]]));
    return result;
  }
  if (!("query" in input) || (call.tool !== "web_search" && call.tool !== "x_search")) throw new Error("invalid_discovery");
  const model = record.models?.[call.tool === "x_search" ? "research.x" : seat === "judge" ? "judge" : `counsel.${seat}`];
  if (!model) throw new Error("research_snapshot_unavailable");
  await publish({ tool: call.tool, query: input.query });
  return discover({ ...input, kind: call.tool, seat, turnId, callId: call.callId }, reader, artifacts, courtModel(model.id, model.effort), context.worker);
}
