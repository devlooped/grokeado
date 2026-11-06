import { blobConfigured, caseArtifactStore } from "@/evidence/blob.ts";
import { artifactResponse } from "@/evidence/artifact-response.ts";
import { getCase } from "@/store.ts";
import { sharedPipeline } from "@/domain/court.ts";

export async function GET(_request: Request, context: { params: Promise<{ id: string; path: string[] }> }) {
  const { id, path } = await context.params;
  if (!blobConfigured() || !sharedPipeline((await getCase(id))?.pipelineVersion)) return new Response("No encontrada", { status: 404 });
  return artifactResponse(id, "instruction", path, [], caseArtifactStore);
}
