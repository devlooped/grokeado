import type { ModelSelection, SDKImage } from "@cursor/sdk";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe } from "../domain/acta.ts";
import { COUNSEL, type CaseRecord, type Counsel } from "../domain/court.ts";
import { appendEvent, claimNextCase, DATA_DIR, finishCase, requeueInterruptedCases, UPLOADS_DIR } from "../store.ts";
import { holdSession, type Court } from "./procedure.ts";
import { openSdkSeat } from "./seat.ts";
import { openXTools } from "./x.ts";

const JUDGE_MODEL: ModelSelection = { id: "grok-4.7", params: [{ id: "reasoning_effort", value: "high" }] };
const COUNSEL_MODELS: Record<Counsel, ModelSelection> = {
  grok: { id: "grok-4.7", params: [{ id: "reasoning_effort", value: "high" }] },
  gemini: { id: "gemini-4-argon", params: [{ id: "reasoning_effort", value: "high" }] },
  claude: { id: "claude-opus-5-5", params: [{ id: "effort", value: "high" }] },
};

const CONCURRENCY = Number(process.env.COURT_CONCURRENCY ?? 1);
const POLL_MS = 3000;

const xTools = await openXTools().catch((err: unknown) => {
  console.error("Sin búsqueda en X: " + (err instanceof Error ? err.message : String(err)));
  return {};
});

async function openCourt(caseId: string): Promise<Court> {
  const workspaces = path.join(DATA_DIR, "workspaces", caseId);
  const [judge, ...counsel] = await Promise.all([
    openSdkSeat({ name: "moderador-" + caseId, model: JUDGE_MODEL, cwd: path.join(workspaces, "moderador"), builtinTools: ["webFetch"] }),
    ...COUNSEL.map((c) =>
      openSdkSeat({ name: c + "-" + caseId, model: COUNSEL_MODELS[c], cwd: path.join(workspaces, c), builtinTools: ["webSearch", "webFetch"], extraTools: xTools })
    ),
  ]);
  return {
    judge,
    counsel: Object.fromEntries(COUNSEL.map((c, i) => [c, counsel[i]])) as Court["counsel"],
    judgeModel: JUDGE_MODEL.id,
    counselModels: Object.fromEntries(COUNSEL.map((c) => [c, COUNSEL_MODELS[c].id])) as Court["counselModels"],
  };
}

function imagesFor(c: CaseRecord): SDKImage[] {
  if (c.submission.kind !== "image") return [];
  const data = readFileSync(path.join(UPLOADS_DIR, c.submission.file)).toString("base64");
  return [{ data, mimeType: c.submission.mimeType }];
}

async function runCase(c: CaseRecord): Promise<void> {
  console.log("[" + c.id + "] empieza el debate");
  let court: Court | undefined;
  try {
    court = await openCourt(c.id);
    await holdSession(court, {
      submission: c.submission,
      images: imagesFor(c),
      today: new Date().toLocaleDateString("es-AR", { dateStyle: "long", timeZone: "America/Argentina/Buenos_Aires" }),
      record: (e) => {
        const recorded = appendEvent(c.id, e);
        console.log("[" + c.id + "] #" + recorded.seq + " " + describe(e).slice(0, 160).replace(/\n/g, " "));
        return recorded;
      },
    });
    finishCase(c.id, "resolved");
    console.log("[" + c.id + "] caso resuelto");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishCase(c.id, "failed", message);
    console.error("[" + c.id + "] el análisis se interrumpió: " + message);
  } finally {
    if (court) await Promise.allSettled([court.judge, ...Object.values(court.counsel)].map((s) => s.dispose()));
  }
}

const requeued = requeueInterruptedCases();
if (requeued) console.log(requeued + " caso(s) interrumpido(s) vuelven a la cola");
console.log("El panel espera casos (concurrencia " + CONCURRENCY + ")");

let active = 0;
for (;;) {
  while (active < CONCURRENCY) {
    const next = claimNextCase();
    if (!next) break;
    active++;
    void runCase(next).finally(() => active--);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
