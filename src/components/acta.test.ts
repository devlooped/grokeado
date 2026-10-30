import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { COUNSEL, project, type CourtEvent, type RecordedEvent } from "../domain/court.ts";
import { Acta } from "./acta.tsx";

function render(events: CourtEvent[]) {
  const recorded: RecordedEvent[] = events.map((e, i) => ({ ...e, seq: i + 1, at: "2026-10-30T14:00:00.000Z" }));
  return renderToStaticMarkup(createElement(Acta, { events: recorded, view: project(recorded) }));
}

test("the acta displays shared attribution, bilateral searches, all reliability votes and the exclusion warning", () => {
  const url = "https://example.org/report";
  const html = render([
    { type: "instruction_opened" },
    { type: "instruction_completed", by: "grok", searches: [{ claimId: "A1", supporting: "Busqué tablas oficiales a favor.", opposing: "Busqué documentos en contra, sin resultados." }] },
    { type: "evidence_unified", sources: [{ id: "S1", url, title: "Informe compartido", contributions: [
      { id: "P1", by: "grok", claimId: "A1", title: "Informe compartido", url, excerpt: "Cifras que respaldan la afirmación.", stance: "supports" },
      { id: "P2", by: "gemini", claimId: "A1", title: "Informe compartido", url, excerpt: "Datos que contradicen la afirmación.", stance: "opposes" },
    ] }] },
    ...COUNSEL.map((by, i): CourtEvent => ({ type: "source_review_vote", by, sourceId: "S1", veto: i < 3, reason: i < 3 ? "No identifica autores ni métodos verificables." : "La fuente permite consultar los documentos originales." })),
    { type: "source_decided", sourceId: "S1", excluded: true },
    { type: "instruction_closed" },
    { type: "statement", id: "I1", by: "claude", stage: "opening", text: "Sin pruebas admitidas, no puedo verificar la afirmación.", evidenceIds: [] },
  ]);
  for (const text of ["Instrucción", "Busqué tablas oficiales a favor.", "Busqué documentos en contra, sin resultados.", 'id="S1"', "Aportada por Grok, Gemini", "a favor", "en contra", "3/4 votos por anular", "Anulada", "No identifica autores ni métodos verificables.", "La fuente permite consultar los documentos originales.", "No puede usarse como prueba", "Termina la instrucción"]) {
    assert.ok(html.includes(text), "Missing acta content: " + text);
  }
  assert.ok(html.indexOf("Termina la instrucción") < html.indexOf('id="I1"'));
});

test("historical evidence without instruction or stance remains visible and keeps its original citation anchor", () => {
  const html = render([
    { type: "evidence_filed", evidence: { id: "P1", by: "claude", claimId: "A1", title: "Documento histórico", url: "https://example.org/old", excerpt: "Datos citados en una sesión anterior." } },
    { type: "statement", id: "I1", by: "grok", stage: "opening", text: "Mi evaluación se basa en los datos registrados.", evidenceIds: ["P1"] },
    { type: "session_closed" },
  ]);
  assert.ok(html.includes('id="P1"'));
  assert.ok(html.includes('href="#P1"'));
  assert.ok(html.includes("Documento histórico"));
  assert.ok(!html.includes("Anulada"));
});

test("the stored simulation flag labels the acta independently of the current AI mode", () => {
  const html = render([{ type: "session_opened", simulated: true, judgeModel: "fixture", counselModels: { grok: "fixture", gemini: "fixture", claude: "fixture", openai: "fixture" } }]);
  assert.ok(html.includes("Simulación local"));
  assert.ok(html.includes("fuentes y respuestas ficticias"));
});
