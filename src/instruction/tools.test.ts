import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MODELS, modelSnapshot } from "../court/models.ts";
import type { CaseRecord, RecordedEvent } from "../domain/court.ts";
import { MemoryArtifactStore } from "../evidence/artifacts.ts";
import { phaseActions } from "./court-tools.ts";
import { mockResearchWorker } from "./mock.ts";
import type { researchWorker } from "./research.ts";
import { MemoryOperationRepository } from "./source-store.ts";
import { extractSource, SourceService } from "./sources.ts";
import { executeSourceTool } from "./tools.ts";
import type { ToolActivity } from "../domain/tool-activity.ts";

for (const language of ["es", "en"]) test(`${language} criticism shares gathering reads and returns untranslated discovery/review text without promoting review material`, async () => {
  const artifacts = new MemoryArtifactStore(), operations = new MemoryOperationRepository();
  let downloads = 0, searches = 0;
  const reader = new SourceService("fixture", language, {
    operations, artifacts, extract: extractSource, translatorModelId: "fixture/translator", translatorFingerprint: "fixture-v1",
    download: async (url) => { downloads++; return { ok: true, finalUrl: url, redirects: 0, contentType: "text/plain", bytes: new TextEncoder().encode("FOREIGN_SENTINEL 42") }; },
    translate: async (input) => ({ ...input, title: input.title.replaceAll("FOREIGN_SENTINEL", language === "es" ? "Título canónico" : "Canonical title"), body: input.body.replaceAll("FOREIGN_SENTINEL", language === "es" ? "Texto canónico" : "Canonical text"), changed: true }),
    verifyLanguage: async () => ({ matches: true }),
  });
  const record: CaseRecord = { id: "fixture", createdAt: "2026-11-05T00:00:00.000Z", status: "in_session", pipelineVersion: 2, submission: { kind: "text", text: "FOREIGN_SENTINEL", resolvedLanguage: language }, models: modelSnapshot(DEFAULT_MODELS) };
  const events: RecordedEvent[] = [{ type: "evidence_unified", sources: [{ id: "E1", title: "Canonical source", url: "https://example.test/report.txt", contributions: [] }], seq: 1, at: record.createdAt }];
  const worker: typeof researchWorker = async (...args) => { searches++; return { ...await mockResearchWorker(...args), text: "FOREIGN_SENTINEL 42", sources: [{ type: "source", sourceType: "url", id: "fixture-source", url: "https://example.test/reputation", title: "FOREIGN_SENTINEL" }], modelId: "fixture/research" }; };
  const context = { record, events, phase: "instruction" as const, seat: "grok", turnId: "gather", reader, artifacts, worker };
  const first = await executeSourceTool({ tool: "read_source", input: { url: "https://example.test/report.txt" }, callId: "gather-read" }, context);
  const criticism = { ...context, phase: "criticism" as const, turnId: "review" };
  const reused = await executeSourceTool({ tool: "read_source", input: { url: "https://example.test/report.txt#p1", reviewSourceId: "E1" }, callId: "review-read" }, criticism);
  assert.ok("sourceId" in first && "sourceId" in reused);
  assert.equal(first.sourceId, reused.sourceId);
  assert.equal(downloads, 1);
  for (const tool of ["web_search", "x_search"] as const) {
    const call = { tool, input: { query: "author corrections", reviewSourceId: "E1" }, callId: tool };
    const result = await executeSourceTool(call, criticism);
    assert.ok("provenance" in result);
    assert.equal(result.provenance, "review_context");
    assert.equal(result.reviewSourceId, "E1");
    assert.match(JSON.stringify(result), /FOREIGN_SENTINEL/, "only admitted evidence is translated, once evidence closes");
    assert.deepEqual(await executeSourceTool(call, criticism), result);
    await assert.rejects(executeSourceTool({ ...call, input: { query: "author corrections" } }, criticism), /review_source_required/);
    await assert.rejects(executeSourceTool({ ...call, input: { query: "author corrections", reviewSourceId: "E2" } }, criticism), /review_source_required/);
    await assert.rejects(executeSourceTool(call, { ...criticism, phase: "debate" }), /tool_not_available_in_phase/);
  }
  assert.equal(searches, 2, "retries reuse each captured research call");
  assert.ok(!phaseActions("criticism", "grok").includes("file_evidence"));
  const files = await artifacts.read("fixture");
  assert.ok([...files.keys()].every((path) => path.startsWith("instruction/")));
  const audit = [...files].filter(([path]) => path.startsWith("instruction/research/")).map(([, bytes]) => new TextDecoder().decode(bytes));
  assert.ok(audit.some((text) => text.includes("FOREIGN_SENTINEL")), "original discovery stays audit-only");
  assert.ok(audit.some((text) => text.includes('"provenance":"review_context"') && text.includes('"reviewSourceId":"E1"')));
});

