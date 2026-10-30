import { get, list, put } from "@vercel/blob";
import { normalizeEvidenceBytes, sha256, type EvidenceFiles } from "./validate.ts";

const ROOT = (caseId: string) => `cases/${encodeURIComponent(caseId)}/evidence/`;
const HASHES = ".sha256/";

class EvidenceConsistencyError extends Error {}

function requireToken(): string {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error("BLOB_READ_WRITE_TOKEN is not configured");
  return token;
}

async function readEvidenceTreeOnce(caseId: string): Promise<Map<string, Uint8Array>> {
  const token = requireToken();
  const prefix = ROOT(caseId);
  const files = new Map<string, Uint8Array>();
  const hashes = new Map<string, string>();
  let cursor: string | undefined;

  do {
    const result = await list({ prefix, cursor, limit: 1000, token, mode: "expanded" });
    for (const blob of result.blobs) {
      const path = blob.pathname.slice(prefix.length);
      if (!path) continue;
      const result = await get(blob.pathname, { access: "private", token });
      if (!result) throw new Error(`Evidence blob disappeared while loading: ${blob.pathname}`);
      const bytes = new Uint8Array(await new Response(result.stream).arrayBuffer());
      if (path.startsWith(HASHES)) {
        const entry = JSON.parse(new TextDecoder().decode(bytes)) as { path: string; sha256: string };
        hashes.set(entry.path, entry.sha256);
      } else {
        files.set(path, bytes);
      }
    }
    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);

  for (const path of files.keys()) {
    if (!hashes.has(path)) throw new EvidenceConsistencyError(`Evidence hash is not available yet: ${path}`);
  }
  for (const [path, digest] of hashes) {
    const value = files.get(path);
    if (!value || sha256(value) !== digest) throw new EvidenceConsistencyError(`Evidence hash verification failed: ${path}`);
  }
  return files;
}

export async function readEvidenceTree(caseId: string): Promise<Map<string, Uint8Array>> {
  let consistencyError: EvidenceConsistencyError | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await readEvidenceTreeOnce(caseId);
    } catch (error) {
      if (!(error instanceof EvidenceConsistencyError)) throw error;
      consistencyError = error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  throw consistencyError ?? new Error("Could not read the evidence bundle.");
}

export async function writeEvidenceTree(caseId: string, files: EvidenceFiles): Promise<void> {
  const token = requireToken();
  const prefix = ROOT(caseId);
  let totalSize = 0;
  for (const [path, content] of files) {
    const bytes = normalizeEvidenceBytes(path, content);
    totalSize += bytes.byteLength;
    if (totalSize > 25 * 1024 * 1024) throw new Error("Evidence upload exceeds 25 MiB.");
    const pathname = prefix + path.slice("evidence/".length);
    const digest = sha256(bytes);
    await put(pathname, Buffer.from(bytes), {
      access: "private",
      allowOverwrite: true,
      contentType: path.endsWith(".md") ? "text/markdown; charset=utf-8" : "application/octet-stream",
      token,
    });
    await put(prefix + HASHES + path.slice("evidence/".length) + ".json", JSON.stringify({ path, sha256: digest }), {
      access: "private",
      allowOverwrite: true,
      contentType: "application/json",
      token,
    });
  }
}
