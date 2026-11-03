import assert from "node:assert/strict";
import test from "node:test";
import type { RecordedEvent } from "../domain/court.ts";
import { annotateEvidenceTranscript, buildCaseTranscript } from "./transcript.ts";

const step = { at: "2026-01-01T00:00:00.000Z", step: 0, finishReason: "stop", toolCalls: [], usage: {} };
const statement: RecordedEvent = { type: "statement", id: "I1", by: "grok", stage: "opening", text: "Argumento", evidenceIds: ["S1"], evidenceRunId: "run-1", seq: 2, at: "2026-01-01T00:00:01.000Z" };
const other: RecordedEvent = { type: "statement", id: "I2", by: "claude", stage: "closing", text: "Conclusión", evidenceIds: [], seq: 3, at: "2026-01-01T00:00:02.000Z" };
const session: RecordedEvent = { type: "session_opened", judgeModel: "judge-id", counselModels: { grok: "grok-id", gemini: "gemini-id", claude: "claude-id", chatgpt: "chatgpt-id" }, seq: 1, at: "2025-01-01T00:00:00.000Z" };
const path = "evidence/grok/runs/run-1/transcript.jsonl";

test("merges committed statements into the matching run and chronological case transcript, idempotently", () => {
  const files = new Map([[path, JSON.stringify(step) + "\n"], ["evidence/claude/runs/run-2/transcript.jsonl", ""]]);
  const result = buildCaseTranscript(files, [other, statement, session]);
  assert.deepEqual(result.updatedRuns.get(path)!.trim().split("\n").map((line) => JSON.parse(line)), [{ ...step, modelId: "grok-id" }, { ...statement, modelId: "grok-id" }]);
  assert.equal(result.updatedRuns.has("evidence/claude/runs/run-2/transcript.jsonl"), false);
  assert.deepEqual(result.transcript.trim().split("\n").map((line) => JSON.parse(line)), [
    { ...step, modelId: "grok-id", type: "evidence_step", seat: "grok", runId: "run-1" }, { ...statement, modelId: "grok-id" }, { ...other, modelId: "claude-id" },
  ]);
  for (const [file, content] of result.updatedRuns) files.set(file, content);
  const retried = buildCaseTranscript(files, [statement, other, session]);
  assert.equal(retried.transcript, result.transcript);
  assert.equal(retried.updatedRuns.size, 0);
});

test("does not attach statements to another seat and rejects invalid run JSONL", () => {
  const wrongSeat = { ...statement, by: "gemini" } as RecordedEvent;
  const files = new Map([[path, JSON.stringify(step) + "\n"]]);
  const result = buildCaseTranscript(files, [wrongSeat, session]);
  assert.deepEqual(JSON.parse(result.updatedRuns.get(path)!.trim()), { ...step, modelId: "grok-id" });
  assert.equal(result.transcript.trim().split("\n").length, 2);
  assert.throws(() => buildCaseTranscript(new Map([[path, "{bad}\n"]]), []), /Invalid JSONL/);
  assert.throws(() => buildCaseTranscript(new Map([[path, "null\n"]]), []), /Invalid JSONL entry/);
});

test("uses the actual per-run and statement model IDs, preserving unknown historical IDs as null", () => {
  const input = JSON.stringify({ ...step, modelId: "old-snapshot-id" }) + "\n";
  const annotated = annotateEvidenceTranscript(Buffer.from(input), "actual-run-id");
  assert.equal(JSON.parse(annotated).modelId, "actual-run-id");
  const explicit = { ...statement, modelId: "actual-statement-id" };
  const result = buildCaseTranscript(new Map([[path, annotated]]), [session, explicit]);
  const entries = result.transcript.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(entries[0].modelId, "actual-run-id");
  assert.equal(entries[1].modelId, "actual-statement-id");
  const unknown = buildCaseTranscript(new Map([[path, JSON.stringify(step) + "\n"]]), [statement]);
  assert.deepEqual(unknown.transcript.trim().split("\n").map((line) => JSON.parse(line).modelId), [null, null]);
  const simulated = buildCaseTranscript(new Map(), [{ ...session, simulated: true }, statement]);
  assert.equal(JSON.parse(simulated.transcript).modelId, "court-fixture");
});
