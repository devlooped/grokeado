import { z } from "zod";
import type { CourtModel } from "../../src/court/models.ts";
import { COUNSEL, type Counsel } from "../../src/domain/court.ts";

export const tierSchema = z.enum(["fact", "comparison", "assessment"]);
export type Tier = z.infer<typeof tierSchema>;
export const verdictSchema = z.enum(["true", "false", "unverifiable"]);
export const evidenceStatusSchema = z.enum(["sufficient", "insufficient", "uncertain"]);
export const CHECKS = ["coverage", "fit", "support", "authority", "contradictions", "access"] as const;
const evidenceCheckSchema = z.object({
  status: z.enum(["satisfied", "missing", "uncertain"]),
  reason: z.string().min(10), sourceIds: z.array(z.string()),
});
export const evidenceSchema = z.object({
  status: evidenceStatusSchema,
  covered: z.array(z.string().min(3)),
  checks: z.object({
    coverage: evidenceCheckSchema, fit: evidenceCheckSchema, support: evidenceCheckSchema,
    authority: evidenceCheckSchema, contradictions: evidenceCheckSchema, access: evidenceCheckSchema,
  }),
  gaps: z.array(z.object({
    aspect: z.string().min(3), whyItMatters: z.string().min(10), researchAction: z.string().min(10),
  })).max(6),
}).superRefine((evidence, ctx) => {
  if (evidence.status === "sufficient" && (evidence.gaps.length || CHECKS.some((key) => evidence.checks[key].status !== "satisfied"))) {
    ctx.addIssue({ code: "custom", message: "Sufficient evidence requires all checks satisfied and no material gaps" });
  }
  if (evidence.status !== "sufficient" && !evidence.gaps.length) {
    ctx.addIssue({ code: "custom", message: "Insufficient or uncertain evidence requires actionable gaps" });
  }
  if (evidence.status !== "sufficient" && CHECKS.every((key) => evidence.checks[key].status === "satisfied")) {
    ctx.addIssue({ code: "custom", message: "Insufficient or uncertain evidence requires an unresolved check" });
  }
});
export type Evidence = z.infer<typeof evidenceSchema>;
export const researchSchema = z.object({
  supportingSearch: z.string().min(10),
  opposingSearch: z.string().min(10),
  evidence: z.array(z.object({
    url: z.url().regex(/^https?:\/\//), title: z.string().min(3), quote: z.string().min(15).max(900),
    stance: z.enum(["supports", "opposes", "context"]), relevance: z.string(),
  })).max(6),
  gaps: z.array(z.string()),
});
export const routingSchema = z.object({
  tier: tierSchema, action: z.enum(["verify", "research_more", "escalate"]),
  reason: z.string().min(20), sourceIds: z.array(z.string()), evidence: evidenceSchema,
  escalationReason: z.enum(["substantive_judgment"]).nullable(),
}).superRefine((route, ctx) => {
  if ((route.action === "escalate") !== (route.escalationReason === "substantive_judgment")) {
    ctx.addIssue({ code: "custom", message: "Escalation requires a substantive judgment reason" });
  }
  if (route.action !== "escalate" && (route.action === "verify") !== (route.evidence.status === "sufficient")) {
    ctx.addIssue({ code: "custom", message: "Verify requires sufficient evidence; otherwise request research" });
  }
});
export type Routing = z.infer<typeof routingSchema>;
export const assessmentSchema = z.object({
  verdict: verdictSchema, evidence: evidenceSchema,
  rationale: z.string().min(30), sourceIds: z.array(z.string()),
  calculations: z.array(z.object({ expression: z.string(), result: z.number(), unit: z.string() })),
  criteria: z.array(z.object({ criterion: z.string(), assessment: z.string(), sourceIds: z.array(z.string()) })),
  limitations: z.array(z.string()),
});
export const gapRulingSchema = z.object({
  rulings: z.array(z.object({
    gap: z.number().int().min(0), material: z.boolean(), reason: z.string().min(20),
  })),
});
export const gradingSchema = z.object({
  grades: z.array(z.object({
    candidate: z.string(),
    groundedFacts: z.boolean(), comparableOrApplicableCriteria: z.boolean(),
    correctReasoning: z.boolean(), calibratedConclusion: z.boolean(),
    explanation: z.string().min(20),
  })),
});

export interface Observation { url: string; text: string; tool: string }
export type Contribution = z.infer<typeof researchSchema>["evidence"][number] & {
  by: Counsel; grounded: boolean; retrieval: "full_document" | "search_excerpt" | null;
};
export interface Source { id: string; url: string; contributions: Contribution[] }

export function canonicalUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP(S) sources are accepted");
  url.hash = "";
  return url.href;
}

function normalized(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// A URL match alone does not establish that a quotation was retrieved.
export function groundResearch(by: Counsel, research: z.infer<typeof researchSchema>, observations: Observation[]): Contribution[] {
  return research.evidence.map((e) => {
    const matches = observations.filter((o) => canonicalUrl(o.url) === canonicalUrl(e.url)
      && normalized(o.text).includes(normalized(e.quote)));
    return { ...e, by, grounded: matches.length > 0,
      retrieval: matches.some((o) => o.tool === "web_fetch") ? "full_document" : matches.length ? "search_excerpt" : null };
  });
}

export function unify(contributions: Contribution[]): Source[] {
  const sources = new Map<string, Source>();
  for (const contribution of contributions.filter((c) => c.grounded)) {
    const url = canonicalUrl(contribution.url);
    let source = sources.get(url);
    if (!source) { source = { id: "S" + (sources.size + 1), url, contributions: [] }; sources.set(url, source); }
    source.contributions.push(contribution);
  }
  return [...sources.values()];
}

export function validCitations(ids: string[], sources: Source[]): boolean {
  return ids.every((id) => sources.some((s) => s.id === id));
}

export function evidenceCitations(evidence: Evidence): string[] {
  return CHECKS.flatMap((key) => evidence.checks[key].sourceIds);
}

export function validateRouting(route: Routing, sources: Source[]): Routing {
  routingSchema.parse(route);
  if (!validCitations([...route.sourceIds, ...evidenceCitations(route.evidence)], sources)) {
    throw new Error("Moderator cited an unknown source");
  }
  if (route.evidence.status === "sufficient" && (!sources.length || !route.sourceIds.length)) {
    throw new Error("Sufficient evidence requires retrieved sources and citations");
  }
  return route;
}

export function modelFor(by: Counsel, tier: Tier, effort: "medium" | "high" = tier === "fact" ? "medium" : "high"): CourtModel {
  switch (by) {
    // The live Gateway catalog currently offers one general-purpose Grok.
    // Its inexpensive research lane lowers effort rather than claiming a mini model.
    case "grok": return { id: "spacexai/grok-4.7", providerOptions: { xai: { reasoningEffort: effort } } };
    case "gemini": return { id: tier === "assessment" ? "google/gemini-4-argon" : "google/gemini-3.8-flash", providerOptions: { google: { thinkingConfig: { thinkingLevel: effort } } } };
    case "claude": return { id: tier === "fact" ? "anthropic/claude-haiku-5.5" : tier === "comparison" ? "anthropic/claude-sonnet-5.5" : "anthropic/claude-opus-5.5", providerOptions: { anthropic: { effort } } };
    case "chatgpt": return { id: tier === "fact" ? "openai/gpt-6-luna" : tier === "comparison" ? "openai/gpt-6.1-terra" : "openai/gpt-6.1-sol", providerOptions: { openai: { reasoningEffort: effort } } };
  }
}

export const EVALUATORS = COUNSEL;
