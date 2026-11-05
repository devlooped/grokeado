import assert from "node:assert/strict";
import test from "node:test";
import { defineSandboxProxy } from "@vercel/sandbox/proxy";
import type { CaseRecord } from "../domain/court.ts";
import { MemoryArtifactStore } from "../evidence/artifacts.ts";
import { instructionSandboxLaunch } from "../evidence/broker.ts";
import { assertToolCapability, authorizeSandboxBinding, committedPhase, type SandboxBinding } from "./authorization.ts";
import { validateGatewayGeneration } from "./gateway-validation.ts";
import { createTurnProxy } from "./proxy.ts";
import { MemoryOperationRepository } from "./source-store.ts";
import { extractSource, SourceService } from "./sources.ts";

const binding: SandboxBinding = { phase: "debate", seat: "grok", sessionKey: "debate:grok:preparation", phaseSessionId: "phase", expiresAt: "2026-11-06T00:00:00.000Z", revoked: false, model: { id: "fixture/model" }, gatewayTools: [], activeTurn: { id: "turn", expiresAt: "2026-11-05T23:00:00.000Z", remainingRequests: 10 } };
const context = { phase: "debate" as const, pipelineVersion: 2, status: "in_session", phaseSessionId: "phase", activeTurnId: "turn", now: Date.parse("2026-11-05T00:00:00.000Z") };

test("sandbox authorization rejects expired/revoked/unknown phase identities and inactive or exhausted grants", () => {
  assert.doesNotThrow(() => authorizeSandboxBinding(binding, context));
  for (const changed of [ { revoked: true }, { expiresAt: "invalid" }, { expiresAt: "2020-01-01" }, { activeTurn: undefined }, { activeTurn: { ...binding.activeTurn!, remainingRequests: 0 } }, { activeTurn: { ...binding.activeTurn!, expiresAt: "2020-01-01" } } ]) assert.throws(() => authorizeSandboxBinding({ ...binding, ...changed }, context));
  for (const changed of [{ phase: "instruction" as const }, { phase: "settling" as const }, { status: "resolved" }, { status: "failed" }, { pipelineVersion: 1 }, { phaseSessionId: "other" }, { activeTurnId: "other" }]) assert.throws(() => authorizeSandboxBinding(binding, { ...context, ...changed }));
});

test("committed phases close all research at settlement and retain criticism research only before it", () => {
  assert.equal(committedPhase([]), "intake");
  assert.equal(committedPhase([{ type: "instruction_opened" }]), "instruction");
  assert.equal(committedPhase([{ type: "evidence_unified", sources: [] }]), "criticism");
  assert.equal(committedPhase([{ type: "evidence_settled", schemaVersion: 2, manifestHash: "a".repeat(64) }]), "settling");
  assert.equal(committedPhase([{ type: "instruction_closed" }]), "debate");
  for (const phase of ["instruction", "criticism"] as const) for (const name of ["read_source", "web_search", "x_search"]) assert.doesNotThrow(() => assertToolCapability(phase, name));
  for (const name of ["read_source", "web_fetch", "web_search", "x_search", "translate", "read_file"]) assert.throws(() => assertToolCapability("debate", name));
  assert.doesNotThrow(() => assertToolCapability("debate", "read_evidence"));
});

test("new broker forwards only exact POST tools/generation paths and terminally denies unmatched allowed-domain requests", () => {
  const launch = instructionSandboxLaunch("fixture", "https://staging.example.test");
  assert.deepEqual(Object.keys(launch.env).sort(), ["AI_GATEWAY_API_KEY", "AI_GATEWAY_BASE_URL", "COURT_TOOL_ORIGIN"]);
  assert.equal(launch.env.AI_GATEWAY_API_KEY, "placeholder");
  assert.equal(typeof launch.networkPolicy, "object");
  const policy = launch.networkPolicy as { allow: Record<string, Array<{ match?: unknown; response?: { statusCode: number }; forwardURL?: string }>> };
  assert.equal(policy.allow["*"], undefined);
  for (const rules of Object.values(policy.allow)) { assert.equal(rules.length, 2); assert.equal(rules[1]?.response?.statusCode, 403); assert.equal(rules[0]?.forwardURL, "https://staging.example.test/api/sandbox"); }
  for (const origin of ["http://staging.example.test", "https://user:secret@staging.example.test", "https://staging.example.test/path", "https://localhost"]) assert.throws(() => instructionSandboxLaunch("fixture", origin));
});

