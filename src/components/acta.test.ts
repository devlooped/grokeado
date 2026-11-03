import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { COUNSEL, project, type CourtEvent, type RecordedEvent } from "../domain/court.ts";
import { Acta } from "./acta.tsx";

function render(events: CourtEvent[]) {
  const recorded: RecordedEvent[] = events.map((e, i) => ({ ...e, seq: i + 1, at: "2026-10-30T14:00:00.000Z" }));
  return renderToStaticMarkup(createElement(Acta, { events: recorded, view: project(recorded), caseId: "fixture" }));
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

test("source cards show each reliability vote and decision once, without repeated acta entries", () => {
  const events: CourtEvent[] = [
    { type: "evidence_unified", sources: [
      { id: "S1", url: "https://example.org/1", title: "Fuente anulada", contributions: [] },
      { id: "S2", url: "https://example.org/2", title: "Fuente admitida", contributions: [] },
    ] },
    ...["S1", "S2"].flatMap((sourceId) => COUNSEL.map((by, i): CourtEvent => ({
      type: "source_review_vote", by, sourceId, veto: sourceId === "S1" && i < 3, reason: "Fundamento único " + sourceId + " " + by,
    }))),
    { type: "source_decided", sourceId: "S1", excluded: true },
    { type: "source_decided", sourceId: "S2", excluded: false },
    { type: "instruction_closed" },
    { type: "vote", by: "grok", claimId: "A1", verdict: "falso", rationale: "Voto sobre la afirmación." },
  ];
  const html = render(events);
  const { document } = parseHTML(html);
  for (const sourceId of ["S1", "S2"]) {
    const card = document.getElementById(sourceId)!;
    assert.ok(card.querySelector("details summary")?.textContent.includes("Votos y fundamentos sobre la confiabilidad"));
    for (const by of COUNSEL) {
      const reason = "Fundamento único " + sourceId + " " + by;
      assert.equal(html.split(reason).length - 1, 1, reason);
      assert.ok(card.textContent.includes(reason));
    }
  }
  assert.ok(document.getElementById("S1")!.textContent.includes("Anulada"));
  assert.ok(document.getElementById("S2")!.textContent.includes("Admitida"));
  assert.ok(!html.includes("anulada por mayoría (al menos 3 de 4 votos)"));
  assert.ok(!html.includes("admitida; no hubo mayoría para anularla"));
  assert.equal(document.querySelector("ol")!.children.length, 3, "no empty list entries for the suppressed events");
  assert.ok(html.includes("Voto sobre la afirmación."), "claim votes remain in the acta");
});

test("source events without a matching card or with an earlier different vote remain visible", () => {
  const html = render([
    { type: "evidence_unified", sources: [{ id: "S1", url: "https://example.org/1", title: "Fuente", contributions: [] }] },
    { type: "source_review_vote", by: "grok", sourceId: "S1", veto: true, reason: "Primera opinión sobre la fuente." },
    { type: "source_review_vote", by: "grok", sourceId: "S1", veto: false, reason: "Opinión final sobre la fuente." },
    { type: "source_review_vote", by: "gemini", sourceId: "S99", veto: false, reason: "Voto sin tarjeta correspondiente." },
    { type: "source_decided", sourceId: "S99", excluded: false },
  ]);
  for (const reason of ["Primera opinión sobre la fuente.", "Opinión final sobre la fuente.", "Voto sin tarjeta correspondiente."]) {
    assert.equal(html.split(reason).length - 1, 1);
  }
  assert.ok(html.includes("admitida; no hubo mayoría para anularla."));
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
  const html = render([{ type: "session_opened", simulated: true, judgeModel: "fixture", counselModels: { grok: "fixture", gemini: "fixture", claude: "fixture", chatgpt: "fixture" } }]);
  assert.ok(html.includes("Simulación local"));
  assert.ok(html.includes("fuentes y respuestas ficticias"));
});

test("the acta links OKF page citations to the case evidence route", () => {
  const html = render([
    { type: "statement", id: "I1", by: "grok", stage: "opening", text: "La evidencia disponible permite contrastar la afirmación.", evidenceIds: ["/evidence/grok/passage.md#p3"] },
  ]);
  assert.ok(html.includes('href="/caso/fixture/evidencia/grok/passage.md#p3"'));
});

test("the acta omits the moderator's summary because it is already shown in the case result", () => {
  const html = render([{ type: "case_summary", text: "El debate trató las diferencias entre los analistas." }, { type: "session_closed" }]);
  assert.ok(!html.includes("Resumen del moderador"));
  assert.ok(!html.includes("El debate trató las diferencias entre los analistas."));
  assert.ok(html.includes("Termina el debate"));
});

test("the acta renders historical Insostenible and new Engañoso verdicts", () => {
  const html = render([
    { type: "vote", by: "grok", claimId: "A1", verdict: "no_verificable", rationale: "Faltan pruebas." },
    { type: "judgment", claimId: "A1", verdict: "enganoso", method: "consensus", reasoning: "" },
  ]);
  assert.match(html, /text-insostenible-text[^>]*>Insostenible/);
  assert.match(html, /text-enganoso-text[^>]*>Engañoso/);
  assert.ok(!html.includes("No verificable"));
});
