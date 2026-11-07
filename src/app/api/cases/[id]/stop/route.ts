import { revalidatePath } from "next/cache";
import { auth0 } from "@/lib/auth0.ts";
import { cancelCaseRun } from "@/lib/case-workflow.ts";
import { stopCaseResponse } from "@/lib/stop-case-response.ts";
import { stopCaseWorkflow } from "@/store.ts";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const session = await auth0.getSession();
  const { id } = await context.params;
  const response = await stopCaseResponse(request, id, session?.user, (caseId) => stopCaseWorkflow(caseId, cancelCaseRun));
  if (response.status === 204) {
    revalidatePath("/");
    revalidatePath(`/c/${id}`);
  }
  return response;
}
