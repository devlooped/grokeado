import assert from "node:assert/strict";
import { test } from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { evidenceSchema, modelFor } from "./core.ts";
import { generateSubmission } from "./submission.ts";

test("Gateway research exposes fetch and submit in the first provider step, with no forced native search alias", async () => {
  const model = new MockLanguageModelV4({ doGenerate: {
    content: [{ type: "tool-call", toolCallId: "submit-1", toolName: "submit", input: JSON.stringify({ answer: "Recorded" }) }],
    finishReason: { unified: "tool-calls", raw: undefined },
    usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } },
    warnings: [],
  } });
  const { output } = await generateSubmission({ model: modelFor("chatgpt", "fact"), prompt: "Research and submit.",
    schema: z.object({ answer: z.string() }), research: true }, model);
  assert.deepEqual(output, { answer: "Recorded" });
  assert.deepEqual(model.doGenerateCalls[0].tools?.map((t) => t.name).sort(), ["submit", "web_fetch", "web_search"]);
  assert.deepEqual(model.doGenerateCalls[0].toolChoice, { type: "required" });
  assert.equal(model.doGenerateCalls.length, 1);
});

test("prose without a structured submission remains an execution failure", async () => {
  const model = new MockLanguageModelV4({ doGenerate: {
    content: [{ type: "text", text: "I searched, but did not file the evidence." }],
    finishReason: { unified: "stop", raw: undefined },
    usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } },
    warnings: [],
  } });
  await assert.rejects(generateSubmission({ model: modelFor("grok", "fact"), prompt: "Research and submit.",
    schema: z.object({ answer: z.string() }), research: true }, model), /tool call|structured submission/i);
});

test("a submit that claims sufficiency while omitting the checks cannot complete a generation", async () => {
  const model = new MockLanguageModelV4({ doGenerate: {
    content: [{ type: "tool-call", toolCallId: "invalid-evidence", toolName: "submit", input: JSON.stringify({ status: "sufficient", covered: [], gaps: [] }) }],
    finishReason: { unified: "tool-calls", raw: undefined },
    usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } },
    warnings: [],
  } });
  await assert.rejects(generateSubmission({ model: modelFor("grok", "fact"), prompt: "Evaluá la suficiencia y registrá los seis controles.",
    schema: evidenceSchema, research: false }, model), /structured submission|tool call|validation/i);
});
