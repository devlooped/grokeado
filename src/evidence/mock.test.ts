import assert from "node:assert/strict";
import test from "node:test";
import { parseEvidenceDocument, serializeEvidenceDocument } from "./okf.ts";
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
  assert.deepEqual(parseEvidenceDocument(promoted.get("evidence/grok/mock-exposicion-fragment.md")!).generated, { by: "grok", at: "2026-10-30T12:00:00.000Z", modelId: "court-fixture", effort: null });

  const visibleToPeer = new Map(original);
  for (const [path, content] of promoted) visibleToPeer.set(path, content);
  const peerFiles = createMockEvidencePromotion(visibleToPeer, "chatgpt", "objecion");
  assert(peerFiles.get("evidence/chatgpt/mock-objecion-argument.md")?.includes("/evidence/chatgpt/mock-objecion-fragment.md#p1"));
  assert.deepEqual(validatePromotedFiles("chatgpt", visibleToPeer, peerFiles), []);

  // An old immutable promotion must survive a retry unchanged.
  const legacy = promoted.get("evidence/grok/mock-exposicion-fragment.md")!.replace("  modelId: court-fixture\n  effort: null\n", "");
  assert.equal(parseEvidenceDocument(legacy).generated.modelId, undefined);
  visibleToPeer.set("evidence/grok/mock-exposicion-fragment.md", legacy);
  const retried = createMockEvidencePromotion(visibleToPeer, "grok", "exposicion");
  assert.equal(retried.get("evidence/grok/mock-exposicion-fragment.md"), legacy);
  assert.deepEqual(validatePromotedFiles("grok", visibleToPeer, retried), []);
});
