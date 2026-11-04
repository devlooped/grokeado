import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { COUNSEL, project, type CaseRecord, type CourtEvent } from "../domain/court.ts";
import { displayHistoricalCitations } from "../domain/historical-citations.ts";
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
  assert.equal((html.match(/Resumen del caso/g) ?? []).length, 1);
  assert.ok(html.includes("Por el moderador (Grok)"));
  assert.ok(html.includes("El debate discutió el alcance de las pruebas."));
  assert.ok(html.includes("Los analistas discreparon."));
  assert.ok(html.includes("Fundamentos de cada voto"));
});

test("the summary links the claims, sources and interventions it mentions", () => {
  const record: CourtEvent[] = [
    events[0]!,
    { type: "evidence_unified", sources: [{ id: "S1", url: "https://example.org/1", title: "Fuente", contributions: [] }] },
    { type: "statement", id: "I3", by: "claude", stage: "rebuttal", text: "Réplica con su fundamento.", evidenceIds: ["S1"] },
    { type: "case_summary", text: "A1 es falsa según la PF (S1); Claude lo precisó en I3. S9 no existe." },
  ];
  const recorded = record.map((e, i) => ({ ...e, seq: i + 1, at: c.createdAt }));
  const { document } = parseHTML(renderToStaticMarkup(createElement(CaseResult, { c, view: project(recorded), events: recorded })));
  const summary = [...document.querySelectorAll("section p")].find((p) => p.textContent.includes("según la PF"))!;
  assert.deepEqual([...summary.querySelectorAll("a")].map((a) => a.getAttribute("href")), ["#A1", "#S1", "#I3"]);
  assert.ok(summary.textContent.includes("S9 no existe."), "unknown ids stay as text");
});

test("the displayed historical summary links rewritten source references", () => {
  const record: CourtEvent[] = [
    events[0]!,
    { type: "evidence_unified", sources: [{ id: "S1", url: "https://example.org/1", title: "Fuente", contributions: [] }] },
    { type: "case_summary", text: "El resumen se apoya en S1." },
  ];
  const recorded = record.map((e, i) => ({ ...e, seq: i + 1, at: c.createdAt }));
  const { events: displayed } = displayHistoricalCitations(recorded);
  const html = renderToStaticMarkup(createElement(CaseResult, { c, view: project(displayed), events: displayed }));
  assert.ok(html.includes('href="#E1"'));
  assert.ok(!html.includes('href="#S1"'));
});

test("each quoted claim shows its conclusion, linked to the claim's reasons", () => {
  const { document } = parseHTML(render(events));
  const quote = document.querySelector("blockquote")!;
  for (const [id, verdict, label] of [["A1", "falso", "Falso"], ["A2", "insostenible", "Insostenible"]]) {
    const links = quote.querySelectorAll('a[href="#fundamentos-' + id + '"]');
    assert.equal(links.length, 1, id);
    assert.ok(links[0].querySelector(".bg-" + verdict), id + " shows the conclusion, not the votes");
    assert.ok(!links[0].querySelector(".size-6"), id + " has no vote chips");
    assert.match(links[0].getAttribute("aria-label") ?? "", new RegExp("Afirmación " + id + ": " + label));
    const target = document.getElementById("fundamentos-" + id)!;
    assert.equal(target.tagName, "DETAILS");
    assert.equal(target.closest("article")?.id, id);
  }
  assert.ok(quote.querySelector('a[href="#fundamentos-A2"] svg.text-seal'), "a tiebreak shows the gavel");
  assert.ok(!quote.querySelector('a[href="#fundamentos-A1"] svg.text-seal'));
});

test("partial quotes are underlined in their conclusion's color, while a quote of the whole content only gets its mark", () => {
  const { document } = parseHTML(render(events));
  assert.deepEqual([...document.querySelectorAll("blockquote mark.cita")].map((m) => m.getAttribute("data-verdict")), ["falso", "no_verificable"]);
  const whole: CaseRecord = { ...c, submission: { kind: "text", text: "Única afirmación." } };
  const single = parseHTML(render([
    { type: "claims_entered", claims: [{ id: "A1", quote: "Única afirmación", text: "Única afirmación examinada" }] },
    { type: "judgment", claimId: "A1", verdict: "falso", method: "consensus", reasoning: "" },
  ], whole)).document;
  const quote = single.querySelector("blockquote")!;
  assert.ok(!quote.querySelector("mark"));
  assert.ok(quote.textContent.includes("Única afirmación"));
  assert.ok(quote.querySelector('a[href="#fundamentos-A1"]'));
});

test("the conclusion's tooltip links each compact vote to that analyst's own reason, while an absence is not a link", () => {
  const { document } = parseHTML(render(events));
  const quote = document.querySelector("blockquote")!;
  assert.ok(quote.querySelector('[role="group"][aria-label="Votos de los analistas sobre A1"] a[href="#voto-A1-grok"]'));
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
