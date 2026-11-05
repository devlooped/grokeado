import assert from "node:assert/strict";
import test from "node:test";
import { forwardGatewayGeneration } from "./proxy.ts";

test("gateway forwarding uses AI_GATEWAY_API_KEY and rejects a missing or placeholder key", async (t) => {
  const keys = ["AI_GATEWAY_API_KEY", "EVIDENCE_AI_GATEWAY_API_KEY"] as const;
  const previous = keys.map((key) => process.env[key]);
  t.after(() => keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }));
  process.env.EVIDENCE_AI_GATEWAY_API_KEY = "old-fixture";
  const request = new Request("https://ai-gateway.vercel.sh/v4/ai/language-model", { headers: { "ai-language-model-id": "fixture/model" } });
  let calls = 0;
  t.mock.method(globalThis, "fetch", (async (_url, init) => {
    calls++;
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer current-fixture");
    return new Response("result");
  }) as typeof fetch);
  for (const key of [undefined, "", "  ", "placeholder", " placeholder "]) {
    if (key === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = key;
    await assert.rejects(forwardGatewayGeneration(request, {}), /gateway_key_unavailable/);
  }
  assert.equal(calls, 0);
  process.env.AI_GATEWAY_API_KEY = "current-fixture";
  assert.equal(await forwardGatewayGeneration(request, {}), "result");
  assert.equal(calls, 1);
});
