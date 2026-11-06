import assert from "node:assert/strict";
import test from "node:test";
import type { RecordedEvent } from "../domain/court.ts";
import { PhaseSession, phaseSystem, MemoryPhaseRepository } from "./phase-session.ts";
const config = { phase: "debate" as const, seat: "grok" as const, channel: "decision" as const, model: { id: "fixture/model" }, system: phaseSystem("debate", "grok", "es", "decision"), tools: "stable", initial: "question and admitted index" };
const stamp = (event: Omit<RecordedEvent, "seq" | "at">, seq: number): RecordedEvent => ({ ...event, seq, at: "2026-11-05T00:00:00.000Z" }) as RecordedEvent;

test("phase continuation appends only unseen committed events, keeps prior bytes, and never initializes debate from instruction", async () => {
  const repository = new MemoryPhaseRepository();
  const record = [
    stamp({ type: "instruction_opened" }, 1),
    stamp({ type: "instruction_completed", by: "grok", searches: [{ claimId: "A1", supporting: "EXCLUDED_INSTRUCTION_SENTINEL", opposing: "ORIGINAL_SENTINEL" }] } as RecordedEvent, 2),
    stamp({ type: "instruction_closed" }, 3),
    stamp({ type: "floor_granted", to: "grok", stage: "opening" } as RecordedEvent, 4),
  ];
  let session = await PhaseSession.open("case", config, repository);
  const identity = session.state.id;
  await session.begin("opening", record, "opening task");
  await session.append([{ role: "assistant", content: "previous result" }]);
  await session.finish();
  const prefix = JSON.stringify(session.state.messages);
  session = await PhaseSession.open("case", config, repository);
  assert.equal(session.state.id, identity);
  const next = [...record, stamp({ type: "floor_granted", to: "grok", stage: "rebuttal" } as RecordedEvent, 5)];
  await session.begin("rebuttal", next, "rebuttal task");
  assert.equal(JSON.stringify(session.state.messages.slice(0, -1)), prefix);
  assert.match(String(session.state.messages.at(-1)?.content), /rebuttal task/);
  assert.doesNotMatch(JSON.stringify(session.state.messages), /SENTINEL/);
  assert.equal(session.state.cursor, 5);
  const count = session.state.messages.length;
  await session.begin("rebuttal", next, "must not append retry task");
  assert.equal(session.state.messages.length, count);
  await assert.rejects(PhaseSession.open("case", { ...config, tools: "changed" }, repository), /configuration changed/);
});

test("debate fails closed without closure and refuses silent context resets", async () => {
  const session = await PhaseSession.open("case", config, new MemoryPhaseRepository());
  await assert.rejects(session.begin("opening", [], "task"), /before instruction closes/);
  session.state.messages.push({ role: "assistant", content: "x".repeat(2_000_001) });
  await assert.rejects(session.save(), /context limit/);
});

test("new turns allow 300 seconds without renewing the deadline on replay", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  for (const channel of ["preparation", "decision"] as const) {
    const repository = new MemoryPhaseRepository();
    const initial = { ...config, channel };
    let session = await PhaseSession.open("case", initial, repository);
    const record = [stamp({ type: "instruction_closed" }, 1)];
    const turn = await session.begin("turn", record, "task");
    const deadline = now + 300_000;
    assert.equal(Date.parse(turn.expiresAt), deadline);
    now += 60_000;
    session = await PhaseSession.open("case", initial, repository);
    assert.equal(Date.parse((await session.begin("turn", record, "task")).expiresAt), deadline);
  }
});

test("shared phase instructions require canonical case-language quotations, not preserved foreign quotes", () => {
  for (const language of ["es", "en"]) {
    const system = phaseSystem("debate", "judge", language, "decision");
    assert.match(system, /nunca conserves citas en otro idioma/);
    assert.doesNotMatch(system, /Conservá las citas textuales originales/);
  }
});

test("provider cache hints are stable, phase/channel scoped, and never rewrite the conversation prefix", async () => {
  const repository = new MemoryPhaseRepository();
  const initial = { ...config, model: { id: "openai/fixture", providerOptions: { openai: { reasoningEffort: "high" } } } };
  const first = await PhaseSession.open("case", initial, repository);
  assert.equal(first.state.model.providerOptions?.openai?.reasoningEffort, "high");
  const cacheKey = first.state.model.providerOptions?.openai?.promptCacheKey;
  assert.ok(typeof cacheKey === "string");
  // PostgreSQL JSONB may reorder object keys at any depth.
  first.state.model.providerOptions!.openai = { promptCacheKey: cacheKey, reasoningEffort: "high" };
  await first.save();
  assert.equal((await PhaseSession.open("case", initial, repository)).state.model.providerOptions?.openai?.promptCacheKey, cacheKey);
  for (const [caseId, changed] of [["other", initial], ["case", { ...initial, channel: "preparation" as const }], ["case", { ...initial, phase: "instruction" as const }]] as const) {
    assert.notEqual((await PhaseSession.open(caseId, changed, repository)).state.model.providerOptions?.openai?.promptCacheKey, cacheKey);
  }
  const anthropic = await PhaseSession.open("anthropic-case", { ...config, model: { id: "anthropic/fixture" } }, repository);
  assert.deepEqual(anthropic.state.messages[0]?.providerOptions, { anthropic: { cacheControl: { type: "ephemeral" } } });
  const prefix = JSON.stringify(anthropic.state.messages);
  await anthropic.begin("opening", [stamp({ type: "instruction_closed" }, 1)], "task");
  assert.equal(JSON.stringify(anthropic.state.messages.slice(0, -1)), prefix);
  assert.equal(anthropic.state.messages.at(-1)?.providerOptions, undefined);
});
