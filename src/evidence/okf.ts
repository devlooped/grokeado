import { parseDocument, stringify } from "yaml";
import { EvidenceDocumentSchema, type EvidenceDocument } from "./schema.ts";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export function parseEvidenceDocument(source: string): EvidenceDocument {
  const match = FRONTMATTER.exec(source);
  if (!match) throw new Error("Missing YAML frontmatter");

  const document = parseDocument(match[1]!, { uniqueKeys: true });
  if (document.errors.length) throw new Error(document.errors.map((error) => error.message).join("; "));
  return EvidenceDocumentSchema.parse(document.toJS());
}

export function serializeEvidenceDocument(document: EvidenceDocument, body = ""): string {
  const frontmatter = stringify(document, { lineWidth: 0 }).trimEnd();
  return `---\n${frontmatter}\n---\n${body.trimStart()}`;
}

export interface IndexedEvidence {
  path: string;
  document: EvidenceDocument;
}

export function createEvidenceIndex(entries: readonly IndexedEvidence[]): string {
  const lines = ["# Evidence", "", "Evidence files promoted for this case.", ""];
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
  const markedPages = new Set([...body.matchAll(/\[p\.(\d+)\]/gi)].map((match) => Number(match[1])));
  const escaped = body.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  const anchored = escaped.replace(/\[p\.(\d+)\]/gi, (_marker, page: string) => `<span id="p${page}" class="page">Page ${page}</span>`);
  const pages = document.type === "fragment" ? [document.page] : document.type === "evidence" ? document.pages : [];
  const missingAnchors = pages.filter((page) => !markedPages.has(page)).map((page) => `<span id="p${page}"></span>`).join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Evidence document</title><style>body{font:16px/1.6 system-ui,sans-serif;margin:2rem auto;max-width:70rem;padding:0 1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}.page{display:block;font-weight:700;margin:1.5rem 0 .5rem}</style><main>${missingAnchors}<pre>${anchored}</pre></main></html>`;
}
