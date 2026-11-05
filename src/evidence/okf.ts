import { parseDocument, stringify } from "yaml";
import { renderEvidenceMarkdown } from "./markdown.ts";
import { EvidenceDocumentSchema, type EvidenceDocument } from "./schema.ts";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export function parseYamlFrontmatter(source: string): { metadata: unknown; body: string } {
  const match = FRONTMATTER.exec(source);
  if (!match) throw new Error("Missing YAML frontmatter");

  const document = parseDocument(match[1]!, { uniqueKeys: true });
  if (document.errors.length) throw new Error(document.errors.map((error) => error.message).join("; "));
  return { metadata: document.toJS(), body: source.slice(match[0].length) };
}

export function parseEvidenceDocument(source: string): EvidenceDocument {
  return EvidenceDocumentSchema.parse(parseYamlFrontmatter(source).metadata);
}

export function serializeEvidenceDocument(document: EvidenceDocument, body = ""): string {
  const frontmatter = stringify(document, { lineWidth: 0 }).trimEnd();
  return `---\n${frontmatter}\n---\n${body.trimStart()}`;
}

// Stamp trusted execution metadata on newly promoted analyst documents.
export function annotateEvidenceDocuments(files: Map<string, Uint8Array>, modelId: string, effort: string | null): void {
  for (const [path, bytes] of files) {
    if (!path.endsWith(".md") || /^evidence\/[^/]+\/(?:index|timeline|entities)\.md$/.test(path)) continue;
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const document = parseEvidenceDocument(source);
    const body = source.replace(FRONTMATTER, "");
    files.set(path, new TextEncoder().encode(serializeEvidenceDocument({ ...document, generated: { ...document.generated, modelId, effort } }) + body));
  }
}

export interface IndexedEvidence {
  path: string;
  document: EvidenceDocument;
}

export function createEvidenceIndex(entries: readonly IndexedEvidence[]): string {
  const lines = ["# Evidencia", "", "Archivos de evidencia promovidos para este caso.", ""];
  for (const { path, document } of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    const tokens = document.type === "evidence" ? ` (${document.tokens} tokens)` : "";
    lines.push(`- [${document.title}](/${path}) — ${document.description}${tokens}`);
  }
  return lines.join("\n") + "\n";
}

export function baseExcerptFor(files: ReadonlyMap<string, Uint8Array | string>, reprocessOf: string): string {
  const [rawPath, anchor] = reprocessOf.replace(/^\/+/, "").split("#", 2);
  const file = rawPath ? files.get(rawPath) : undefined;
  if (!file) return "";
  const source = typeof file === "string" ? file : new TextDecoder().decode(file);
  const body = source.replace(FRONTMATTER, "");
  const page = /^p(\d+)$/i.exec(anchor ?? "")?.[1];
  return page ? excerptForPage(body, Number(page)) : body.trim();
}

export function excerptForPage(body: string, page: number): string {
  const parts = body.split(/\[p\.(\d+)\]/i);
  if (parts.length === 1) return body.trim();
  for (let index = 1; index < parts.length; index += 2) {
    if (Number(parts[index]) === page) return (parts[index + 1] ?? "").trim();
  }
  return "";
}

export function evidencePageLink(path: string, page: number): string {
  return `/${path}#p${page}`;
}

export function renderEvidenceHtml(source: string): string {
  const document = parseEvidenceDocument(source);
  const body = source.replace(FRONTMATTER, "").trim();
  const pages = document.type === "fragment" ? [document.page] : document.type === "evidence" ? document.pages : [];
  return renderEvidenceMarkdown({ title: document.title, body, pages, language: "es-AR" });
}
