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
  models: { judge: { id: "anthropic/claude-opus-5.5", effort: "high" }, "counsel.chatgpt": { id: "openai/gpt-6.1-sol", effort: "high" } },
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

test("the content, panel and claims form an overview immediately before the moderator summary", () => {
  const html = render(events);
  const { document } = parseHTML(html);
  const overview = document.querySelector("[data-case-overview]")!;
  assert.equal(overview.querySelector("figure figcaption")?.textContent, "Contenido");
  assert.ok(overview.querySelector("figure figcaption svg"), "the content has a margin icon");
  assert.ok(overview.querySelector('[aria-labelledby="case-panel-title"] svg'), "the panel has a margin icon");
  assert.equal(overview.querySelectorAll("article[data-claim]").length, 2);
  assert.ok(overview.querySelector('[aria-labelledby="case-claims-title"] svg'), "the claims have a margin icon");
  assert.equal(overview.nextElementSibling?.getAttribute("aria-labelledby"), "case-summary-title");
  assert.ok(html.indexOf('id="A1"') < html.indexOf("Resumen del caso"));
  assert.equal((html.match(/Resumen del caso/g) ?? []).length, 1);
  assert.equal(document.querySelector('[aria-labelledby="case-summary-title"] p.text-xs')?.textContent, "Por el moderador");
  assert.ok(html.includes("El debate discutió el alcance de las pruebas."));
  assert.ok(html.includes("Los analistas discreparon."));
  assert.ok(html.includes("Fundamentos de cada voto"));
});

test("a text submission identical to its sole claim shares one card with the result, votes and reasons", () => {
  const text = "Una afirmación verificable.";
  const input: CourtEvent[] = [
    { type: "claims_entered", claims: [{ id: "A1", quote: text, text }] },
    ...events.slice(1).filter((event) => !("claimId" in event) || event.claimId === "A1"),
  ];
  const { document } = parseHTML(render(input, { ...c, submission: { kind: "text", text } }));
  const card = document.getElementById("A1")!;
  assert.equal(document.querySelectorAll("article[data-claim]").length, 1);
  assert.equal(card.querySelector("figure")?.closest("article"), card);
  assert.equal(card.querySelector("figcaption")?.textContent, "ContenidoA1");
  assert.equal(card.textContent.split(text).length - 1, 1, "the claim's text appears only once");
  assert.ok(!card.querySelector("h3"));
  assert.ok(!card.querySelector("blockquote a"), "no duplicate inline result or vote tooltip");
  assert.ok(!document.querySelector('[aria-labelledby="case-claims-title"]'));
  assert.ok(card.textContent.includes("Falso"));
  assert.ok(card.textContent.includes("Mayoría · 3 de 4"));
  assert.equal(card.querySelectorAll('[role="group"] a').length, COUNSEL.length);
  for (const by of COUNSEL) {
    assert.ok(card.querySelector('a[href="#voto-A1-' + by + '"]'));
    assert.equal(document.getElementById("voto-A1-" + by)?.closest("details")?.id, "fundamentos-A1");
  }
  assert.equal(document.querySelector("[data-case-overview]")?.nextElementSibling?.getAttribute("aria-labelledby"), "case-summary-title");
});

test("matching a sole claim ignores surrounding quotation marks and terminal punctuation but does not invent a result", () => {
  const input: CourtEvent[] = [{ type: "claims_entered", claims: [{ id: "A1", quote: "Única afirmación", text: "Única afirmación" }] }];
  const { document } = parseHTML(render(input, { ...c, models: undefined, submission: { kind: "text", text: "  «Única afirmación.» " } }));
  const card = document.getElementById("A1")!;
  assert.ok(card.querySelector("figure"));
  assert.ok(card.textContent.includes("Sin resultado registrado"));
  assert.ok(!document.querySelector('[aria-labelledby="case-claims-title"]'));
  assert.equal(card.querySelectorAll('[role="group"] a').length, 0);
});

test("a sole claim with different wording remains separate even if it quotes the entire content", () => {
  const text = "Única afirmación.";
  const input: CourtEvent[] = [{ type: "claims_entered", claims: [{ id: "A1", quote: text, text: "Afirmación reformulada por el panel." }] }];
  const { document } = parseHTML(render(input, { ...c, submission: { kind: "text", text } }));
  assert.ok(!document.querySelector("figure")?.closest("article"));
  assert.equal(document.getElementById("A1")?.querySelector("h3")?.textContent, "Afirmación reformulada por el panel.");
  assert.ok(document.querySelector('[aria-labelledby="case-claims-title"]'));
});

test("links, images and multiple claims do not combine with the original content", () => {
  const text = "Comentario";
  const input: CourtEvent[] = [{ type: "claims_entered", claims: [{ id: "A1", quote: text, text }] }];
  for (const submission of [
    { kind: "link" as const, url: "https://example.org", note: text },
    { kind: "image" as const, mimeType: "image/png", note: text },
  ]) {
    const { document } = parseHTML(render(input, { ...c, submission }));
    assert.ok(!document.querySelector("figure")?.closest("article"));
    assert.ok(document.querySelector('[aria-labelledby="case-claims-title"]'));
  }
  const multiple: CourtEvent[] = [{ type: "claims_entered", claims: [{ id: "A1", quote: text, text }, { id: "A2", quote: "", text: "Otra afirmación" }] }];
  const { document } = parseHTML(render(multiple, { ...c, submission: { kind: "text", text } }));
  assert.ok(!document.querySelector("figure")?.closest("article"));
  assert.equal(document.querySelectorAll("article[data-claim]").length, 2);
});

