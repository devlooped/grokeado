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