test("tool activity is published before work, identifies the calling provider and excludes internal arguments and results", async () => {
  const artifacts = new MemoryArtifactStore(), operations = new MemoryOperationRepository();
  const activities = new Map<string, ToolActivity>();
  const reader = new SourceService("fixture", "es", {
    operations, artifacts, extract: extractSource, translatorModelId: "fixture/translator", translatorFingerprint: "fixture-v1",
    translate: async (input) => ({ ...input, changed: false }), verifyLanguage: async () => ({ matches: true }),
    download: async (url) => {
      assert.ok([...activities.values()].some((activity) => activity.data.tool === "read_source"));
      return { ok: true, finalUrl: url, redirects: 0, contentType: "text/plain", bytes: new TextEncoder().encode("PRIVATE SOURCE BODY") };
    },
  });
  const record: CaseRecord = { id: "fixture", createdAt: "2026-11-06T00:00:00.000Z", status: "in_session", pipelineVersion: 2, submission: { kind: "text", text: "PRIVATE SUBMISSION", resolvedLanguage: "es" }, models: modelSnapshot(DEFAULT_MODELS) };
  const worker: typeof researchWorker = async (...args) => {
    assert.ok([...activities.values()].some((activity) => activity.data.tool === args[0]), "activity must be visible while the worker is running");
    return { ...await mockResearchWorker(...args), text: "PRIVATE WORKER RESULT", modelId: "spacexai/internal-worker" };
  };
  const context = { record, events: [] as RecordedEvent[], phase: "instruction" as const, seat: "claude", turnId: "turn", reader, artifacts, worker,
    activity: async (id: string, activity: ToolActivity) => { assert.equal(id, "fixture"); if (!activities.has(activity.id)) activities.set(activity.id, activity); },
  };
  await executeSourceTool({ tool: "read_source", input: { url: "https://example.test/report#p1" }, callId: "read" }, context);
  for (const tool of ["web_search", "x_search"] as const) {
    const call = { tool, input: { query: "original statement" }, callId: tool };
    await executeSourceTool(call, context);
    await executeSourceTool(call, context);
  }
  assert.equal(activities.size, 3, "replayed calls keep stable activity identities");
  for (const activity of activities.values()) {
    assert.equal(activity.seat, "claude");
    assert.equal(activity.modelId, record.models!["counsel.claude"].id, "X activity belongs to Claude, not the X research worker");
  }
  assert.doesNotMatch(JSON.stringify([...activities.values()]), /PRIVATE|SUBMISSION|internal-worker|reviewSourceId/);
  const count = activities.size;
  await assert.rejects(executeSourceTool({ tool: "web_search", input: { query: "original statement" }, callId: "forbidden" }, { ...context, phase: "debate" }), /tool_not_available_in_phase/);
  await assert.rejects(executeSourceTool({ tool: "read_source", input: { url: "javascript:alert(1)" }, callId: "unsafe" }, context), /Invalid source URL/);
  await assert.rejects(executeSourceTool({ tool: "web_search", input: { query: "original statement", thinking: "PRIVATE TRACE" }, callId: "invalid" }, context));
  assert.equal(activities.size, count, "rejected calls do not publish public activity");
  const events: RecordedEvent[] = [
    { type: "evidence_unified", sources: [{ id: "E1", title: "Report", url: "https://example.test/report", contributions: [] }], seq: 1, at: record.createdAt },
    { type: "source_decided", sourceId: "E1", excluded: false, seq: 2, at: record.createdAt },
  ];
  await assert.rejects(executeSourceTool({ tool: "read_evidence", input: { id: "E1" }, callId: "evidence" }, { ...context, phase: "debate", events })); // This fixture has no archived corpus.
  assert.deepEqual([...activities.values()].at(-1)?.data, { tool: "read_evidence", id: "E1", url: "https://example.test/report" });
  await assert.rejects(executeSourceTool({ tool: "read_evidence", input: { id: "E2" }, callId: "unknown" }, { ...context, phase: "debate", events }), /not admitted/);
  assert.equal(activities.size, 4);
});
