import assert from "node:assert/strict";
import test from "node:test";
import { COUNSEL_MODELS, JUDGE_MODEL, modelEffort } from "./models.ts";

test("extracts explicitly configured effort for each provider, not an assumed default", () => {
  assert.equal(modelEffort(JUDGE_MODEL), "high");
  assert.equal(modelEffort(COUNSEL_MODELS.gemini), "high");
  assert.equal(modelEffort(COUNSEL_MODELS.claude), "high");
  assert.equal(modelEffort(COUNSEL_MODELS.chatgpt), null);
  assert.equal(modelEffort({ id: "openai/test", providerOptions: { openai: { reasoningEffort: "medium" } } }), "medium");
  assert.equal(modelEffort({ id: "unknown/test", providerOptions: { xai: { reasoningEffort: "high" } } }), null);
});
