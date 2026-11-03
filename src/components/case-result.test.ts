import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { COUNSEL, project, type CaseRecord, type CourtEvent } from "../domain/court.ts";
import { CaseResult } from "./case-result.tsx";

const c: CaseRecord = {
  id: "fixture", createdAt: "2026-10-30T14:00:00.000Z", status: "resolved",
  submission: { kind: "text", text: "Primera afirmación. Segunda afirmación." },
};
const events: CourtEvent[] = [
  { type: "claims_entered", claims: [
    { id: "A1", quote: "Primera afirmación", text: "Primera afirmación examinada" },
    { id: "A2", quote: "Segunda afirmación", text: "Segunda afirmación examinada" },
  ] },
  ...COUNSEL.map((by, i): CourtEvent => ({ type: "vote", by, claimId: "A1", verdict: i === 0 ? "verdadero" : "falso", rationale: "Fundamento de " + by })),
  { type: "vote", by: "gemini", claimId: "A2", verdict: "no_verificable", rationale: "La evidencia no alcanza." },
  { type: "judgment", claimId: "A1", verdict: "falso", method: "consensus", reasoning: "" },
  { type: "judgment", claimId: "A2", verdict: "no_verificable", method: "judge", reasoning: "El expediente es insuficiente." },
  { type: "case_summary", text: "El debate discutió el alcance de las pruebas. Los analistas discreparon." },
  { type: "session_closed" },
];

function render(input: CourtEvent[], record: CaseRecord = c) {
  return renderToStaticMarkup(createElement(CaseResult, { c: record, view: project(input) }));
}

test("the moderator summary follows the content and precedes the claims and their reasons", () => {
  const html = render(events);
  assert.ok(html.indexOf("Contenido</span>") < html.indexOf("Resumen del caso"));
  assert.ok(html.indexOf("Resumen del caso") < html.indexOf('id="A1"'));
  assert.ok(html.includes("Por el moderador (Grok)"));
  assert.ok(html.includes("El debate discutió el alcance de las pruebas."));
  assert.ok(html.includes("Los analistas discreparon."));
  assert.ok(html.includes("Fundamentos de cada voto"));
});

test("each compact vote links to that analyst's own reason, while an absence is not a link", () => {
  const { document } = parseHTML(render(events));
  const quote = document.querySelector("blockquote")!;
  assert.equal(quote.querySelectorAll('a[href="#A1"]').length, 1);
  assert.equal(quote.querySelectorAll('a[href="#A2"]').length, 1);
  for (const by of COUNSEL) {
    const link = quote.querySelector('a[href="#voto-A1-' + by + '"]');
    const target = document.getElementById("voto-A1-" + by);
    assert.ok(link && target, by);
    assert.ok(link.querySelector(".size-6"), "compact vote uses the small chip");
    assert.ok(target.textContent.includes("Fundamento de " + by));
    assert.equal(target.closest("details")?.querySelector("summary")?.textContent, "Fundamentos de cada voto");
    assert.match(link.getAttribute("aria-label") ?? "", /Ver fundamento/);
  }
  assert.ok(quote.querySelector('a[href="#voto-A2-gemini"]'));
  assert.ok(!quote.querySelector('a[href="#voto-A2-grok"]'));
  assert.ok(quote.querySelector('[aria-label="Grok: no votó"]'));
  assert.ok(document.querySelector('article .size-10'), "claim cards keep their larger chips");
});

test("historical and dismissed cases do not invent a summary; link and image submissions remain readable", () => {
  const old = events.filter((e) => e.type !== "case_summary");
  assert.ok(!render(old).includes("Resumen del caso"));
  const dismissed = render([{ type: "dismissed", reason: "No hay afirmaciones verificables." }]);
  assert.ok(dismissed.includes("No hay afirmaciones verificables."));
  assert.ok(!dismissed.includes("Resumen del caso"));
  assert.ok(render(events, { ...c, submission: { kind: "link", url: "https://example.org", note: "Comentario" } }).includes("https://example.org"));
  assert.ok(render(events, { ...c, submission: { kind: "image", mimeType: "image/png" } }).includes('/caso/fixture/imagen'));
});

test("the result shows all four verdicts and preserves historical Insostenible decisions", () => {
  const mixed = events.map((e): CourtEvent => e.type === "vote" && e.claimId === "A2" ? { ...e, verdict: "enganoso" } : e);
  const { document } = parseHTML(render(mixed));
  for (const [label, color] of [["Verdadero", "verdadero"], ["Falso", "falso"], ["Insostenible", "insostenible"], ["Engañoso", "enganoso"]]) {
    const swatches = [...document.querySelectorAll(".bg-" + color)];
    assert.ok(swatches.some((swatch) => swatch.parentElement?.textContent.includes(label)), label);
  }
  const card = document.getElementById("A2")!;
  assert.ok(card.querySelector(".text-insostenible-text")?.textContent.includes("Insostenible"));
  assert.ok(card.querySelector(".text-enganoso-text")?.textContent.includes("Engañoso"));
  assert.ok(card.querySelector('[aria-label="Gemini: Engañoso"] .bg-enganoso'));
  assert.ok(card.querySelector('[aria-label="Desempate del moderador (Grok): Insostenible"] .bg-insostenible'));
  assert.ok(!document.toString().includes("No verificable"));
});
