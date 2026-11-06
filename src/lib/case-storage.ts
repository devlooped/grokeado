import type { StoredCaseRecord } from "../store.ts";

export const MISSING_CASE_STORAGE = "Los archivos del caso no están en el almacenamiento.";

type Dependencies = {
  configured: () => boolean;
  exists: (id: string) => Promise<boolean>;
  fail: (id: string, revision: number, error: string) => Promise<boolean>;
};

// A resolved case without any stored files (for example after a storage migration)
// is recorded as a failed run, so an admin can fix it by running it again.
export async function detectMissingCaseStorage(c: StoredCaseRecord, deps: Dependencies): Promise<StoredCaseRecord> {
  if (c.status !== "resolved" || !deps.configured() || await deps.exists(c.id)) return c;
  if (!await deps.fail(c.id, c.revision, MISSING_CASE_STORAGE)) return c;
  return { ...c, status: "failed", error: MISSING_CASE_STORAGE };
}
