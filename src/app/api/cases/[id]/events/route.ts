import { caseEventStream } from "@/lib/case-event-stream.ts";
import { getCaseProgress } from "@/store.ts";

export const runtime = "nodejs";

// Cases and their dialogue are public, like /c/[id]. Only progress cursors cross SSE.
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  return caseEventStream(request, id, getCaseProgress);
}
