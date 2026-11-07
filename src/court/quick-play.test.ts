import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryArtifactStore } from "../evidence/artifacts.ts";
import { createQuickMockModel } from "./mock.ts";
import { courtModel } from "./models.ts";
import { quickAnswer, quickTiebreak, quickVote, type QuickPlayDependencies } from "./quick-play.ts";
import { failed } from "./quick.ts";

const CASE = "quick-fixture";
const MODEL = courtModel("anthropic/claude-opus-5.5", "high");

function deps(step: "answer" | "vote" | "tiebreak", artifacts = new MemoryArtifactStore(), audit: Array<{ id: string; body: Record<string, unknown> }> = []): QuickPlayDependencies {
  return {
    artifacts, model: createQuickMockModel(step),
    audit: async (_caseId, id, body) => void audit.push({ id, body: body as Record<string, unknown> }),
    getImage: async () => ({ mimeType: "image/png", bytes: Buffer.from([1, 2, 3]) }),
  };
}

test("an answer, its vote and a tie-break write their request, result and model step", async () => {
  const artifacts = new MemoryArtifactStore();
  const audit: Array<{ id: string; body: Record<string, unknown> }> = [];
  const submission = { kind: "image" as const, mimeType: "image/png", note: "¿Es real?" };
  const answer = await quickAnswer(CASE, submission, "es", MODEL, "claude", 0, deps("answer", artifacts, audit));
  assert.ok(!failed(answer));
  assert.match(answer.text, /SIMULACIÓN LOCAL/);
  const vote = await quickVote(CASE, submission, "es", MODEL, "claude", answer, 0, undefined, deps("vote", artifacts, audit));
  assert.ok(!failed(vote));
  assert.equal(vote.verdict, "no_verificable");
  const decision = await quickTiebreak(CASE, submission, "es", MODEL, [{ by: "claude", answer: answer.text, vote }], 0, deps("tiebreak", artifacts, audit));
  assert.ok(!failed(decision));

  const files = await artifacts.read(CASE);
  assert.deepEqual([...files.keys()].sort(), ["answer-0", "vote-0"].flatMap((step) => [`quick/claude/${step}/request.json`, `quick/claude/${step}/result.json`]).concat(["quick/judge/tiebreak-0/request.json", "quick/judge/tiebreak-0/result.json"]).sort());
  const request = new TextDecoder().decode(files.get("quick/claude/vote-0/request.json"));
  assert.match(request, /FACT CHECK:/);
  assert.match(request, /\(the submitted image\)/, "the image bytes stay out of request.json");
  assert.equal(JSON.parse(request).reasoning, "none");
  assert.deepEqual(audit.map((a) => a.id), ["quick:claude:answer:0", "quick:claude:vote:0", "quick:judge:tiebreak:0"]);
  assert.deepEqual(audit.map((a) => [a.body.kind, a.body.seat, a.body.phase, (a.body.data as { sessionId: string }).sessionId]), [
    ["model_step", "claude", "quick", "quick:claude"], ["model_step", "claude", "quick", "quick:claude"], ["model_step", "judge", "quick", "quick:judge"],
  ]);
});

test("a step run again reuses the result already written instead of calling the model again", async () => {
  const artifacts = new MemoryArtifactStore();
  const submission = { kind: "text" as const, text: "La pobreza bajó al 31,6 %." };
  const first = await quickAnswer(CASE, submission, "es", MODEL, "grok", 0, deps("answer", artifacts));
  const again = deps("answer", artifacts);
  again.model = createQuickMockModel("vote");
  assert.deepEqual(await quickAnswer(CASE, submission, "es", MODEL, "grok", 0, again), first);
});

test("a model failure and a vote that does not parse are results for the orchestration to retry", async () => {
  const submission = { kind: "text" as const, text: "La pobreza bajó al 31,6 %." };
  const broken = deps("answer");
  broken.model = { ...createQuickMockModel("answer"), doGenerate: async () => { throw new Error("gateway down"); } } as unknown as QuickPlayDependencies["model"];
  assert.deepEqual(await quickAnswer(CASE, submission, "es", MODEL, "gemini", 0, broken), { error: "gateway down" });
  const prose = await quickVote(CASE, submission, "es", MODEL, "gemini", { text: "Es falso.", sources: [], at: "2026-11-07T00:00:00.000Z" }, 0, undefined, deps("answer"));
  assert.ok(failed(prose));
  assert.match(prose.text ?? "", /SIMULACIÓN LOCAL/);
});
