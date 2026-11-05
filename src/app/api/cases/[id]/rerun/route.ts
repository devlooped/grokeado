import { revalidatePath } from "next/cache";
import { start } from "workflow/api";
import { auth0 } from "@/lib/auth0.ts";
import { rerunCaseResponse } from "@/lib/rerun-case-response.ts";
import { createNewCase, finishCase, getCase, getImage } from "@/store.ts";
import { courtSession } from "@/workflows/court-session.ts";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const session = await auth0.getSession();
  const { id } = await context.params;
  const response = await rerunCaseResponse(request, id, session?.user, {
    getCase, getImage, createCase: createNewCase,
    start: (caseId) => start(courtSession, [caseId]),
    finish: finishCase,
  });
  if (response.status === 201) revalidatePath("/");
  return response;
}
