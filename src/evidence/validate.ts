import { createHash } from "node:crypto";
import { posix } from "node:path";
import { parseEvidenceDocument } from "./okf.ts";
import type { EvidenceSeat } from "./schema.ts";

export type EvidenceFiles = ReadonlyMap<string, Uint8Array | string>;

const decoder = new TextDecoder("utf-8", { fatal: true });

function text(value: Uint8Array | string): string {
  return typeof value === "string" ? value : decoder.decode(value);
}

export function isEvidenceCatalog(path: string): boolean {
  const parts = path.split("/");
  return parts.length === 3 && parts[0] === "evidence" && (parts[2] === "index.md" || parts[2] === "timeline.md" || parts[2] === "entities.md");
}

export function normalizeEvidenceBytes(path: string, content: Uint8Array | string): Uint8Array {
  if (!safePath(path) || !path.startsWith("evidence/")) throw new Error(`Invalid evidence path: ${path}`);
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error(`Evidence file exceeds 8 MiB: ${path}`);
  return bytes;
}

function safePath(path: string): boolean {
  return path.length > 0 && !path.includes("\\") && !path.includes("\0") &&
    !path.startsWith("/") && !/^[a-zA-Z]:/.test(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function isResolvableSource(source: string, files: EvidenceFiles): boolean {
  try {
    const url = new URL(source);
    if (url.protocol === "https:" || url.protocol === "http:") return true;
  } catch {
    // Local source references are resolved against the uploaded workspace below.
  }
  const path = source.replace(/^\/+/, "").split("#", 1)[0]!;
  return safePath(path) && files.has(path);
}

function internalLinks(source: string): string[] {
  return [...source.matchAll(/(?:\[[^\]]*\]\(|!\[[^\]]*\]\(|<)(\/?evidence\/[^)\s>]+)(?:\)|>)/g)].map((match) => match[1]!);
}

function targetPath(path: string, link: string): string {
  const withoutAnchor = link.split("#", 1)[0]!;
  if (!withoutAnchor) return path;
  return posix.normalize(withoutAnchor.replace(/^\/+/, ""));
}

export function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function validateEvidenceTree(files: EvidenceFiles): string[] {
  const errors: string[] = [];

  for (const [path, content] of files) {
    if (!safePath(path) || !path.startsWith("evidence/")) {
      errors.push(`${path}: path is outside evidence/`);
      continue;
    }
    if (!path.endsWith(".md") || isEvidenceCatalog(path)) continue;
    try {
      const document = parseEvidenceDocument(text(content));
      const namespace = path.split("/")[1];
      if (namespace !== document.generated.by) errors.push(`${path}: author does not match evidence namespace`);
      for (const source of document.sources) {
        if (!isResolvableSource(source, files)) errors.push(`${path}: source cannot be resolved: ${source}`);
      }
      if (document.type === "fragment" && document.reprocess_of && !isResolvableSource(document.reprocess_of, files)) {
        errors.push(`${path}: reprocess_of cannot be resolved: ${document.reprocess_of}`);
      }
    } catch (error) {
      errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const [path, content] of files) {
    if (!path.startsWith("evidence/") || !path.endsWith(".md")) continue;
    let source: string;
    try {
      source = text(content);
    } catch {
      continue;
    }
    for (const link of internalLinks(source)) {
      const target = targetPath(path, link);
      if (!files.has(target)) errors.push(`${path}: link target is missing: ${link}`);
      const author = target.split("/")[1] as EvidenceSeat | undefined;
      if (author && !["base", "grok", "gemini", "claude", "chatgpt"].includes(author)) {
        errors.push(`${path}: link leaves a recognized evidence namespace: ${link}`);
      }
    }
  }
  return errors;
}

export function validatePromotedFiles(
  seat: EvidenceSeat,
  original: EvidenceFiles,
  promoted: EvidenceFiles
): string[] {
  const errors: string[] = [];
  const prefix = `evidence/${seat}/`;

  let totalSize = 0;
  for (const [path, content] of promoted) {
    if (!safePath(path) || !path.startsWith(prefix)) {
      errors.push(`${path}: writes must remain in ${prefix}`);
    }
    const size = typeof content === "string" ? new TextEncoder().encode(content).byteLength : content.byteLength;
    if (size > 8 * 1024 * 1024) errors.push("Promoted files must not exceed 8 MiB each");
    totalSize += size;
  }
  if (totalSize > 25 * 1024 * 1024) errors.push("A promotion must not exceed 25 MiB total");
  const combined = new Map(original);
  for (const [path, content] of promoted) {
    if (original.has(path) && sha256(original.get(path)!) !== sha256(content)) errors.push(`${path}: existing evidence is immutable`);
    combined.set(path, content);
  }
  errors.push(...validateEvidenceTree(combined));
  return errors;
}
