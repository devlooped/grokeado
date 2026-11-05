import { randomUUID } from "node:crypto";
import type { UsageRole } from "../domain/usage.ts";
import { saveCaseAuditRecord } from "../store.ts";
import { modelEffort, type CourtModel } from "./models.ts";

// Each completed SDK step is durable even if a later step or validation fails.
// A replayed checkpoint never invokes this callback; a fresh paid attempt does.
export function recordModelUsage(caseId: string | undefined, model: CourtModel, role: UsageRole, save = saveCaseAuditRecord) {
  return async ({ usage }: { usage: unknown }) => {
    if (!caseId) return;
    const id = `usage:${randomUUID()}`;
    await save(caseId, id, { schemaVersion: 2, id, kind: "model_step", at: new Date().toISOString(), modelId: model.id, effort: modelEffort(model), data: { role, usage } });
  };
}
