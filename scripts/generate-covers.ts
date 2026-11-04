// Finds or generates the cover of resolved text and link cases that have none.
// Dry run by default; pass --apply to call Grok and write. --case <id> limits it to one case, --force replaces existing covers.
import nextEnv from "@next/env";
import { parseArgs } from "node:util";

nextEnv.loadEnvConfig(process.cwd(), true);
const { values } = parseArgs({
  options: { apply: { type: "boolean", default: false }, force: { type: "boolean", default: false }, case: { type: "string" } },
});

const { coverVersions, getCase, getCover, listCases } = await import("../src/store.ts");
const { illustrateCase } = await import("../src/court/cover.ts");

const all = values.case ? [await getCase(values.case)].filter((c) => c !== undefined) : await listCases(Number.MAX_SAFE_INTEGER);
const covered = await coverVersions(all.map((c) => c.id));
const pending = all.filter((c) => c.status === "resolved" && c.submission.kind !== "image" && (values.force || !covered.has(c.id)));

for (const c of pending) {
  if (!values.apply) {
    console.log(c.id + " (dry run)");
    continue;
  }
  try {
    await illustrateCase(c.id);
    const cover = await getCover(c.id);
    console.log(c.id + " -> " + (cover?.generated ? "generated" : "found " + cover?.sourceUrl));
  } catch (err) {
    console.error(c.id + " failed:", err);
  }
}
if (!values.apply && pending.length) console.log("Run again with --apply to create these covers.");
process.exit(0);
