import MarkdownIt from "markdown-it";
import { stringify } from "yaml";
import { COUNSEL, project, type RecordedEvent } from "../domain/court.ts";
import { boundBlocks, mapLimit, type SourceService } from "../instruction/sources.ts";
import type { ArtifactStore } from "./artifacts.ts";
import { parseYamlFrontmatter } from "./okf.ts";
import { SettledEvidenceSchema, SettledManifestSchema, type SettledEvidence, type SettledManifest } from "./schema.ts";
import { sha256 } from "./validate.ts";
import { z } from "zod";

const decode = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

export function parseSettledDocument(source: string): { metadata: SettledEvidence; body: string } {
  const parsed = parseYamlFrontmatter(source);
  const metadata = SettledEvidenceSchema.parse(parsed.metadata);
  if (sha256(parsed.body) !== metadata.bodyHash) throw new Error("Settled body hash mismatch");
  return { metadata, body: parsed.body };
}

export type SettledCorpus = { manifest: SettledManifest; manifestHash: string; index: string; question: string; documents: Map<string, { metadata: SettledEvidence; body: string }> };

function validateAnchor(document: SettledManifest["documents"][number], anchor: string): boolean {
  if (!anchor) return true;
  if (/^p[1-9]\d*$/.test(anchor)) return document.blocks.some((block) => `p${block.page}` === anchor);
  return document.blocks.some((block) => block.id === anchor.replace("-b", ":b"));
}

