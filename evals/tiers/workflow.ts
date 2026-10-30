import type { z } from "zod";
import type { Counsel } from "../../src/domain/court.ts";
import { assessmentSchema, evidenceCitations, unify, validateRouting, validCitations,
  type Contribution, type Evidence, type Routing, type Source } from "./core.ts";

export class BudgetExceededError extends Error {}
export type Effort = "medium" | "high";
export type StopReason = "sufficient" | "iteration_limit" | "budget_exhausted" | "unresolved_judgment";
export interface RetrievalIssue { url: string; tool: string; reason: string }
export interface ResearchCheck {
  by: Counsel; round: number; passed: boolean; filed: number; grounded: number;
  observedPages: number; fetches: number; gaps: string[]; retrievalIssues: RetrievalIssue[]; error?: string;
}
export interface ResearchBatch {
  contributions: Contribution[]; researchChecks: ResearchCheck[]; budgetExhausted?: boolean;
}
export interface Dossier extends ResearchBatch { claim: string; asOf: string; sources: Source[] }
export interface RoutingTurn { round: number; effort: Effort; route: Routing; sourceCount: number }
export interface ResearchOutcome {
  dossier: Dossier; route: Routing | null; history: RoutingTurn[]; researchRounds: number; stopReason: StopReason;
}

// Excluded quotations remain in the audit file, never in the moderator's evidence.
export function dossierForPrompt(dossier: Dossier) {
  return { claim: dossier.claim, asOf: dossier.asOf, sources: dossier.sources, researchChecks: dossier.researchChecks };
}

export async function runResearchLoop(options: {
  claim: string; asOf: string; maxResearchRounds: number;
  research: (gaps: Evidence["gaps"], round: number, dossier: Dossier) => Promise<ResearchBatch>;
  moderate: (dossier: Dossier, effort: Effort, round: number) => Promise<Routing>;
  onUpdate?: (dossier: Dossier, history: RoutingTurn[]) => Promise<void>;
}): Promise<ResearchOutcome> {
  if (!Number.isInteger(options.maxResearchRounds) || options.maxResearchRounds < 0 || options.maxResearchRounds > 5) {
    throw new Error("maxResearchRounds must be an integer between 0 and 5");
  }
  let dossier: Dossier = { claim: options.claim, asOf: options.asOf, sources: [], contributions: [], researchChecks: [] };
  const history: RoutingTurn[] = [];
  let route: Routing | null = null;
  let researchRounds = 0;
  let effort: Effort = "medium";
  const finish = (stopReason: StopReason): ResearchOutcome => ({ dossier, route, history, researchRounds, stopReason });
  const research = async (gaps: Evidence["gaps"], round: number) => {
    const batch = await options.research(gaps, round, dossier);
    const contributions = [...dossier.contributions, ...batch.contributions];
    dossier = { ...dossier, contributions, sources: unify(contributions),
      researchChecks: [...dossier.researchChecks, ...batch.researchChecks] };
    await options.onUpdate?.(dossier, history);
    return batch.budgetExhausted;
  };
  try {
    if (await research([], 0)) return finish("budget_exhausted");
    while (true) {
      route = validateRouting(await options.moderate(dossier, effort, researchRounds), dossier.sources);
      history.push({ round: researchRounds, effort, route, sourceCount: dossier.sources.length });
      await options.onUpdate?.(dossier, history);
      if (route.action === "escalate") {
        if (effort === "high") return finish("unresolved_judgment");
        effort = "high";
        continue;
      }
      if (route.action === "verify") return finish("sufficient");
      if (researchRounds >= options.maxResearchRounds) return finish("iteration_limit");
      researchRounds += 1;
      if (await research(route.evidence.gaps, researchRounds)) return finish("budget_exhausted");
      effort = "medium";
    }
  } catch (error) {
    if (error instanceof BudgetExceededError) return finish("budget_exhausted");
    throw error;
  }
}

export type ChallengedGap = Evidence["gaps"][number] & { by: Counsel };
export interface GapRuling { gap: number; material: boolean; reason: string }
export interface Adjudication {
  gaps: ChallengedGap[]; rulings: GapRuling[];
  // False when material gaps remained but no research round was left or budget ran out.
  researched: boolean;
}

