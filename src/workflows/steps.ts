import type { Submission } from "../domain/court.ts";
import { finishCase, openSession, recordEvents } from "../store.ts";
import type { RecordedEvent } from "../domain/court.ts";

export async function openCase(caseId: string): Promise<{ submission: Submission; today: string }> {
  "use step";
  const { submission } = await openSession(caseId);
  const today = new Date().toLocaleDateString("es-AR", { dateStyle: "long", timeZone: "America/Argentina/Buenos_Aires" });
  return { submission, today };
}

export async function saveEvents(caseId: string, events: RecordedEvent[]): Promise<void> {
  "use step";
  await recordEvents(caseId, events);
}

export async function closeCase(caseId: string, status: "resolved" | "failed", error?: string): Promise<void> {
  "use step";
  await finishCase(caseId, status, error);
}