function validateDependencies(manifest: SettledManifest, documents: SettledCorpus["documents"]): void {
  const markdown = new MarkdownIt({ html: false, linkify: false });
  for (const [id, source] of documents) {
    const stack = [...markdown.parse(source.body, {})];
    while (stack.length) {
      const token = stack.pop()!;
      if (token.children) stack.push(...token.children);
      const href = token.attrGet(token.type === "image" ? "src" : "href");
      if (typeof href !== "string" || !href || /^https?:\/\//i.test(href)) continue; // References only; never retrieved by corpus tools.
      let url: URL;
      try { url = new URL(href, `https://corpus.invalid/evidence/${id}.md`); } catch { throw new Error("Invalid settled dependency"); }
      const path = decodeURIComponent(url.pathname).replace(/^\//, "");
      const target = manifest.documents.find((document) => document.path === path);
      if (url.origin !== "https://corpus.invalid" || !target || !validateAnchor(target, decodeURIComponent(url.hash.slice(1)))) throw new Error("Settled link leaves admitted corpus or references an unknown section");
    }
  }
}

// Host-only promotion: no downloader or extractor is reachable here. Admitted
// sources, read in their original language until now, are translated here.
export async function settleEvidence(caseId: string, language: string, events: readonly RecordedEvent[], sources: Pick<SourceService, "translated">, artifacts: ArtifactStore): Promise<{ type: "evidence_settled"; schemaVersion: 2; manifestHash: string }> {
  const view = project(events);
  const files = new Map<string, string>();
  const documents: SettledManifest["documents"] = [];
  const parsed = new Map<string, { metadata: SettledEvidence; body: string }>();
  const index: string[] = [];
  const admitted = [...view.sources.values()].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))).filter((source) => {
    if (source.excluded === undefined) throw new Error("Source admission has not been decided");
    if (source.excluded) return false;
    if (!source.sourceId) throw new Error("Admitted source has no canonical identity");
    return true;
  });
  const translations = await mapLimit(admitted, 3, (source) => sources.translated(source.sourceId!));
  const stored = await artifacts.read(caseId);
  for (const [position, source] of admitted.entries()) {
    const canonical = translations[position]!;
    if (canonical.language !== language) throw new Error("Admitted source is not in the case language");
    const bytes = stored.get(canonical.document.path);
    if (!bytes || sha256(bytes) !== canonical.document.hash) throw new Error("Admitted source artifact missing or changed");
    const body = decode(bytes);
    const vetoes = COUNSEL.filter((seat) => source.votes[seat]?.veto).length;
    const metadata = SettledEvidenceSchema.parse({
      schemaVersion: 2, id: source.id, title: canonical.document.title, language, sourceId: canonical.sourceId,
      url: canonical.acquisition.finalUrl, acquiredAt: canonical.acquisition.at, rawHash: canonical.acquisition.rawHash, bodyHash: sha256(body),
      pages: [...new Set(canonical.document.blocks.map((block) => block.page))],
      extraction: { version: canonical.extraction.version, hash: canonical.extraction.hash, tool: canonical.extraction.tool, confidence: canonical.extraction.confidence },
      translation: canonical.translation,
      admission: { vetoes, excluded: false, reviewSeqs: events.filter((event) => event.type === "source_review_vote" && event.sourceId === source.id).map((event) => event.seq) },
    });
    const path = `evidence/${source.id}.md`;
    const content = `---\n${stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---\n${body}`;
    files.set(path, content);
    documents.push({ id: source.id, sourceId: canonical.sourceId, path, hash: sha256(content), blocks: canonical.document.blocks });
    parsed.set(source.id, { metadata, body });
    const title = canonical.document.title.replace(/[\\[\]()*_`<>]/g, "\\$&").replace(/[\r\n]/g, " ");
    index.push(`- [${source.id} — ${title}](${source.id}.md)`);
  }
  files.set("evidence/index.md", index.join("\n") + (index.length ? "\n" : ""));
  files.set("evidence/question.json", JSON.stringify({ schemaVersion: 2, language, claims: view.claims.map(({ id, text, quote }) => ({ id, text, quote })) }));
  const manifest = SettledManifestSchema.parse({ schemaVersion: 2, language, documents, files: Object.fromEntries([...files].map(([path, value]) => [path, sha256(value)])) });
  validateDependencies(manifest, parsed);
  await artifacts.write(caseId, files);
  const serialized = JSON.stringify(manifest);
  // Publish the manifest only after every immutable dependency exists and hashes match.
  const written = await artifacts.read(caseId);
  for (const [path, hash] of Object.entries(manifest.files)) if (!written.has(path) || sha256(written.get(path)!) !== hash) throw new Error("Settlement publication incomplete");
  await artifacts.write(caseId, new Map([["evidence/manifest.json", serialized]]));
  return { type: "evidence_settled", schemaVersion: 2, manifestHash: sha256(serialized) };
}

export async function loadSettledCorpus(caseId: string, events: readonly RecordedEvent[], artifacts: ArtifactStore): Promise<SettledCorpus> {
  const settled = events.find((event) => event.type === "evidence_settled");
  if (settled?.type !== "evidence_settled") throw new Error("Evidence has not been committed as settled");
  const files = await artifacts.read(caseId);
  const bytes = files.get("evidence/manifest.json");
  if (!bytes || sha256(bytes) !== settled.manifestHash) throw new Error("Settled manifest missing or changed");
  const manifest = SettledManifestSchema.parse(JSON.parse(decode(bytes)));
  const expectedPaths = new Set(["evidence/index.md", "evidence/question.json", ...manifest.documents.map((document) => document.path)]);
  if (expectedPaths.size !== manifest.documents.length + 2 || Object.keys(manifest.files).length !== expectedPaths.size || Object.keys(manifest.files).some((path) => !expectedPaths.has(path))) throw new Error("Invalid settled dependency closure");
  for (const [path, hash] of Object.entries(manifest.files)) if (!files.has(path) || sha256(files.get(path)!) !== hash) throw new Error("Settled artifact missing or changed");
  const documents: SettledCorpus["documents"] = new Map();
  for (const document of manifest.documents) {
    if (document.path !== `evidence/${document.id}.md` || document.hash !== manifest.files[document.path] || documents.has(document.id)) throw new Error("Invalid settled document mapping");
    const source = parseSettledDocument(decode(files.get(document.path)!));
    if (source.metadata.id !== document.id || source.metadata.sourceId !== document.sourceId || source.metadata.language !== manifest.language) throw new Error("Settled provenance mismatch");
    for (const block of document.blocks) if (block.offset + block.length > source.body.length || !source.body.slice(0, block.offset).endsWith(`[${block.id}]\n\n`)) throw new Error("Settled block mapping mismatch");
    documents.set(document.id, source);
  }
  validateDependencies(manifest, documents);
  return { manifest, manifestHash: settled.manifestHash, index: decode(files.get("evidence/index.md")!), question: decode(files.get("evidence/question.json")!), documents };
}

export type EvidenceReadInput = { id: string; page?: number; blockIds?: string[]; maxChars?: number; cursor?: { block: number; offset: number } };
export const EvidenceReadSchema = z.object({ id: z.string().regex(/^E[1-9]\d*$/), page: z.number().int().positive().optional(), blockIds: z.array(z.string().regex(/^p[1-9]\d*:b[1-9]\d*$/)).min(1).max(100).optional(), maxChars: z.number().int().min(1).max(20_000).optional(), cursor: z.object({ block: z.number().int().nonnegative(), offset: z.number().int().nonnegative() }).strict().optional() }).strict();

export function readEvidence(corpus: SettledCorpus, input: EvidenceReadInput) {
  input = EvidenceReadSchema.parse(input);
  const document = corpus.manifest.documents.find((entry) => entry.id === input.id);
  const source = corpus.documents.get(input.id);
  if (!document || !source) throw new Error("Evidence ID is not admitted");
  let blocks = document.blocks;
  if (input.page !== undefined) {
    if (!blocks.some((block) => block.page === input.page)) throw new Error("Unknown evidence page");
    blocks = blocks.filter((block) => block.page === input.page);
  }
  if (input.blockIds) {
    if (!input.blockIds.length || input.blockIds.some((id) => !blocks.some((block) => block.id === id))) throw new Error("Unknown evidence block");
    blocks = blocks.filter((block) => input.blockIds!.includes(block.id));
  }
  return { id: input.id, language: corpus.manifest.language, title: source.metadata.title, ...boundBlocks(blocks.map((block) => ({ id: block.id, page: block.page, text: source.body.slice(block.offset, block.offset + block.length) })), input.maxChars, input.cursor) };
}

export function validateCorpusCitations(corpus: SettledCorpus, values: readonly string[]): void {
  for (const value of values) {
    const match = /^(?:\/evidence\/)?(E[1-9]\d*)(?:\.md)?(?:#(.+))?$/.exec(value);
    const document = match && corpus.manifest.documents.find((entry) => entry.id === match[1]);
    if (!document || !validateAnchor(document, match?.[2] ?? "")) throw new Error("Citation is not in the settled corpus");
  }
}
