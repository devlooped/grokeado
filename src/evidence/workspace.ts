import { parseEvidenceDocument } from "./okf.ts";
import type { EvidenceAuthor, EvidenceSeat, EvidenceStage } from "./schema.ts";
import { isEvidenceCatalog, sha256 } from "./validate.ts";

const SEATS: readonly EvidenceSeat[] = ["grok", "gemini", "claude", "chatgpt"];

export function writablePrefixes(seat: EvidenceSeat): readonly string[] {
  return [`evidence/${seat}/`, "scratch/"];
}

export function isWritablePath(path: string, seat: EvidenceSeat): boolean {
  return writablePrefixes(seat).some((prefix) => path.startsWith(prefix));
}

export function isVisibleInStage(path: string, seat: EvidenceSeat, stage: EvidenceStage): boolean {
  if (path === "scratch" || path.startsWith("scratch/")) return true;
  if (!path.startsWith("evidence/")) return false;
  const namespace = path.split("/")[1] ?? "";
  if (namespace === "base" || namespace === seat) return true;
  if (stage === "exposicion") return false;
  if (stage === "objecion") return SEATS.includes(namespace as EvidenceSeat);
  return true;
}

export function assembleWorkspace<T>(files: ReadonlyMap<string, T>, seat: EvidenceSeat, stage: EvidenceStage): Map<string, T> {
  const workspace = new Map<string, T>();
  for (const [path, value] of files) {
    if (isVisibleInStage(path, seat, stage)) workspace.set(path, value);
  }
  return workspace;
}

export function citationAuthors(seat: EvidenceSeat, stage: EvidenceStage): EvidenceAuthor[] {
  return stage === "exposicion" ? ["base", seat] : ["base", ...SEATS];
}

export function readOnlyHashesFor(files: ReadonlyMap<string, Uint8Array | string>): Record<string, string> {
  return Object.fromEntries([...files].map(([path, value]) => [path, sha256(value)]));
}

function asText(value: Uint8Array | string): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

export function citationsFor(files: ReadonlyMap<string, Uint8Array | string>, authors: readonly EvidenceAuthor[]): string[] {
  const citations: string[] = [];
  for (const [path, content] of files) {
    if (!path.endsWith(".md") || isEvidenceCatalog(path)) continue;
    const namespace = path.split("/")[1] as EvidenceAuthor;
    if (!authors.includes(namespace)) continue;
    const document = parseEvidenceDocument(asText(content));
    const pages = document.type === "fragment" ? [document.page] : document.type === "evidence" ? document.pages : [];
    for (const page of pages) citations.push(`/${path}#p${page}`);
  }
  return citations;
}

export function workspaceIndex(files: ReadonlyMap<string, Uint8Array | string>): string {
  return [...files].filter(([path]) => path.endsWith("/index.md")).map(([, content]) => asText(content)).join("\n");
}
