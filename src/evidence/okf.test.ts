import assert from "node:assert/strict";
import test from "node:test";
import { annotateEvidenceDocuments, parseEvidenceDocument, serializeEvidenceDocument } from "./okf.ts";

test("stamps trusted run metadata on promoted documents without altering citations or body", () => {
  const document = { type: "fragment" as const, title: "Title", description: "Description", sources: ["https://example.test"], generated: { by: "grok" as const, at: "2026-01-01T00:00:00.000Z", modelId: "untrusted", effort: "high" }, page: 1 };
  const path = "evidence/grok/nested/index.md";
  const files = new Map([[path, Buffer.from(serializeEvidenceDocument(document) + "\n  [p.1] Source text.\n")], ["evidence/grok/index.md", Buffer.from("# Catalog\n")]]);
  annotateEvidenceDocuments(files, "actual-model", null);
  const output = new TextDecoder().decode(files.get(path));
  assert.deepEqual(parseEvidenceDocument(output), { ...document, generated: { ...document.generated, modelId: "actual-model", effort: null } });
  assert.match(output, /\[p\.1\] Source text\./);
  assert.ok(output.endsWith("\n\n  [p.1] Source text.\n"));
  assert.equal(new TextDecoder().decode(files.get("evidence/grok/index.md")), "# Catalog\n");
});
