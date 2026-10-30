import assert from "node:assert/strict";
import test from "node:test";
import { parseEvidenceDocument, renderEvidenceHtml, serializeEvidenceDocument } from "./okf.ts";
import type { EvidenceDocument } from "./schema.ts";
import { validateEvidenceTree, validatePromotedFiles } from "./validate.ts";

const fragment: EvidenceDocument = {
  type: "fragment",
  title: "Test passage",
  description: "Neutral transcript of the passage.",
  sources: ["evidence/base/raw/abc123.pdf"],
  generated: { by: "grok", at: "2026-10-30T12:00:00.000Z" },
  page: 2,
};

test("parses and serializes valid OKF documents", () => {
  const source = serializeEvidenceDocument(fragment, "Quoted text [p.2].");
  assert.deepEqual(parseEvidenceDocument(source), fragment);
});

test("rejects malformed or unknown OKF types", () => {
  assert.throws(() => parseEvidenceDocument("---\ntype: unknown\n---\n"));
  assert.throws(() => parseEvidenceDocument("---\ntype: fragment\ntype: argument\n---\n"));
});

test("renders page anchors while escaping document HTML", () => {
  const html = renderEvidenceHtml(serializeEvidenceDocument(fragment, "[p.2]\n<script>alert(1)</script>"));
  assert(html.includes('id="p2"'));
  assert(html.includes("&lt;script&gt;"));
  assert(!html.includes("<script>"));
});

test("validates source references, links, authorship, and evidence namespaces", () => {
  const files = new Map<string, string>([
    ["evidence/base/raw/abc123.pdf", "raw"],
    ["evidence/grok/passage.md", serializeEvidenceDocument(fragment, "Text.")],
    ["evidence/chatgpt/claim.md", serializeEvidenceDocument({ ...fragment, generated: { ...fragment.generated, by: "chatgpt" }, sources: ["https://example.com"] }, "[source](/evidence/grok/passage.md#p2)")],
  ]);
  assert.deepEqual(validateEvidenceTree(files), []);
  const invalid = new Map(files);
  invalid.set("evidence/chatgpt/claim.md", serializeEvidenceDocument({ ...fragment, sources: ["evidence/missing.md"] }));
  assert(validateEvidenceTree(invalid).some((error) => error.includes("source cannot be resolved")));
});

test("rejects writes outside the author's namespace and base tampering", () => {
  const base = new Map<string, string>([["evidence/base/raw/source.pdf", "original"]]);
  const promoted = new Map<string, string>([
    ["evidence/base/raw/source.pdf", "changed"],
    ["evidence/gemini/passage.md", serializeEvidenceDocument({ ...fragment, generated: { ...fragment.generated, by: "gemini" } })],
    ["evidence/chatgpt/claim.md", "unexpected"],
  ]);
  const errors = validatePromotedFiles("gemini", base, promoted);
  assert(errors.some((error) => error.includes("existing evidence is immutable")));
  assert(errors.some((error) => error.includes("writes must remain")));
});
