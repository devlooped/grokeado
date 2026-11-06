import assert from "node:assert/strict";
import test from "node:test";
import type { RecordedEvent } from "../domain/court.ts";
import type { Operation } from "../instruction/source-store.ts";
import { buildCaseLog, parseCaseLog } from "./case-log.ts";

const events: RecordedEvent[] = [
  { type: "instruction_opened", seq: 1, at: "2026-11-05T00:00:02.000Z" },
  { type: "floor_granted", to: "grok", stage: "opening", seq: 2, at: "2026-11-05T00:00:01.000Z" },
  { type: "session_closed", seq: 3, at: "2026-11-05T00:00:03.000Z" },
];
const step = (sequence: number, at: string) => ({ schemaVersion: 2, id: `step:grok:debate:${sequence}`, kind: "model_step", at, seat: "grok", phase: "debate", modelId: "fixture/model", effort: "high", data: { sessionId: "fixture", channel: "decision", sequence, usage: { inputTokenDetails: { cacheReadTokens: 10 } }, request: `discussion/grok/turn/${sequence}/request.json` } });

test("one deterministic log contains every court event and deduplicated model/source provenance, preserving origin order", () => {
  const audit = [step(2, "2026-11-05T00:00:00.000Z"), step(1, "2026-11-05T00:00:01.000Z")];
  const operations: Operation[] = [{ key: "translation:fixture", stage: "translation", status: "ready", at: "2026-11-05T00:00:01.000Z", recoveries: [], result: { path: "instruction/operations/fixture/translation.json", hash: "fixture", title: "ORIGINAL_BODY_SENTINEL", body: "ORIGINAL_BODY_SENTINEL", modelId: "fixture/translator", effort: null } }];
  const log = buildCaseLog(events, [...audit, audit[0]], operations);
  const parsed = parseCaseLog(log);
  assert.equal(parsed.length, 6);
  assert.deepEqual(parsed.filter((record) => record.kind === "court_event").map((record) => record.data), events);
  assert.deepEqual(parsed.filter((record) => record.kind === "model_step").map((record) => record.data.sequence), [1, 2]);
  assert.equal(buildCaseLog([...events].reverse(), [...audit].reverse(), operations), log);
  assert.doesNotMatch(log, /ORIGINAL_BODY_SENTINEL|messages|credentials/);
  assert.match(log, /cacheReadTokens/);
  assert.equal(parsed.find((record) => record.kind === "source_operation")?.modelId, "fixture/translator");
});

test("prompt records come before the model steps of their session, whatever their clocks say", () => {
  const prompt = (id: string, sequence: number, at: string) => ({ schemaVersion: 2, id, kind: "prompt", at, seat: "grok", phase: "debate", modelId: "fixture/model", effort: "high", data: { sessionId: "fixture", channel: "decision", role: id.endsWith("system") ? "system" : "task", sequence, text: "Texto" } });
  const log = parseCaseLog(buildCaseLog([], [step(2, "2026-11-05T00:00:00.000Z"), prompt("prompt:fixture:t1", 1, "2026-11-05T00:00:05.000Z"), prompt("prompt:fixture:system", 0, "2026-11-05T00:00:04.000Z")], []));
  assert.deepEqual(log.map((record) => record.id), ["prompt:fixture:system", "prompt:fixture:t1", "step:grok:debate:2"]);
});

test("case logs reject conflicting IDs and duplicate parsed records instead of dropping outcomes", () => {
  const first = step(1, "2026-11-05T00:00:01.000Z");
  assert.throws(() => buildCaseLog([], [first, { ...first, effort: "low" }], []), /Conflicting/);
  const log = buildCaseLog(events, [], []);
  assert.throws(() => parseCaseLog(log + log), /Duplicate/);
});
