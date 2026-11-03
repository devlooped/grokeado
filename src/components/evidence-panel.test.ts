import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EvidencePanel } from "./evidence-panel.tsx";

test("offers one complete ZIP download with a safely encoded case ID", () => {
  const html = renderToStaticMarkup(createElement(EvidencePanel, { caseId: "caso / 1" }));
  assert.ok(html.includes("Expediente de evidencia"));
  assert.ok(html.includes("Descargar expediente completo (ZIP)"));
  assert.ok(html.includes('href="/caso/caso%20%2F%201/expediente"'));
  assert.ok(html.includes("archivos originales, extracciones, cronología, entidades y aportes"));
  assert.doesNotMatch(html, /Abrir archivo|<details/);
});
