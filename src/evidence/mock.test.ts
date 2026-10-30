import assert from "node:assert/strict";
import test from "node:test";
import { serializeEvidenceDocument } from "./okf.ts";
import { createMockEvidencePromotion } from "./mock.ts";
import { validatePromotedFiles } from "./validate.ts";

test("mock harness promotes fragments which become valid citations for another seat", () => {
  const baseDocument = serializeEvidenceDocument({
    type: "evidence",
    title: "Original text",
    description: "Original submission text.",
    sources: ["evidence/base/raw/source.txt"],
    generated: { by: "base", at: "2026-10-30T12:00:00.000Z" },
    pages: [1],
    extraction: { tool: "original-text", confidence: 1 },
    tokens: 4,
  }, "[p.1] A fixture source.");
  const original = new Map<string, string>([
    ["evidence/base/raw/source.txt", "fixture source"],
    ["evidence/base/docs/submission.md", baseDocument],
  ]);
  const promoted = createMockEvidencePromotion(original, "grok", "exposicion");
  assert.deepEqual(validatePromotedFiles("grok", original, promoted), []);

  const visibleToPeer = new Map(original);
  for (const [path, content] of promoted) visibleToPeer.set(path, content);
  const peerFiles = createMockEvidencePromotion(visibleToPeer, "chatgpt", "objecion");
  assert(peerFiles.get("evidence/chatgpt/mock-objecion-argument.md")?.includes("/evidence/chatgpt/mock-objecion-fragment.md#p1"));
  assert.deepEqual(validatePromotedFiles("chatgpt", visibleToPeer, peerFiles), []);
});
