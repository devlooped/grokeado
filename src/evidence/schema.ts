import { z } from "zod";

const authors = ["base", "grok", "gemini", "claude", "chatgpt"] as const;

const common = {
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().min(1).max(20_000),
  sources: z.array(z.string().trim().min(1)).max(100),
  generated: z.object({
    by: z.enum(authors),
    at: z.iso.datetime(),
  }).strict(),
};

const evidence = z.object({
  ...common,
  type: z.literal("evidence"),
  pages: z.array(z.number().int().positive()).max(10_000),
  extraction: z.object({
    tool: z.string().trim().min(1).max(120),
    confidence: z.number().min(0).max(1),
  }).strict(),
  tokens: z.number().int().nonnegative(),
}).strict();

const fragment = z.object({
  ...common,
  type: z.literal("fragment"),
  page: z.number().int().positive(),
  reprocess_of: z.string().trim().min(1).optional(),
}).strict();

const argument = z.object({
  ...common,
  type: z.literal("argument"),
  stage: z.enum(["exposicion", "objecion", "conclusion"]),
  supports: z.array(z.string().trim().min(1)).max(100),
  refutes: z.array(z.string().trim().min(1)).max(100),
}).strict();

export const EvidenceDocumentSchema = z.discriminatedUnion("type", [evidence, fragment, argument]);
export type EvidenceDocument = z.infer<typeof EvidenceDocumentSchema>;
export type EvidenceAuthor = EvidenceDocument["generated"]["by"];
export type EvidenceSeat = Exclude<EvidenceAuthor, "base">;

export const EvidenceStageSchema = z.enum(["exposicion", "objecion", "conclusion"]);
export type EvidenceStage = z.infer<typeof EvidenceStageSchema>;
