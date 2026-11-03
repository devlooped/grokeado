import type { CaseStatus } from "../domain/court.ts";
import type { EvidenceArchive } from "./blob.ts";

export async function evidenceDownloadResponse(
  status: CaseStatus | undefined,
  configured: boolean,
  getArchive: () => Promise<EvidenceArchive | undefined>
): Promise<Response> {
  if (status !== "resolved" || !configured) return new Response("No encontrado", { status: 404 });
  const archive = await getArchive();
  if (!archive) return new Response("No encontrado", { status: 404 });
  const url = new URL(archive.downloadUrl);
  url.searchParams.set("v", archive.etag);
  return new Response(null, { status: 302, headers: { location: url.toString(), "cache-control": "no-store" } });
}
