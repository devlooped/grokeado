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
