import assert from "node:assert/strict";
import test from "node:test";
import { COUNSEL_MODELS, courtModel, DEFAULT_MODELS, JUDGE_MODEL, MODEL_ROLES, modelEffort, resolveModels } from "./models.ts";

test("extracts explicitly configured effort for each provider, not an assumed default", () => {
  assert.equal(modelEffort(JUDGE_MODEL), "high");
  assert.equal(modelEffort(COUNSEL_MODELS.gemini), "high");
  assert.equal(modelEffort(COUNSEL_MODELS.claude), "high");
  assert.equal(modelEffort(COUNSEL_MODELS.chatgpt), null);
  assert.equal(modelEffort({ id: "openai/test", providerOptions: { openai: { reasoningEffort: "medium" } } }), "medium");
  assert.equal(modelEffort({ id: "unknown/test", providerOptions: { xai: { reasoningEffort: "high" } } }), null);
});

test("defaults keep the models that were hardcoded before they became configurable", () => {
  assert.deepEqual(DEFAULT_MODELS.judge, { id: "spacexai/grok-4.7", providerOptions: { xai: { reasoningEffort: "high" } } });
  assert.deepEqual(COUNSEL_MODELS.grok, DEFAULT_MODELS.judge);
  assert.deepEqual(COUNSEL_MODELS.gemini, { id: "google/gemini-4-argon", providerOptions: { google: { thinkingConfig: { thinkingLevel: "high" } } } });
  assert.deepEqual(COUNSEL_MODELS.claude, { id: "anthropic/claude-opus-5.5", providerOptions: { anthropic: { effort: "high" } } });
  assert.deepEqual(COUNSEL_MODELS.chatgpt, { id: "openai/gpt-5.5" });
  assert.deepEqual(DEFAULT_MODELS.language, { id: "spacexai/grok-4.7" });
  assert.deepEqual(DEFAULT_MODELS["cover.chooser"], { id: "spacexai/grok-4.7" });
  assert.deepEqual(DEFAULT_MODELS["cover.image"], { id: "spacexai/grok-imagine-image-2.0" });
  assert.equal(DEFAULT_MODELS["tier.claude.comparison"].id, "anthropic/claude-sonnet-5.5");
});

test("translations have their own role, defaulting to Gemini Flash Lite", () => {
  assert.deepEqual(DEFAULT_MODELS.translator, { id: "google/gemini-3.5-flash-lite" });
  assert.equal(new Set(MODEL_ROLES.map((role) => role.key)).size, MODEL_ROLES.length);
});

test("courtModel maps effort to the option of each provider and round-trips through modelEffort", () => {
  for (const id of ["spacexai/a", "google/b", "anthropic/c", "openai/d"]) assert.equal(modelEffort(courtModel(id, "low")), "low");
  assert.deepEqual(courtModel("mistral/x", "high"), { id: "mistral/x" });
  assert.deepEqual(courtModel("openai/x", null), { id: "openai/x" });
});

test("stored settings override defaults; unknown roles and non-configurable efforts are ignored", () => {
  const models = resolveModels([
    { role: "translator", modelId: "openai/gpt-6-luna", effort: "low" },
    { role: "cover.image", modelId: "google/imagen", effort: "high" },
    { role: "retired", modelId: "x/y", effort: null },
  ]);
  assert.deepEqual(models.translator, { id: "openai/gpt-6-luna", providerOptions: { openai: { reasoningEffort: "low" } } });
  assert.deepEqual(models["cover.image"], { id: "google/imagen" });
  assert.deepEqual(models.judge, DEFAULT_MODELS.judge);
  assert.equal("retired" in models, false);
});