test("gateway validation permits only snapshotted ordinary generation and preserves cache hints", () => {
  const request = new Request("https://ai-gateway.vercel.sh/v4/ai/language-model", { headers: { "ai-language-model-id": "fixture/model", "ai-language-model-specification-version": "4", "ai-language-model-streaming": "false" } });
  const body = { prompt: [{ role: "system", content: "Canonical only", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }], tools: [], maxOutputTokens: 4096 };
  const before = JSON.stringify(body);
  validateGatewayGeneration(request, body, binding);
  assert.equal(JSON.stringify(body), before);
  for (const changed of [{ tools: [{ type: "provider-defined", id: "web_search" }] }, { providerOptions: { google: { useSearchGrounding: true } } }, { maxOutputTokens: 999_999 }, { responseFormat: { type: "url-reader" } }, { prompt: [{ role: "user", content: [{ type: "file", data: "https://foreign.test/source.pdf" }] }] }, { prompt: [{ role: "user", content: "x", providerOptions: { google: { retrieval: true } } }] }]) assert.throws(() => validateGatewayGeneration(request, { ...body, ...changed }, binding));
});

test("SDK proxy rejects missing/invalid OIDC, and dispatch rejects wrong identity/method/origin before case access", async () => {
  let calls = 0;
  const wrapped = defineSandboxProxy(async () => { calls++; return Response.json({ ok: true }); });
  assert.equal((await wrapped(new Request("https://staging.example.test/api/sandbox/any", { method: "POST" }))).status, 403);
  const dispatch = createTurnProxy({ origin: "https://staging.example.test", teamId: "team", projectId: "project" });
  const meta = { host: "staging.example.test", teamId: "wrong", projectId: "project", sandboxId: "sandbox", sandboxName: "sandbox" };
  assert.equal((await dispatch(new Request("https://staging.example.test/api/cases/fixture/turn-tools", { method: "POST" }), meta)).status, 403);
  meta.teamId = "team";
  for (const url of ["https://staging.example.test/api/cases/fixture/turn-tools", "https://staging.example.test/admin", "https://attacker.test/api/cases/fixture/turn-tools"]) assert.equal((await dispatch(new Request(url), meta)).status, 403);
  assert.equal(calls, 0);
});

test("persistent sandbox proxy binds the verified name across VM resumes and reuses generation checkpoints", async () => {
  const artifacts = new MemoryArtifactStore(), operations = new MemoryOperationRepository();
  const reader = new SourceService("fixture", "es", {
    artifacts, operations, extract: extractSource, translatorModelId: "fixture/translator", translatorFingerprint: "fixture-v1",
    translate: async (input) => ({ ...input, changed: false }), verifyLanguage: async () => ({ matches: true }),
    download: async () => { throw new Error("generation must not acquire sources"); },
  });
  const record: CaseRecord = { id: "fixture", createdAt: "2026-11-05T00:00:00.000Z", status: "in_session", pipelineVersion: 2, submission: { kind: "text", text: "Fixture", resolvedLanguage: "es" } };
  const body = { prompt: [{ role: "user", content: [{ type: "text", text: "Canonical only" }], providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }], tools: [], maxOutputTokens: 4096 };
  let generations = 0;
  const audit = new Map<string, unknown>();
  const dispatch = createTurnProxy({ origin: "https://staging.example.test", teamId: "team", projectId: "project" }, {
    consume: async (name) => { assert.equal(name, "persistent-fixture"); return { caseId: "fixture", binding }; },
    getCase: async () => ({ ...record, revision: 0 }), getEvents: async () => [], reader: () => reader, artifacts,
    audit: async (_caseId, key, value) => { if (audit.has(key)) assert.deepEqual(value, audit.get(key)); audit.set(key, value); },
    generate: async (_request, actual) => { generations++; assert.deepEqual(actual, body); return JSON.stringify({ content: [], usage: { inputTokens: { cacheRead: 42, cacheWrite: 10 } } }); },
  });
  const meta = { host: "ai-gateway.vercel.sh", teamId: "team", projectId: "project", sandboxName: "persistent-fixture", sandboxId: "vm-first" };
  const request = (input = body) => new Request("https://ai-gateway.vercel.sh/v4/ai/language-model", { method: "POST", headers: { "content-type": "application/json", "ai-language-model-id": "fixture/model", "ai-language-model-specification-version": "4", "ai-language-model-streaming": "false", "x-court-call-id": "turn:0" }, body: JSON.stringify(input) });
  const first = await dispatch(request(), meta);
  assert.equal(first.status, 200);
  const resumed = await dispatch(request(), { ...meta, sandboxId: "vm-resumed" });
  assert.equal(resumed.status, 200);
  assert.equal(await resumed.text(), await first.text());
  assert.equal(generations, 1);
  assert.equal(audit.size, 1);
  assert.match(JSON.stringify([...audit.values()]), /cacheRead/);
  const changed = await dispatch(request({ ...body, prompt: [{ ...body.prompt[0], content: [{ type: "text", text: "Changed request" }] }] }), meta);
  assert.equal(changed.status, 403, "the same call ID cannot replay a different prompt");
  assert.equal(generations, 1);
});
