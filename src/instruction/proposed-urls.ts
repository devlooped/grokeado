import type { Evidence, EvidenceProposal, RecordedEvent } from "../domain/court.ts";

// The part of pipeline 3 collection that the court-session workflow runs
// itself, outside its steps: it imports no Node.js modules, so that it can go
// in the workflow bundle. Downloads and filing stay in collection.ts.

export type Proposal = EvidenceProposal & { by: Evidence["by"]; seq: number; at: string };

// The URLs fetched by one workflow step, so that no step waits on more than a
// few downloads.
export const COLLECTION_BATCH = 4;

export function normalizeSourceUrl(raw: string): string {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid source URL");
  url.hash = "";
  return url.href;
}

export function proposalsOf(events: readonly RecordedEvent[]): Proposal[] {
  return events.flatMap((event) => event.type === "evidence_proposed" ? [{ ...event.proposal, by: event.by, seq: event.seq, at: event.at }] : []);
}

export function canonicalUrl(url: string): string | undefined {
  try { return normalizeSourceUrl(url); } catch { return undefined; }
}

// Every proposed URL once, in the order first proposed.
export function proposedUrls(events: readonly RecordedEvent[]): string[] {
  return [...new Set(proposalsOf(events).flatMap((proposal) => canonicalUrl(proposal.url) ?? []))];
}
