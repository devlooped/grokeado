import assert from "node:assert/strict";
import { test } from "node:test";
import type { RecordedEvent } from "../../src/domain/court.ts";
import { caseMetrics, percentile, renderResearchReport, seatMetrics, summarize, type CaseResult, type GatherRecord } from "./report.ts";

const at = "2026-11-06T00:00:00.000Z";
const post = "https://x.com/someone/status/123";
const page = "https://www.example.org/report/";
const proposal = (url: string, quote: string) => ({ claimId: "A1", url, quote, stance: "supports" as const });
const evidence = (id: string, by: "grok" | "gemini", url: string) => ({ id, by, claimId: "A1", stance: "supports" as const, title: "T", url, excerpt: "[b1] text", sourceId: url, blockIds: ["b1"] });
const events = ([
  { type: "evidence_proposed", by: "grok", proposal: proposal(post, "a") },
  { type: "evidence_proposed", by: "grok", proposal: proposal(post, "a") },
  { type: "evidence_proposed", by: "gemini", proposal: proposal(page, "b") },
  { type: "evidence_proposed", by: "gemini", proposal: proposal("https://broken.example/", "c") },
  { type: "evidence_proposed", by: "gemini", proposal: proposal(page, "invented") },
  { type: "evidence_filed", evidence: evidence("P1", "grok", post) },
  { type: "evidence_filed", evidence: evidence("P2", "gemini", page) },
  { type: "evidence_unified", sources: [
    { id: "E1", title: "T", url: post, contributions: [evidence("P1", "grok", post)], sourceId: "s1" },
    { id: "E2", title: "T", url: page, contributions: [evidence("P2", "gemini", page)], sourceId: "s2" },
  ] },
  ...(["grok", "gemini", "claude", "chatgpt"] as const).flatMap((by) => ["E1", "E2"].map((sourceId) => ({ type: "source_review_vote", by, sourceId, veto: false, reason: "ok" }))),
] as const).map((event, index) => ({ ...event, seq: index + 1, at })) as unknown as RecordedEvent[];
const rejected = [
  { ...proposal("https://broken.example/", "c"), by: "gemini" as const, seq: 4, at, reason: "source_failed", detail: "HTTP 404" },
  { ...proposal(page, "invented"), by: "gemini" as const, seq: 5, at, reason: "quote_not_found" },
];
const gather = (seat: GatherRecord["seat"], elapsedMs: number, finishReason = "stop"): GatherRecord => ({ seat, phase: "instruction", modelId: "m/" + seat, tools: ["p.web_search"], elapsedMs, finishReason, searches: 2, sources: 3, costUsd: 0.01 });
const result: CaseResult = {
  id: "fixture", references: ["https://example.org/report"], events, rejected,
  index: `E1 · "T" · x.com · ${post}\n  Claims: A1 supports (Grok)\n  Full post (fetched by the host): «text»\nE2 · "T" · example.org · ${page}\n  Claims: A1 supports (Gemini)`,
  gathers: [gather("grok", 100_000), gather("gemini", 200_000), gather("claude", 150_000), gather("chatgpt", 120_000)], decisionCostUsd: { grok: 0.02 },
};

test("seat metrics separate fetch failures, quote misses and duplicates", () => {
  assert.deepEqual(seatMetrics(result, "grok"), { proposals: 2, uniqueUrls: 1, fetchFailures: 0, quoteChecked: 2, matched: 2, filed: 1, duplicates: 1, votes: 2, sources: 2, searches: 2, costUsd: 0.03 });
  const gemini = seatMetrics(result, "gemini");
  assert.equal(gemini.fetchFailures, 1);
  assert.equal(gemini.quoteChecked, 2);
  assert.equal(gemini.matched, 1);
});

test("case metrics find references and check X posts in the index and the votes", () => {
  assert.deepEqual(caseMetrics(result), { uniqueUrls: 3, sources: 2, referencesFound: 1, xSources: 1, xEmbedded: 1, xVotedByOthers: 1 });
  const missing = { ...result, index: result.index.replace(/\n {2}Full post[^\n]*/, "") };
  assert.equal(caseMetrics(missing).xEmbedded, 0);
});

test("the thresholds gate on latency, quote matching, votes, X posts and tool errors", () => {
  const summary = summarize([result]);
  assert.equal(summary.p95, 200_000);
  assert.deepEqual(summary.checks, { latency: true, quotes: false, votes: true, x: true, tools: true, cases: true });
  assert.equal(summary.bySeat.gemini.matchedShare, 0.5);
  const slow = { ...result, gathers: [...result.gathers, gather("grok", 285_000, "timeout")] };
  assert.equal(summarize([slow]).checks.latency, false);
  const failed = { ...result, gathers: [...result.gathers, { ...gather("claude", 1000), error: "tool rejected" }] };
  assert.equal(summarize([failed]).checks.tools, false);
  const broken = summarize([{ ...result, error: "decision timeout" }]);
  assert.deepEqual([broken.checks.tools, broken.checks.cases], [true, false], "a case failure is not a tool failure");
  assert.match(renderResearchReport([result], { started: at, finished: at, spentUsd: 0.5, maxUsd: 8 }), /No cumple todos los umbrales/);
  // A case that failed before host collection has no quote, vote or X data: those checks fail instead of passing.
  const uncollected = { ...result, events: result.events.filter((e) => e.type === "evidence_proposed"), rejected: [], error: "Source is still being read" };
  const empty = summarize([uncollected]);
  assert.equal(empty.bySeat.grok.matchedShare, undefined);
  assert.deepEqual([empty.checks.quotes, empty.checks.votes, empty.checks.x], [false, false, false]);
  assert.equal(seatMetrics(uncollected, "grok").duplicates, 0);
});

test("the report lists each rejected proposal with why its URL could not be read", () => {
  const report = renderResearchReport([result], { started: at, finished: at, spentUsd: 0.5, maxUsd: 8 });
  assert.match(report, /- Gemini · A1 · source_failed: https:\/\/broken\.example\/ \(HTTP 404\)/);
  assert.match(report, /- Gemini · A1 · quote_not_found: https:\/\/www\.example\.org\/report\/\n/);
});

test("percentile takes the nearest rank", () => {
  assert.equal(percentile([], 0.95), undefined);
  assert.equal(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 0.95), 19);
});
