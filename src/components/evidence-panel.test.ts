import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { serializeEvidenceDocument } from "../evidence/okf.ts";
import { EvidencePanel, toEvidencePanelItems } from "./evidence-panel.tsx";

test("shows a reprocess beside the base extraction and keeps catalogs out of the parser", () => {
  const base = serializeEvidenceDocument({
    type: "evidence",
    title: "Original text",
    description: "Original submission text.",
    sources: ["evidence/base/raw/source.txt"],
    generated: { by: "base", at: "2026-10-30T12:00:00.000Z" },
    pages: [1],
    extraction: { tool: "original-text", confidence: 1 },
    tokens: 4,
  }, "[p.1]\n\nTexto base intacto.");
  const fragment = serializeEvidenceDocument({
    type: "fragment",
    title: "Reproceso",
    description: "Nueva lectura de la misma página.",
    sources: ["evidence/base/raw/source.txt"],
    generated: { by: "grok", at: "2026-10-30T12:00:00.000Z" },
    page: 1,
    reprocess_of: "/evidence/base/docs/submission.md#p1",
  }, "[p.1]\n\nTexto reprocesado.");
  const files = new Map<string, string>([
    ["evidence/base/raw/source.txt", "texto"],
    ["evidence/base/docs/submission.md", base],
    ["evidence/base/timeline.md", "# Timeline\n\n- 2024-03-03\n"],
    ["evidence/base/index.md", "# Evidence\n"],
    ["evidence/grok/passage.md", fragment],
  ]);

  const items = toEvidencePanelItems(files);
  assert.equal(items.some((item) => item.path.endsWith("/index.md")), false);
  assert.equal(items.find((item) => item.path.endsWith("/timeline.md"))?.title, "Cronología extraída");
  const reprocess = items.find((item) => item.path === "evidence/grok/passage.md");
  assert.equal(reprocess?.baseExcerpt, "Texto base intacto.");
  assert.match(reprocess?.body ?? "", /Texto reprocesado/);

  const html = renderToStaticMarkup(createElement(EvidencePanel, { caseId: "fixture", items }));
  assert.match(html, /Extracción base/);
  assert.match(html, /Texto base intacto/);
  assert.match(html, /Reproceso/);
  assert.match(html, /Texto reprocesado/);
  assert.match(html, /Cronología extraída/);
});
