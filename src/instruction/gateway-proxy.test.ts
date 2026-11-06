import assert from "node:assert/strict";
import test from "node:test";
import { createGateway, generateText, jsonSchema, stepCountIs } from "ai";
import { validateGatewayGeneration } from "./gateway-validation.ts";
import { preparationDefinitions } from "./preparation.ts";
import { forwardGatewayGeneration } from "./proxy.ts";
import { nativeResearchTools, NATIVE_GENERATION_MS } from "./native-research.ts";
import { toolSet } from "../../sandbox/harness/instruction-agent.ts";

test("gateway forwarding uses AI_GATEWAY_API_KEY and rejects a missing or placeholder key", async (t) => {
  const keys = ["AI_GATEWAY_API_KEY", "EVIDENCE_AI_GATEWAY_API_KEY"] as const;
  const previous = keys.map((key) => process.env[key]);
  t.after(() => keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }));
  process.env.EVIDENCE_AI_GATEWAY_API_KEY = "old-fixture";
  const request = new Request("https://ai-gateway.vercel.sh/v4/ai/language-model", { headers: { "ai-language-model-id": "fixture/model", "authorization": "Bearer untrusted", "ai-gateway-protocol-version": "untrusted", "ai-gateway-auth-method": "oidc" } });
  let calls = 0;
  t.mock.method(globalThis, "fetch", (async (_url, init) => {
    calls++;
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer current-fixture");
    assert.equal(headers.get("ai-gateway-protocol-version"), "0.0.1");
    assert.equal(headers.get("ai-gateway-auth-method"), "api-key");
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

test("SDK preparation requests retain the Gateway wire protocol through host forwarding", async (t) => {
  const previous = process.env.AI_GATEWAY_API_KEY;
  process.env.AI_GATEWAY_API_KEY = "host-fixture";
  t.after(() => { if (previous === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = previous; });
  const definitions = preparationDefinitions("intake");
  let sdkHeaders: Headers | undefined, upstreamCalls = 0;
  t.mock.method(globalThis, "fetch", (async (url, init) => {
    upstreamCalls++;
    assert.equal(String(url), "https://ai-gateway.vercel.sh/v4/ai/language-model");
    const headers = new Headers(init?.headers);
    for (const name of ["ai-gateway-protocol-version", "ai-gateway-auth-method", "ai-language-model-id", "ai-language-model-specification-version", "ai-language-model-streaming"]) {
      assert.equal(headers.get(name), sdkHeaders?.get(name), `${name} must match the SDK wire protocol`);
    }
    assert.equal(headers.get("authorization"), "Bearer host-fixture", "replace the VM placeholder with the host credential");
    assert.equal(headers.get("x-court-call-id"), null, "internal headers are not forwarded upstream");
    return Response.json({ content: [{ type: "text", text: "Fixture analysis" }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } });
  }) as typeof fetch);
  const gateway = createGateway({ baseURL: "https://ai-gateway.vercel.sh/v4/ai", apiKey: "placeholder", fetch: async (url, init) => {
    const request = new Request(url, init);
    sdkHeaders = new Headers(request.headers);
    request.headers.set("x-court-call-id", "turn:0");
    const body = JSON.parse(String(init?.body));
    validateGatewayGeneration(request, body, { phase: "intake", seat: "judge", sessionKey: "intake:judge:preparation", phaseSessionId: "fixture-phase", expiresAt: "2026-11-06T00:00:00.000Z", revoked: false, model: { id: "fixture/model" }, gatewayTools: definitions });
    return new Response(await forwardGatewayGeneration(request, body), { headers: { "content-type": "application/json" } });
  } });
  for (const toolChoice of ["auto", "none"] as const) {
    const result = await generateText({ model: gateway("fixture/model"), system: "Fixture system", prompt: "Prepare",
      tools: Object.fromEntries(definitions.map((definition) => [definition.name, { description: definition.description, inputSchema: jsonSchema(definition.inputSchema), execute: async () => ({}) }])),
      toolChoice, maxOutputTokens: 4096, stopWhen: stepCountIs(1), maxRetries: 0,
    });
    assert.equal(result.text, "Fixture analysis");
  }
  assert.equal(upstreamCalls, 2);
});

test("upstream rejection logs only the HTTP status, not its body or credentials", async (t) => {
  const previous = process.env.AI_GATEWAY_API_KEY;
  process.env.AI_GATEWAY_API_KEY = "private-key-fixture";
  t.after(() => { if (previous === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = previous; });
  const diagnostics: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { diagnostics.push(args); });
  t.mock.method(globalThis, "fetch", (async () => new Response("private upstream response", { status: 400 })) as typeof fetch);
  const request = new Request("https://ai-gateway.vercel.sh/v4/ai/language-model", { headers: { "ai-language-model-id": "fixture/model" } });
  await assert.rejects(forwardGatewayGeneration(request, {}), /gateway_generation_failed/);
  assert.deepEqual(diagnostics, [["Gateway generation rejected:", 400]]);
});


test("SDK native research requests reach the Gateway with their provider tools unchanged", async (t) => {
  const previous = process.env.AI_GATEWAY_API_KEY;
  process.env.AI_GATEWAY_API_KEY = "host-fixture";
  t.after(() => { if (previous === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = previous; });
  const native = nativeResearchTools("spacexai/fixture", "instruction");
  let upstream: Record<string, unknown> | undefined;
  t.mock.method(globalThis, "fetch", (async (_url, init) => {
    upstream = JSON.parse(String(init?.body));
    return Response.json({ content: [{ type: "text", text: "Report" }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } });
  }) as typeof fetch);
  const binding = { phase: "instruction" as const, seat: "grok" as const, sessionKey: "instruction:grok:preparation", phaseSessionId: "fixture-phase", expiresAt: "2026-11-06T00:00:00.000Z", revoked: false, model: { id: "spacexai/fixture" }, gatewayTools: native, maxOutputTokens: 8192 };
  const gateway = createGateway({ baseURL: "https://ai-gateway.vercel.sh/v4/ai", apiKey: "placeholder", fetch: async (url, init) => {
    const request = new Request(url, init);
    const body = JSON.parse(String(init?.body));
    validateGatewayGeneration(request, body, binding);
    return new Response(await forwardGatewayGeneration(request, body, NATIVE_GENERATION_MS), { headers: { "content-type": "application/json" } });
  } });
  const task = { caseId: "fixture", callId: "turn:0", model: binding.model, system: "Research", messages: [], tools: native, resultPath: "/workspace/result.json" };
  const result = await generateText({ model: gateway("spacexai/fixture"), system: "Research", prompt: "Claims",
    tools: toolSet(task, undefined, new AbortController().signal), maxOutputTokens: 8192, stopWhen: stepCountIs(1), maxRetries: 0 });
  assert.equal(result.text, "Report");
  assert.deepEqual(upstream?.tools, native.map(({ type, name, id, args }) => ({ type, name, id, args })));
});
