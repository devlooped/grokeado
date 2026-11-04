import { revalidatePath } from "next/cache";
import { auth0 } from "@/lib/auth0.ts";
import { deleteCaseResponse } from "@/lib/delete-case-response.ts";
import { deleteCaseBlobs } from "@/evidence/blob.ts";
import { deleteCase } from "@/store.ts";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const session = await auth0.getSession();
  const { id } = await context.params;
  const response = await deleteCaseResponse(request, id, session?.user, (caseId) => deleteCase(caseId, deleteCaseBlobs));
  if (response.status === 204) {
    revalidatePath("/");
    revalidatePath(`/caso/${id}`);
  }
  return response;
}
