import nextEnv from "@next/env";
import assert from "node:assert/strict";
import { COUNSEL, project, type CourtEvent } from "../src/domain/court.ts";
import { COUNSEL_MODELS, JUDGE_MODEL } from "../src/court/models.ts";
import { runSeat } from "../src/court/seat.ts";
import { mockAiEnabled } from "../src/court/mock.ts";
import { conductTurn, type Docket, type TurnSpec } from "../src/court/turns.ts";

nextEnv.loadEnvConfig(process.cwd(), true);
if (!mockAiEnabled() && !process.env.AI_GATEWAY_API_KEY && !process.env.VERCEL_OIDC_TOKEN) {
  throw new Error("Set AI_GATEWAY_API_KEY in .env.local first. See README.md.");
}

const docket: Docket = {
  submission: { kind: "text", text: "Según el Censo 2022, la provincia de Córdoba tiene más habitantes que la Ciudad Autónoma de Buenos Aires." },
  today: new Date().toLocaleDateString("es-AR", { dateStyle: "long", timeZone: "America/Argentina/Buenos_Aires" }),
  simulated: mockAiEnabled(),
};
const record: CourtEvent[] = [];

async function turn(spec: TurnSpec) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const outcome = await conductTurn(docket, spec, record, attempt, async ({ seat, prompt, tools, done }) => {
      const model = seat === "judge" ? JUDGE_MODEL : COUNSEL_MODELS[seat];
      console.log(spec.kind + " / " + seat + " / " + model.id);
      await runSeat({ model, research: spec.kind === "instruction", prompt, tools, done, mock: docket.simulated ? { spec, record: [...record], submission: docket.submission } : undefined });
    });
    record.push(...outcome.events);
    if (outcome.done) return;
  }
  throw new Error("Turn did not complete: " + JSON.stringify(spec));
}

// Live calls: intake, instruction, unification, source review and final votes.
// This smaller probe needs neither Postgres nor a running Next.js server.
await turn({ kind: "intake" });
assert(record.some((e) => e.type === "claims_entered"), "The judge must identify a verifiable claim");
record.push({ type: "instruction_opened" });
for (const counsel of COUNSEL) {
  await turn({ kind: "instruction", counsel });
  assert(record.some((e) => e.type === "evidence_filed" && e.evidence.by === counsel), counsel + " must file real evidence");
}
await turn({ kind: "unification" });
if (project(record).sources.size) {
  for (const counsel of COUNSEL) await turn({ kind: "source_review", counsel });
  for (const source of project(record).sources.values()) {
    const vetoes = COUNSEL.filter((c) => source.votes[c]?.veto).length;
    record.push({ type: "source_decided", sourceId: source.id, excluded: vetoes > COUNSEL.length / 2 });
  }
}
record.push({ type: "instruction_closed" });
for (const counsel of COUNSEL) {
  await turn({ kind: "closing", counsel });
  assert(record.some((e) => e.type === "vote" && e.by === counsel), counsel + " must cast a vote");
}
console.log(JSON.stringify(record, null, 2));
console.log("PASS: intake, bilateral instruction, unified sources, criticism and final votes via AI Gateway.");
