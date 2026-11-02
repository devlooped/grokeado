import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { serializeEvidenceDocument } from "../evidence/okf.ts";
import { EvidencePanel, toEvidencePanelItems } from "./evidence-panel.tsx";

test("shows a reprocess beside the base extraction and keeps catalogs out of the parser", () => {
  const base = serializeEvidenceDocument({
    type: "evidence",
    title: "Texto enviado",
    description: "Texto original enviado; conservado sin interpretación.",
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
  const argument = serializeEvidenceDocument({
    type: "argument",
    title: "Borrador de exposición",
    description: "Síntesis preliminar.",
    sources: ["evidence/base/raw/source.txt"],
    generated: { by: "grok", at: "2026-10-30T12:00:00.000Z" },
    stage: "exposicion",
    supports: ["/evidence/grok/passage.md#p1"],
    refutes: [],
  }, "Borrador en español.");
  const files = new Map<string, string>([
    ["evidence/base/raw/source.txt", "texto"],
    ["evidence/base/docs/submission.md", base],
    ["evidence/base/timeline.md", "# Cronología\n\n- 2024-03-03\n"],
    ["evidence/base/index.md", "# Evidencia\n"],
    ["evidence/grok/passage.md", fragment],
    ["evidence/grok/draft.md", argument],
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
  assert.match(html, /Colector · evidencia/);
  assert.match(html, /Grok · fragmento · p\. 1/);
  assert.match(html, /Grok · argumento/);
  assert.match(html, /Extracciones neutrales, fragmentos y borradores/);
  assert.doesNotMatch(html, /El raw|\bfragments\b|Submitted text/i);
  assert.doesNotMatch(html, /· (?:evidence|fragment|argument)\b/);
});

test("translates legacy English collector bundles and catalogs stored in existing cases", () => {
  const legacyText = serializeEvidenceDocument({
    type: "evidence",
    title: "Submitted text",
    description: "Original text submitted by the user; preserved without interpretation.",
    sources: ["evidence/base/raw/source.txt"],
    generated: { by: "base", at: "2026-10-30T12:00:00.000Z" },
    pages: [1],
    extraction: { tool: "original-text", confidence: 1 },
    tokens: 4,
  }, "[p.1]\n\nTexto enviado anteriormente.");
  const files = new Map<string, string>([
    ["evidence/base/docs/submission.md", legacyText],
    ["evidence/base/timeline.md", "# Timeline\n\nNo dates have been extracted from the submission.\n"],
    ["evidence/base/entities.md", "# Entities\n\nNo entities have been extracted from the submission.\n"],
  ]);

  const items = toEvidencePanelItems(files);
  const html = renderToStaticMarkup(createElement(EvidencePanel, { caseId: "legacy", items }));
  assert.match(html, /Texto enviado/);
  assert.match(html, /Texto original enviado; conservado sin interpretación\./);
  assert.match(html, /# Cronología/);
  assert.match(html, /No se extrajeron fechas del material enviado\./);
  assert.match(html, /# Entidades/);
  assert.match(html, /No se extrajeron entidades del material enviado\./);
  assert.doesNotMatch(html, /Submitted text|Original text submitted|# Timeline|# Entities|No dates have been|No entities have been/);
});
