import { ZodError } from "zod";
import type { CourtEvent, Evidence, EvidenceProposal, RecordedEvent, UnifiedSource } from "../domain/court.ts";
import { matchQuote } from "./quote-match.ts";
import { mapLimit, normalizeSourceUrl, type CanonicalSource, type SourceBlock, type SourceService } from "./sources.ts";

// Pipeline 3: the analysts propose sources by URL and verbatim quote; the host
// fetches each URL once, files the proposals whose quote it finds as evidence,
// and groups them by canonical source, as unify_evidence did in pipeline 2.

export type Proposal = EvidenceProposal & { by: Evidence["by"]; seq: number; at: string };
export type FetchedUrl = { url: string; sourceId?: string; error?: string };
// finalUrl: the page the proposed URL led to, when it was read (a grounding
// redirect names no page of its own).
export type RejectedProposal = Proposal & { reason: string; finalUrl?: string };

// The URLs fetched by one workflow step, so that no step waits on more than a
// few downloads.
export const COLLECTION_BATCH = 4;
// As for file_evidence: a passage longer than this is no longer a quote.
const MAX_EXCERPT_CHARS = 30_000;

export function proposalsOf(events: readonly RecordedEvent[]): Proposal[] {
  return events.flatMap((event) => event.type === "evidence_proposed" ? [{ ...event.proposal, by: event.by, seq: event.seq, at: event.at }] : []);
}

function canonicalUrl(url: string): string | undefined {
  try { return normalizeSourceUrl(url); } catch { return undefined; }
}

// Every proposed URL once, in the order first proposed.
export function proposedUrls(events: readonly RecordedEvent[]): string[] {
  return [...new Set(proposalsOf(events).flatMap((proposal) => canonicalUrl(proposal.url) ?? []))];
}

// One bounded unit of collection. Downloads and extraction are durable,
// deduplicated source operations: a retried step reads them back. A source that
// cannot be read rejects its proposals; one still being read by another owner
// fails the step, so that the workflow retries it.
export async function fetchProposedUrls(reader: SourceService, urls: readonly string[]): Promise<FetchedUrl[]> {
  return mapLimit(urls, COLLECTION_BATCH, async (url) => {
    try {
      const result = await reader.read({ url, maxChars: 1 });
      if (result.status === "ready") return { url, sourceId: result.sourceId };
      if (result.status === "pending") throw new Error(`Source ${url} is still being read`);
      return { url, error: result.errorCode ?? `source_${result.status}` };
    } catch (error) {
      if (error instanceof ZodError) return { url, error: "invalid_url" };
      throw error;
    }
  });
}

export async function collectEvidence(events: readonly RecordedEvent[], fetched: readonly FetchedUrl[], reader: SourceService): Promise<{ events: CourtEvent[]; rejected: RejectedProposal[] }> {
  const byUrl = new Map(fetched.map((result) => [result.url, result]));
  const sources = new Map<string, { source: CanonicalSource; blocks: SourceBlock[] }>();
  const filed: Evidence[] = [], rejected: RejectedProposal[] = [], seen = new Set<string>();
  let next = events.filter((event) => event.type === "evidence_filed").length + 1;
  for (const proposal of proposalsOf(events)) {
    const url = canonicalUrl(proposal.url);
    const result = url ? byUrl.get(url) : undefined;
    if (!result?.sourceId) { rejected.push({ ...proposal, reason: url ? result?.error ?? "not_fetched" : "invalid_url" }); continue; }
    if (!sources.has(result.sourceId)) {
      const source = await reader.source(result.sourceId);
      sources.set(result.sourceId, { source, blocks: await reader.blocks(source.document) });
    }
    const { source, blocks } = sources.get(result.sourceId)!;
    const match = matchQuote(blocks, proposal.quote);
    if (!match) { rejected.push({ ...proposal, reason: "quote_not_found", finalUrl: source.acquisition.finalUrl }); continue; }
    const excerpt = blocks.filter((block) => match.blockIds.includes(block.id)).map((block) => `[${block.id}] ${block.text}`).join("\n\n");
    if (excerpt.length > MAX_EXCERPT_CHARS) { rejected.push({ ...proposal, reason: "passage_too_long", finalUrl: source.acquisition.finalUrl }); continue; }
    // The same passage proposed twice by one analyst, with the same stance, is one contribution.
    const key = JSON.stringify([proposal.by, proposal.claimId, proposal.stance, source.sourceId, match.blockIds]);
    if (seen.has(key)) continue;
    seen.add(key);
    filed.push({ id: "P" + next++, by: proposal.by, claimId: proposal.claimId, stance: proposal.stance, title: source.document.title, url: source.acquisition.finalUrl, excerpt,
      sourceId: source.sourceId, blockIds: match.blockIds, ...(proposal.commentary ? { commentary: proposal.commentary } : {}) });
  }
  const groups = new Map<string, Evidence[]>();
  for (const evidence of filed) groups.set(evidence.sourceId!, [...groups.get(evidence.sourceId!) ?? [], evidence]);
  const unified: UnifiedSource[] = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([sourceId, contributions], index) => {
    const url = new URL(contributions[0]!.url);
    url.hash = "";
    return { id: "E" + (index + 1), title: contributions[0]!.title, url: url.href, contributions, sourceId };
  });
  return { events: [...filed.map((evidence): CourtEvent => ({ type: "evidence_filed", evidence })), { type: "evidence_unified", sources: unified }], rejected };
}

// The audit record of a proposal the host did not file: what was proposed, and why.
export function rejectionRecord(proposal: RejectedProposal) {
  return { schemaVersion: 2 as const, id: `proposal:${proposal.seq}`, kind: "proposal_rejected" as const, at: proposal.at, seat: proposal.by, phase: "instruction",
    data: { claimId: proposal.claimId, url: proposal.url, ...(proposal.finalUrl ? { finalUrl: proposal.finalUrl } : {}), quote: proposal.quote, stance: proposal.stance, reason: proposal.reason } };
}
