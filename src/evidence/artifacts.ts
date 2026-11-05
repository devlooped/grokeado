import { sha256, type EvidenceFiles } from "./validate.ts";

export interface ArtifactStore {
  read(caseId: string): Promise<Map<string, Uint8Array>>;
  write(caseId: string, files: EvidenceFiles): Promise<void>;
}

export function normalizeArtifactBytes(path: string, content: Uint8Array | string): Uint8Array {
  if (!/^(?:instruction|evidence|discussion)\//.test(path) && path !== "case.jsonl" && path !== "case.json") throw new Error("Invalid case artifact namespace");
  if (path.includes("\\") || /[:\x00-\x1f]/.test(path) || path.split("/").some((part) => !part || part === "." || part === ".." || part === ".sha256")) throw new Error("Invalid case artifact path");
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("Case artifact exceeds 8 MiB");
  return bytes;
}

// Every new-format object is write-once, even through the generic writer.
export class MemoryArtifactStore implements ArtifactStore {
  private readonly cases = new Map<string, Map<string, Uint8Array>>();
  async read(caseId: string) { return new Map([...(this.cases.get(caseId) ?? [])].map(([path, bytes]) => [path, Uint8Array.from(bytes)])); }
  async write(caseId: string, files: EvidenceFiles) {
    const next = new Map(this.cases.get(caseId) ?? []);
    let total = 0;
    for (const [path, content] of files) {
      const bytes = normalizeArtifactBytes(path, content);
      total += bytes.byteLength;
      if (total > 25 * 1024 * 1024) throw new Error("Artifact batch exceeds 25 MiB");
      const previous = next.get(path);
      if (previous && sha256(previous) !== sha256(bytes)) throw new Error(`Immutable artifact conflict: ${path}`);
      next.set(path, Uint8Array.from(bytes));
    }
    this.cases.set(caseId, next);
  }
}
