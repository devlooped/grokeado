import assert from "node:assert/strict";
import test from "node:test";
import { buildBaseBundle } from "./collect.ts";
import { buildFixturePdf } from "./fixture-pdf.ts";
import { MemoryEvidenceStore } from "./memory.ts";
import { createMockEvidencePromotion } from "./mock.ts";
import { sha256, validateEvidenceTree, validatePromotedFiles } from "./validate.ts";
import { assembleWorkspace, citationAuthors, citationsFor } from "./workspace.ts";

test("a scanned fixture can be cited by another seat only after exposicion", async () => {
  const image = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
  const pdf = buildFixturePdf([{ image }]);
  const bundle = await buildBaseBundle({
    now: "2026-10-30T12:00:00.000Z",
    submission: { kind: "link", url: "https://example.test/scan.pdf" },
    download: { ok: true, bytes: pdf, contentType: "application/pdf", finalUrl: "https://example.test/scan.pdf", redirects: 0 },
    recognize: async () => ({ text: "Acta escaneada del 3 de marzo de 2024. Ana Pérez ana@example.com", confidence: 0.4, tool: "tesseract-spa" }),
  });
  assert.deepEqual(validateEvidenceTree(bundle), []);

  const store = new MemoryEvidenceStore();
  await store.write("case-1", bundle);
  const stored = await store.read("case-1");
  const raw = [...stored.keys()].find((path) => path.endsWith(".pdf"));
  assert.ok(raw);
  assert.equal(sha256(stored.get(raw!)!), sha256(pdf));

  const grok = createMockEvidencePromotion(stored, "grok", "exposicion");
  assert.deepEqual(validatePromotedFiles("grok", stored, grok), []);
  await store.write("case-1", grok);
  const afterGrok = await store.read("case-1");
  assert.equal(sha256(afterGrok.get(raw!)!), sha256(pdf));

  const exposicion = assembleWorkspace(afterGrok, "chatgpt", "exposicion");
  assert.equal([...exposicion.keys()].some((path) => path.startsWith("evidence/grok/")), false);
  assert.deepEqual(citationsFor(exposicion, citationAuthors("chatgpt", "exposicion")).filter((citation) => citation.includes("/evidence/grok/")), []);

  const objecion = assembleWorkspace(afterGrok, "chatgpt", "objecion");
  assert.ok(objecion.has("evidence/grok/mock-exposicion-fragment.md"));
  assert.ok(citationsFor(objecion, citationAuthors("chatgpt", "objecion")).includes("/evidence/grok/mock-exposicion-fragment.md#p1"));
  const peer = createMockEvidencePromotion(objecion, "chatgpt", "objecion");
  assert.deepEqual(validatePromotedFiles("chatgpt", afterGrok, peer), []);
  assert.match(peer.get("evidence/chatgpt/mock-objecion-argument.md") ?? "", /\/evidence\/chatgpt\/mock-objecion-fragment\.md#p1/);

  const changed = new Map<string, string>([["evidence/grok/mock-exposicion-fragment.md", "replaced"]]);
  const errors = validatePromotedFiles("grok", afterGrok, changed);
  assert.ok(errors.some((error) => error.includes("existing evidence is immutable")));
});
