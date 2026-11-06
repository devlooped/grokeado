import assert from "node:assert/strict";
import { test } from "node:test";
import { publicToolActivities, type ToolActivityData } from "./tool-activity.ts";

const base = { schemaVersion: 2, id: "tool:fixture", kind: "tool_call", at: "2026-11-06T00:00:00.000Z", seat: "claude", modelId: "anthropic/test", effort: "high" };

test("the public projection exposes only the four supported tools, their requested targets and caller", () => {
  const targets: ToolActivityData[] = [
    { tool: "read_source", url: "https://example.test/report" },
    { tool: "read_evidence", id: "E1", url: "https://example.test/report" },
    { tool: "web_search", query: "official population figures" },
    { tool: "x_search", query: "original public statement" },
  ];
  const records = targets.map((data, i) => ({ ...base, id: `tool:${i}`, data: { ...data, result: "PRIVATE RESULT", reasoning: "PRIVATE TRACE" }, messages: "PRIVATE PROMPT", providerOptions: "PRIVATE OPTIONS" }));
  const projected = publicToolActivities(records);
  assert.deepEqual(projected, targets.map((data, i) => ({ ...base, id: `tool:${i}`, data })));
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE|providerOptions|reasoning|messages|result/);
});

test("unsafe URLs, malformed records and other audit kinds never enter the timeline", () => {
  const records = [null, {}, { ...base, kind: "model_step", data: {} },
    { ...base, data: { tool: "compute", query: "private computation" } },
    { ...base, data: { tool: "read_source", url: "javascript:alert(1)" } },
    { ...base, data: { tool: "read_source", url: "https://user:secret@example.test/" } },
    { ...base, data: { tool: "read_evidence", id: "../private", url: "https://example.test/" } },
    { ...base, data: { tool: "web_search", query: "ab" } },
    { ...base, data: { tool: "x_search", query: "x".repeat(4001) } },
    { ...base, seat: "unknown", data: { tool: "web_search", query: "valid query" } },
  ];
  assert.deepEqual(publicToolActivities(records), []);
});