test("every visible vote links to its own folded reason, with missing votes left unlinked", () => {
  const { document } = parseHTML(render(events));
  for (const id of ["A1", "A2"]) {
    const card = document.getElementById(id)!;
    const votes = card.querySelector('[role="group"]')!;
    assert.equal(votes.children.length, COUNSEL.length);
    assert.ok(!card.querySelector("details")?.hasAttribute("open"));
    for (const link of votes.querySelectorAll("a")) {
      const target = document.getElementById(link.getAttribute("href")!.slice(1));
      assert.equal(target?.closest("article"), card);
      assert.match(link.getAttribute("aria-label") ?? "", /Ver fundamento/);
    }
  }
  const partial = document.getElementById("A2")!;
  assert.equal(partial.querySelectorAll('[role="group"] a').length, 1);
  assert.ok(partial.querySelector('[role="group"] > [aria-label="Grok: no votó"]'));
  assert.ok(document.getElementById("A1")!.textContent.includes("Mayoría · 3 de 4"));
  assert.ok(partial.textContent.includes("Desempate del moderador"));
});

test("the overview shows a mixed or shared overall result without combining analysts' votes across claims", () => {
  const mixed = parseHTML(render(events)).document;
  assert.ok(mixed.querySelector('[aria-label="Resultado general: Mixto"]'));
  const shared = events.map((e): CourtEvent => e.type === "judgment" ? { ...e, verdict: "falso" } : e);
  const same = parseHTML(render(shared)).document;
  assert.ok(same.querySelector('[aria-label="Resultado general: Falso"] .bg-falso'));
  assert.ok(!same.querySelector('[aria-label="Resultado general: Mixto"]'));
  const pending = parseHTML(render([events[0]!])).document;
  assert.ok(!pending.querySelector('[aria-label^="Resultado general:"]'));
});

test("unresolved historical claims remain visible without an invented verdict or an empty panel", () => {
  const { document } = parseHTML(render([events[0]!], { ...c, models: undefined }));
  assert.ok(!document.querySelector('[aria-labelledby="case-panel-title"]'));
  assert.equal(document.querySelectorAll("article[data-claim]").length, 2);
  assert.ok(document.getElementById("A1")!.textContent.includes("Sin resultado registrado"));
  assert.equal(document.querySelectorAll('article [role="group"] a').length, 0);
  assert.ok(!document.querySelector('[aria-labelledby="case-summary-title"]'));
});

test("dismissal retains the original and panel without rendering a claims card", () => {
  const { document } = parseHTML(render([{ type: "dismissed", reason: "No hay afirmaciones verificables." }]));
  const overview = document.querySelector("[data-case-overview]")!;
  assert.ok(overview.querySelector("figure blockquote"));
  assert.ok(overview.querySelector('[aria-labelledby="case-panel-title"]'));
  assert.ok(overview.textContent.includes("No hay afirmaciones verificables."));
  assert.ok(!document.querySelector('[aria-labelledby="case-claims-title"]'));
  assert.ok(!document.querySelector('[aria-labelledby="case-summary-title"]'));
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
    assert.equal(target.closest("details")?.querySelector("summary")?.textContent, "Fundamentos de cada voto sobre " + target.closest("article")?.id);
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
  assert.ok(render(events, { ...c, submission: { kind: "image", mimeType: "image/png" } }).includes('/c/fixture/image'));
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
  assert.ok(card.querySelector('[aria-label="Desempate del moderador: Insostenible"] .bg-insostenible'));
  assert.ok(!document.toString().includes("No verificable"));
});

test("the seal carries the recorded moderator's mark without repeating their name in the reason", () => {
  const { document } = parseHTML(render(events));
  const card = document.getElementById("A2")!;
  const reason = [...card.querySelectorAll("li")].find((li) => li.textContent.startsWith("Moderador"))!;
  assert.match(reason.textContent, /^Moderador:/);
  assert.ok(card.querySelector('[aria-label^="Desempate del moderador"] svg line'), "the seal carries the Claude mark");
});

test("vote chips show the model id and effort the case recorded for each seat", () => {
  const { document } = parseHTML(render(events));
  const card = document.getElementById("A1")!;
  assert.ok(card.querySelector('[title="ChatGPT (gpt-6.1-sol high): Falso"]'));
  assert.ok(card.querySelector('[title="Gemini: Falso"]'), "seats without a recorded model keep the plain label");
});

test("older cases use the opening event for vote details without repeating the moderator", () => {
  const opened: CourtEvent = { type: "session_opened", judgeModel: "google/gemini-4-argon", judgeEffort: "high", counselModels: { grok: "spacexai/grok-4.7", gemini: "google/gemini-4-argon", claude: "anthropic/claude-opus-5.5", chatgpt: "openai/gpt-6.1-sol" }, counselEfforts: { grok: "high", gemini: "high", claude: null, chatgpt: "high" } };
  const old: CaseRecord = { ...c, models: undefined };
  const recorded = [opened, ...events].map((e, i) => ({ ...e, seq: i + 1, at: c.createdAt }));
  const { document } = parseHTML(renderToStaticMarkup(createElement(CaseResult, { c: old, view: project(recorded), events: recorded })));
  assert.equal(document.querySelector('[aria-labelledby="case-summary-title"] p.text-xs')?.textContent, "Por el moderador");
  assert.ok(document.querySelector('[title="Claude (claude-opus-5.5): Falso"]'), "no effort when none was configured");
  assert.match(parseHTML(render(events, old)).document.querySelector('[aria-labelledby="case-summary-title"] p.text-xs')?.textContent ?? "", /^Por el moderador$/);
});
