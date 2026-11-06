import assert from "node:assert/strict";
import test from "node:test";
import { nativeProvider, nativeResearchTools } from "./native-research.ts";

test("each seat's provider gets its own native research tools", () => {
  const ids = (modelId: string) => nativeResearchTools(modelId, "instruction").map((tool) => tool.id);
  assert.deepEqual(ids("spacexai/grok-4.7"), ["xai.web_search", "xai.x_search"]);
  assert.deepEqual(ids("xai/grok-4"), ["xai.web_search", "xai.x_search"]);
  assert.deepEqual(ids("openai/gpt-6.1-sol"), ["openai.web_search"]);
  assert.deepEqual(ids("anthropic/claude-opus-5"), ["anthropic.web_search_20250305", "anthropic.web_fetch_20250910"]);
  assert.deepEqual(ids("google/gemini-3.5-pro"), ["google.google_search", "google.url_context"]);
  assert.deepEqual(ids("mistral/large"), ["gateway.parallel_search"], "any other provider searches through the Gateway");
  assert.equal(nativeProvider("constructor/model"), undefined, "prototype keys are not providers");
  for (const tool of nativeResearchTools("anthropic/claude", "instruction")) assert.equal(tool.type, "provider");
});

test("tool definitions are stable, so the broker snapshot matches the request", () => {
  for (const modelId of ["spacexai/grok-4.7", "openai/gpt", "anthropic/claude", "google/gemini", "other/model"]) for (const phase of ["instruction", "criticism"] as const) {
    const first = nativeResearchTools(modelId, phase);
    first[0]!.args.injected = true;
    assert.deepEqual(nativeResearchTools(modelId, phase), JSON.parse(JSON.stringify(nativeResearchTools(modelId, phase))));
    assert.ok(!("injected" in nativeResearchTools(modelId, phase)[0]!.args), "callers cannot change later definitions");
  }
  assert.deepEqual(nativeResearchTools("anthropic/claude", "instruction")[0], { type: "provider", id: "anthropic.web_search_20250305", name: "web_search", args: { maxUses: 10 } });
  assert.deepEqual(nativeResearchTools("anthropic/claude", "criticism")[0]!.args, { maxUses: 5 });
  assert.deepEqual(nativeResearchTools("other/model", "criticism")[0], { type: "provider", id: "gateway.parallel_search", name: "web_search", args: { mode: "advanced", maxResults: 10 } });
});
