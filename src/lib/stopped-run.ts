import { getWorld } from "workflow/runtime";

// Run cancellation prevents new workflow work but does not interrupt an
// executing step. Do not clear its artifacts while a started step may write.
type StepPage = { data: { status: string; startedAt?: Date }[]; hasMore: boolean; cursor: string | null };

export async function stoppedRunSettled(runId: string, list = async (id: string, cursor?: string): Promise<StepPage> => (await getWorld()).steps.list({ runId: id, pagination: { cursor }, resolveData: "none" })): Promise<boolean> {
  let cursor: string | undefined;
  do {
    const page = await list(runId, cursor);
    if (page.data.some((step) => step.status === "running" || step.status === "cancelled" || (step.status === "pending" && step.startedAt))) return false;
    if (!page.hasMore) return true;
    if (!page.cursor) throw new Error("Missing workflow step cursor");
    cursor = page.cursor;
  } while (true);
}
