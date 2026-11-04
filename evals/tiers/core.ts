import { z } from "zod";
import { courtModel, DEFAULT_MODELS, type CourtModel, type ModelConfig } from "../../src/court/models.ts";
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

// Gateway tool errors arrive as plain objects such as { error, statusCode, message };
// String() would reduce them to "[object Object]" and hide the cause from the moderator.
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error !== "object" || error === null) return String(error);
  const { error: kind, statusCode, message } = error as { error?: unknown; statusCode?: unknown; message?: unknown };
  const parts = [
    typeof kind === "string" ? kind : undefined,
    typeof statusCode === "number" ? "HTTP " + statusCode : undefined,
    typeof message === "string" && message ? message : undefined,
  ].filter((part) => part !== undefined);
  if (parts.length) return parts.join(" · ");
  try { return JSON.stringify(error) ?? String(error); } catch { return String(error); }
}

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

// Tier model IDs come from the model settings (defaults in src/court/models.ts,
// overridable from /admin); each experiment sets the effort.
export function modelFor(by: Counsel, tier: Tier, effort: "medium" | "high" = tier === "fact" ? "medium" : "high", models: ModelConfig = DEFAULT_MODELS): CourtModel {
  return courtModel(models[`tier.${by}.${tier}`].id, effort);
}

// The tier evaluator (moderator) runs at its configured effort; an escalation
// turn runs the same model at high effort.
export function moderatorModel(effort: "medium" | "high" = "medium", base: CourtModel = DEFAULT_MODELS["tier.evaluator"]): CourtModel {
  return effort === "high" ? courtModel(base.id, "high") : base;
}

// "openai/gpt-6.1-terra@medium" → the model at that effort; without "@", the provider default.
export function parseModerator(spec: string): CourtModel {
  const [id, effort, extra] = spec.trim().split("@");
  if (!id || !/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/i.test(id) || extra !== undefined || (effort !== undefined && !/^[a-z]{1,16}$/.test(effort))) {
    throw new Error("Moderador no válido: " + spec + ". Usá proveedor/modelo o proveedor/modelo@esfuerzo.");
  }
  return courtModel(id, effort || null);
}

export const EVALUATORS = COUNSEL;
