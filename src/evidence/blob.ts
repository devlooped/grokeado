import { del, list, put } from "@vercel/blob";
import { normalizeEvidenceBytes, sha256, type EvidenceFiles } from "./validate.ts";

const ROOT = (caseId: string) => `cases/${encodeURIComponent(caseId)}/evidence/`;
const HASHES = ".sha256/";
const BLOB_ACCESS = "public" as const;

class EvidenceConsistencyError extends Error {}

// Public stores ignore useCache. list() is origin metadata, and a changed etag
// is a different URL from the one the CDN cached for the previous version.
async function readPublicBlob(blob: { url: string; etag: string; pathname: string; size: number }): Promise<Uint8Array> {
  const load = async (version: string) => {
    const url = new URL(blob.url);
    url.searchParams.set("v", version);
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`Evidence blob disappeared while loading: ${blob.pathname}`);
    return new Uint8Array(await response.arrayBuffer());
  };
  const bytes = await load(blob.etag);
  if (bytes.byteLength === blob.size) return bytes;
  const again = await load(`${blob.etag}-${Date.now()}`);
  if (again.byteLength !== blob.size) throw new EvidenceConsistencyError(`Evidence blob is stale: ${blob.pathname}`);
  return again;
}

export function blobConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN || (process.env.VERCEL_OIDC_TOKEN && process.env.BLOB_STORE_ID));
}

// The read-write token wins when it is set, which is the deployed path.
// Local smoke uses the Vercel OIDC token with BLOB_STORE_ID instead.
function blobAuth(): { token: string } | { oidcToken: string; storeId: string } {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (token) return { token };
  const oidcToken = process.env.VERCEL_OIDC_TOKEN;
  const storeId = process.env.BLOB_STORE_ID;
  if (oidcToken && storeId) return { oidcToken, storeId };
  throw new Error("Blob credentials are not configured. Set BLOB_READ_WRITE_TOKEN, or VERCEL_OIDC_TOKEN and BLOB_STORE_ID.");
}

async function readEvidenceTreeOnce(caseId: string): Promise<Map<string, Uint8Array>> {
  const auth = blobAuth();
  const prefix = ROOT(caseId);
  const files = new Map<string, Uint8Array>();
  const hashes = new Map<string, { digest: string; uploadedAt: number }>();
  let cursor: string | undefined;

  do {
    const result = await list({ prefix, cursor, limit: 1000, mode: "expanded", ...auth });
    for (const blob of result.blobs) {
      const relative = blob.pathname.slice(prefix.length);
      if (!relative) continue;
      if (relative.startsWith(HASHES)) {
        const match = /^([a-f0-9]{64})\/(.+)\.json$/.exec(relative.slice(HASHES.length));
        if (!match) continue;
        const evidencePath = `evidence/${match[2]}`;
        const uploadedAt = blob.uploadedAt.getTime();
        const current = hashes.get(evidencePath);
        if (!current || uploadedAt >= current.uploadedAt) hashes.set(evidencePath, { digest: match[1], uploadedAt });
        continue;
      }
      files.set(`evidence/${relative}`, await readPublicBlob(blob));
    }
    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);

  for (const path of files.keys()) {
    if (!hashes.has(path)) throw new EvidenceConsistencyError(`Evidence hash is not available yet: ${path}`);
  }
  for (const [path, hash] of hashes) {
    const value = files.get(path);
    if (!value || sha256(value) !== hash.digest) throw new EvidenceConsistencyError(`Evidence hash verification failed: ${path}`);
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

export async function deleteEvidenceBlobs(urls: string[]): Promise<void> {
  if (urls.length) await del(urls, blobAuth());
}

export async function writeEvidenceTree(caseId: string, files: EvidenceFiles): Promise<void> {
  const auth = blobAuth();
  const prefix = ROOT(caseId);
  let totalSize = 0;
  for (const [path, content] of files) {
    const bytes = normalizeEvidenceBytes(path, content);
    totalSize += bytes.byteLength;
    if (totalSize > 25 * 1024 * 1024) throw new Error("Evidence upload exceeds 25 MiB.");
    const pathname = prefix + path.slice("evidence/".length);
    const digest = sha256(bytes);
    await put(pathname, Buffer.from(bytes), {
      access: BLOB_ACCESS,
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 60,
      contentType: path.endsWith(".md") ? "text/markdown; charset=utf-8" : "application/octet-stream",
      ...auth,
    });
    await put(`${prefix}${HASHES}${digest}/${path.slice("evidence/".length)}.json`, JSON.stringify({ path, sha256: digest }), {
      access: BLOB_ACCESS,
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 60,
      contentType: "application/json",
      ...auth,
    });
  }
}
