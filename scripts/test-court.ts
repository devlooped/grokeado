import nextEnv from "@next/env";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

nextEnv.loadEnvConfig(process.cwd(), true);
if (!process.env.AI_GATEWAY_API_KEY && !process.env.VERCEL_OIDC_TOKEN) {
  throw new Error("Set AI_GATEWAY_API_KEY in .env.local and restart npm run dev first. See README.md.");
}
if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) throw new Error("Set DATABASE_URL in .env.local first.");

const base = new URL(process.env.WORKFLOW_LOCAL_BASE_URL ?? "http://localhost:3000");
if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) throw new Error("test:court only targets a local Next.js server.");
process.env.WORKFLOW_TARGET_WORLD = "local";
process.env.WORKFLOW_LOCAL_BASE_URL = base.origin;
// Match withWorkflow's local journal directory, including when this script runs
// outside the Next process. Otherwise returnValue waits on a stale pending run.
process.env.WORKFLOW_LOCAL_DATA_DIR ??= resolve(".next/workflow-data");
await fetch(base, { signal: AbortSignal.timeout(10_000) });

const { values, positionals } = parseArgs({ options: { case: { type: "string" }, run: { type: "string" } }, allowPositionals: true });
if (!!values.case !== !!values.run) throw new Error("Use --case <caseId> and --run <runId> together to validate an existing run.");

// Use the compiler's workflow ID rather than importing untransformed workflow
// source from tsx. Execution goes through Next's real Workflow handlers.
let workflowId: string | undefined;
for (const file of [".next/dev/diagnostics/workflows-manifest.json", ".next/diagnostics/workflows-manifest.json"]) {
  try {
    const manifest = JSON.parse(await readFile(file, "utf8"));
    workflowId = manifest.workflows["src/workflows/court-session.ts"].courtSession.workflowId;
    break;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
if (!workflowId) throw new Error("No compiled court workflow found. Run npm run dev or npm run build first.");

const { start, getRun } = await import("workflow/api");
const { createCase, finishCase, getCase, getEvents, newCaseId } = await import("../src/store.ts");
const { COUNSEL, project } = await import("../src/domain/court.ts");
const id = values.case ?? newCaseId();
if (!values.case) await createCase(id, { kind: "text", text: positionals.join(" ") || "Según el Censo 2022, la provincia de Córdoba tiene más habitantes que la Ciudad Autónoma de Buenos Aires." });
try {
  const run = values.run ? getRun(values.run) : await start({ workflowId }, [id]);
  console.log("Case: " + base.origin + "/caso/" + id);
  console.log("Workflow: " + run.runId);
  await run.returnValue;
} catch (err) {
  if (!values.case) await finishCase(id, "failed", "Local test workflow failed; inspect the workflow logs.");
  throw err;
}
assert.equal((await getCase(id))?.status, "resolved");
const events = await getEvents(id);
assert.equal(events.at(-1)?.type, "session_closed");
for (const counsel of COUNSEL) {
  assert(events.some((e) => e.type === "evidence_filed" && e.evidence.by === counsel), counsel + " must file evidence");
  assert(events.some((e) => e.type === "instruction_completed" && e.by === counsel), counsel + " must document bilateral searches");
  assert(events.some((e) => e.type === "vote" && e.by === counsel), counsel + " must vote");
}
const view = project(events);
assert(view.sources.size > 0, "The moderator must unify the contributed sources");
const instructionClosed = events.find((e) => e.type === "instruction_closed");
const firstOpening = events.find((e) => e.type === "floor_granted");
assert(instructionClosed && firstOpening && instructionClosed.seq < firstOpening.seq, "Instruction and criticism must finish before exposures");
for (const source of view.sources.values()) {
  for (const counsel of COUNSEL) assert(source.votes[counsel], counsel + " must review " + source.id);
  assert.equal(source.excluded, COUNSEL.filter((c) => source.votes[c]?.veto).length > COUNSEL.length / 2);
}
assert(events.filter((e) => e.type === "evidence_filed").every((e) => e.seq < instructionClosed.seq), "No new evidence after instruction");
console.log(JSON.stringify(project(events), null, 2));
const absences = events.filter((e) => e.type === "absence");
console.log(JSON.stringify({ status: "resolved", votes: events.filter((e) => e.type === "vote"), judgments: events.filter((e) => e.type === "judgment"), absences }));
assert.equal(absences.length, 0, "All seats must complete their turns");
console.log("PASS: full court resolved through Vercel Workflow and AI Gateway.");
// pg keeps connections alive; all workflow work has completed at this point.
process.exit(0);
