import { z } from "zod";

const authors = ["base", "grok", "gemini", "claude", "chatgpt"] as const;

const common = {
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().min(1).max(20_000),
  sources: z.array(z.string().trim().min(1)).max(100),
  generated: z.object({
    by: z.enum(authors),
    at: z.iso.datetime(),
    modelId: z.string().trim().min(1).optional(),
    effort: z.string().trim().min(1).nullable().optional(),
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

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const SettledEvidenceSchema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().regex(/^E[1-9]\d*$/),
  title: z.string().min(1),
  language: z.string().min(2),
  sourceId: z.string().regex(/^src_[a-f0-9]{24}$/),
  url: z.url(),
  acquiredAt: z.iso.datetime(),
  rawHash: digest,
  bodyHash: digest,
  pages: z.array(z.number().int().positive()),
  extraction: z.object({ version: z.string(), hash: digest, tool: z.string(), confidence: z.number().min(0).max(1) }).strict(),
  translation: z.object({ version: z.string(), modelId: z.string(), fingerprint: z.string() }).strict(),
  admission: z.object({ vetoes: z.number().int().min(0).max(2), excluded: z.literal(false), reviewSeqs: z.array(z.number().int().positive()) }).strict(),
}).strict();
export type SettledEvidence = z.infer<typeof SettledEvidenceSchema>;

export const SettledManifestSchema = z.object({
  schemaVersion: z.literal(2),
  language: z.string().min(2),
  files: z.record(z.string(), digest),
  documents: z.array(z.object({
    id: z.string().regex(/^E[1-9]\d*$/), sourceId: z.string().regex(/^src_[a-f0-9]{24}$/), path: z.string(), hash: digest,
    blocks: z.array(z.object({ id: z.string().regex(/^p[1-9]\d*:b[1-9]\d*$/), page: z.number().int().positive(), offset: z.number().int().nonnegative(), length: z.number().int().nonnegative() }).strict()),
  }).strict()),
}).strict();
export type SettledManifest = z.infer<typeof SettledManifestSchema>;
