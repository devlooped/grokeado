import { CASES as TIER_CASES } from "../tiers/cases.ts";

// The research eval's cases: the claims of the tier eval, which have references,
// and AT-185-GA. Each runs from intake: the moderator sets the claims first.
// References never enter a prompt; the report only checks whether a seat found them.
export type ResearchCase = { id: string; submission: { kind: "text"; text: string }; references: readonly string[] };

export const RESEARCH_CASES: ResearchCase[] = [
  ...TIER_CASES.map((c) => ({ id: c.id, submission: { kind: "text" as const, text: c.claim }, references: c.references })),
  { id: "at-185-ga", submission: { kind: "text", text: "Flavio Bolsonaro huyó de Brasil y está prófugo" }, references: [] },
];
