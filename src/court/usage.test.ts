import assert from "node:assert/strict";
import test from "node:test";
import { generateText, stepCountIs } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { aggregateUsage, usageCalls } from "../domain/usage.ts";
import { recordModelUsage } from "./usage.ts";

test("every completed step is recorded, including steps before failure, without charging checkpoint replays", async () => {
  const records: unknown[] = [];
  const save = async (caseId: string, _id: string, body: unknown) => { assert.equal(caseId, "fixture"); records.push(body); };
  const track = recordModelUsage("fixture", { id: "openai/test", providerOptions: { openai: { reasoningEffort: "high" } } }, "moderator", save);
  let step = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => {
    if (step++ === 1) throw new Error("second step failed");
    return { content: [{ type: "tool-call", toolCallId: "call", toolName: "unknown", input: "{}" }], finishReason: { unified: "tool-calls", raw: undefined }, usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } }, warnings: [] };
  } });
  await assert.rejects(generateText({ model, prompt: "test", stopWhen: stepCountIs(2), onStepEnd: track, maxRetries: 0 }), /second step failed/);
  const totals = aggregateUsage(usageCalls(records));
  assert.equal(records.length, 1);
  assert.equal(totals[0]!.inputTokens, 100);
  assert.equal(totals[0]!.effort, "high");
  await recordModelUsage(undefined, { id: "test" }, "analyst", save)({ usage: {} });
  assert.equal(records.length, 1, "calls without a case binding cannot affect a case");
});