// Only an evaluator disagreeing with an accepted sufficiency opens an adjudication.
export function challengedGaps(assessments: { by: Counsel; result: z.infer<typeof assessmentSchema> }[], outcome: ResearchOutcome): ChallengedGap[] {
  if (outcome.stopReason !== "sufficient" || outcome.route?.evidence.status !== "sufficient") return [];
  return assessments.filter((a) => a.result.evidence.status !== "sufficient")
    .flatMap((a) => a.result.evidence.gaps.map((gap) => ({ ...gap, by: a.by })));
}

// The moderator, not the challenger, decides whether a gap blocks a verdict.
// Material gaps get at most one extra research round, shared with the loop's limit.
export async function adjudicateChallenges(options: {
  outcome: ResearchOutcome; gaps: ChallengedGap[]; maxResearchRounds: number;
  rule: (dossier: Dossier, gaps: ChallengedGap[]) => Promise<GapRuling[]>;
  research: (gaps: Evidence["gaps"], round: number, dossier: Dossier) => Promise<ResearchBatch>;
  moderate: (dossier: Dossier, effort: Effort, round: number) => Promise<Routing>;
  onUpdate?: (dossier: Dossier, history: RoutingTurn[]) => Promise<void>;
}): Promise<{ outcome: ResearchOutcome; adjudication: Adjudication }> {
  const { outcome, gaps } = options;
  const rulings = await options.rule(outcome.dossier, gaps);
  const indexes = rulings.map((r) => r.gap).sort((a, b) => a - b);
  if (indexes.length !== gaps.length || indexes.some((index, i) => index !== i)) {
    throw new Error("Moderator must rule exactly once on every challenged gap");
  }
  const material = gaps.filter((_, i) => rulings.find((r) => r.gap === i)!.material);
  const adjudication: Adjudication = { gaps, rulings, researched: false };
  if (!material.length || outcome.researchRounds >= options.maxResearchRounds) return { outcome, adjudication };
  const round = outcome.researchRounds + 1;
  const batch = await options.research(material.map(({ aspect, whyItMatters, researchAction }) => ({ aspect, whyItMatters, researchAction })), round, outcome.dossier);
  const contributions = [...outcome.dossier.contributions, ...batch.contributions];
  const dossier: Dossier = { ...outcome.dossier, contributions, sources: unify(contributions),
    researchChecks: [...outcome.dossier.researchChecks, ...batch.researchChecks] };
  const history = [...outcome.history];
  await options.onUpdate?.(dossier, history);
  adjudication.researched = true;
  const next = (route: Routing | null, stopReason: StopReason): ResearchOutcome =>
    ({ dossier, route, history, researchRounds: round, stopReason });
  if (batch.budgetExhausted) return { outcome: next(outcome.route, "budget_exhausted"), adjudication };
  try {
    const route = validateRouting(await options.moderate(dossier, "medium", round), dossier.sources);
    history.push({ round, effort: "medium", route, sourceCount: dossier.sources.length });
    await options.onUpdate?.(dossier, history);
    const stopReason: StopReason = route.action === "verify" ? "sufficient" : route.action === "escalate" ? "unresolved_judgment" : "iteration_limit";
    return { outcome: next(route, stopReason), adjudication };
  } catch (error) {
    if (error instanceof BudgetExceededError) return { outcome: next(outcome.route, "budget_exhausted"), adjudication };
    throw error;
  }
}

// Preserve the submitted verdict for audit; an unsafe submission cannot become
// the effective result, even when it is syntactically valid JSON.
export function resolveAssessment(result: z.infer<typeof assessmentSchema>, outcome: ResearchOutcome) {
  const ids = [...result.sourceIds, ...result.criteria.flatMap((c) => c.sourceIds), ...evidenceCitations(result.evidence)];
  const citationsValid = validCitations(ids, outcome.dossier.sources);
  const sufficient = outcome.stopReason === "sufficient" && outcome.route?.evidence.status === "sufficient"
    && result.evidence.status === "sufficient" && result.sourceIds.length > 0 && citationsValid;
  return {
    validCitations: citationsValid,
    sufficiencyChallenged: outcome.route?.evidence.status === "sufficient" && result.evidence.status !== "sufficient",
    effectiveVerdict: sufficient ? result.verdict : "unverifiable" as const,
    abstentionRequired: !sufficient,
  };
}
