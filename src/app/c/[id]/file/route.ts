import { getOrCreateEvidenceArchive } from "@/evidence/archive.ts";
import { blobConfigured } from "@/evidence/blob.ts";
import { evidenceDownloadResponse } from "@/evidence/archive-download.ts";
import { getCase } from "@/store.ts";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const record = await getCase(id);
  return evidenceDownloadResponse(record?.status, blobConfigured(), () => getOrCreateEvidenceArchive(id));
}
