import { COUNSEL, type CaseView } from "./court.ts";

// Keep each claim's votes separate: a model can vote differently on different claims.
export function caseCardVotes(view: Pick<CaseView, "claims">) {
  return view.claims.flatMap((claim) => claim.judgment ? [{
    id: claim.id,
    verdict: claim.judgment.verdict,
    models: COUNSEL.filter((model) => claim.votes[model]?.verdict === claim.judgment?.verdict),
  }] : []);
}

export function caseCardImageUrl(id: string, coverVersion?: string): string {
  const path = `/c/${encodeURIComponent(id)}/card`;
  return coverVersion === undefined ? path : `${path}?v=${encodeURIComponent(coverVersion)}`;
}
