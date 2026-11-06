// Gives every case with a legacy id a new random AA-NNN-AA id.
// Dry run by default; pass --apply to write. Old ids stay as aliases that redirect.
import nextEnv from "@next/env";
import { parseArgs } from "node:util";

nextEnv.loadEnvConfig(process.cwd(), true);
const { values } = parseArgs({ options: { apply: { type: "boolean", default: false } } });

const { caseIdTaken, listCases, renameCase } = await import("../src/store.ts");
const { isCaseId, newCaseId } = await import("../src/lib/case-id.ts");
const { blobConfigured, copyCaseBlobs, deleteEvidenceBlobs } = await import("../src/evidence/blob.ts");

if (values.apply && !blobConfigured()) throw new Error("R2 credentials are required to move the evidence of the cases.");

const cases = (await listCases(Number.MAX_SAFE_INTEGER)).filter((c) => !isCaseId(c.id));
const busy = cases.filter((c) => c.status === "queued" || c.status === "in_session");
for (const c of busy) console.warn(`skip ${c.id}: ${c.status}, its workflow still uses the old id`);

const planned = new Set<string>();
for (const c of cases.filter((c) => !busy.includes(c))) {
  let id: string;
  do id = newCaseId();
  while (planned.has(id) || await caseIdTaken(id));
  planned.add(id);

  if (!values.apply) {
    console.log(`${c.id} -> ${id} (dry run)`);
    continue;
  }
  const oldBlobs = await copyCaseBlobs(c.id, id);
  await renameCase(c.id, id);
  await deleteEvidenceBlobs(oldBlobs);
  console.log(`${c.id} -> ${id} (${oldBlobs.length} objects moved)`);
}
if (!values.apply && planned.size) console.log("Run again with --apply to rename these cases.");
process.exit(0);
