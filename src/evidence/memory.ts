import { normalizeEvidenceBytes, sha256, type EvidenceFiles } from "./validate.ts";

const BATCH_LIMIT = 25 * 1024 * 1024;

export class MemoryEvidenceStore {
  private readonly trees = new Map<string, Map<string, Uint8Array>>();

  async read(caseId: string): Promise<Map<string, Uint8Array>> {
    const stored = this.trees.get(caseId) ?? new Map<string, Uint8Array>();
    const files = new Map<string, Uint8Array>();
    for (const [path, bytes] of stored) {
      const copy = Uint8Array.from(bytes);
      if (sha256(copy) !== sha256(bytes)) throw new Error(`Evidence hash verification failed: ${path}`);
      files.set(path, copy);
    }
    return files;
  }

  async write(caseId: string, files: EvidenceFiles): Promise<void> {
    let batch = 0;
    const next = new Map(this.trees.get(caseId) ?? []);
    for (const [path, content] of files) {
      const bytes = normalizeEvidenceBytes(path, content);
      batch += bytes.byteLength;
      if (batch > BATCH_LIMIT) throw new Error("Evidence upload exceeds 25 MiB.");
      const copy = Uint8Array.from(bytes);
      if (sha256(copy) !== sha256(bytes)) throw new Error(`Evidence hash verification failed: ${path}`);
      next.set(path, copy);
    }
    this.trees.set(caseId, next);
  }
}
