import type { Submission } from "../domain/court.ts";
import { finishCase, openSession, recordEvents } from "../store.ts";
import type { RecordedEvent } from "../domain/court.ts";
import { mockAiEnabled } from "../court/mock.ts";

export async function openCase(caseId: string): Promise<{ submission: Submission; today: string; simulated: boolean }> {
  "use step";
  const simulated = mockAiEnabled();
  const { submission } = await openSession(caseId);
  const today = new Date().toLocaleDateString("es-AR", { dateStyle: "long", timeZone: "America/Argentina/Buenos_Aires" });
  return { submission, today, simulated };
}

export async function saveEvents(caseId: string, events: RecordedEvent[]): Promise<void> {
  "use step";
  await recordEvents(caseId, events);
}

export async function closeCase(caseId: string, status: "resolved" | "failed", error?: string): Promise<void> {
  "use step";
  await finishCase(caseId, status, error);
}
