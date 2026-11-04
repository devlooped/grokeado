import assert from "node:assert/strict";
import { test } from "node:test";
import type { Tool } from "ai";
import { researchTools } from "./research.ts";

test("x_search runs on the configured X researcher, not on the seat that calls it", async (t) => {
  const previous = process.env.AI_GATEWAY_API_KEY;
  t.after(() => { if (previous === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = previous; });
  process.env.AI_GATEWAY_API_KEY = "test-key";
  const requests: Array<{ headers: Record<string, string>; body: { tools: Array<{ id: string }>; providerOptions: unknown } }> = [];
  // A 400 is not retried, so the researcher makes exactly one request.
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push({ headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ error: { message: "No network in tests", type: "invalid_request_error" } }), { status: 400 });
  });
  const tools = researchTools(true, { id: "spacexai/grok-x-researcher", providerOptions: { xai: { reasoningEffort: "low" } } });
  const xSearch = tools.x_search as Tool<{ query: string }, unknown>;
  await assert.rejects(Promise.resolve(xSearch.execute!({ query: "posts sobre el censo" }, { toolCallId: "x-1", messages: [], context: undefined })));
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.headers["ai-language-model-id"], "spacexai/grok-x-researcher");
  assert.deepEqual(requests[0]!.body.providerOptions, { xai: { reasoningEffort: "low" } });
  assert.deepEqual(requests[0]!.body.tools.map((tool) => tool.id), ["xai.x_search"]);
});

test("without search, a seat only gets web_fetch", () => {
  assert.deepEqual(Object.keys(researchTools(false, { id: "spacexai/grok-4.7" })), ["web_fetch"]);
});
