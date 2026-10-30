import assert from "node:assert/strict";
import { test } from "node:test";
import { CASES } from "./cases.ts";
import { canonicalUrl, groundResearch, modelFor, unify, validCitations } from "./core.ts";

test("source unification retains contradictions and authors, removes fragments only, and rejects invented quotations", () => {
  const url = "https://example.test/report?year=2024";
  const quote = "Las exportaciones aumentaron 17,3 por ciento.";
  const research = { supportingSearch: "Búsqueda a favor", opposingSearch: "Búsqueda contraria", gaps: [], evidence: [
    { url: url + "#table", title: "Informe", quote, stance: "supports" as const, relevance: "Dato" },
    { url, title: "Inventado", quote: "Este texto nunca fue recuperado.", stance: "opposes" as const, relevance: "No existe" },
  ] };
  const observations = [{ url, text: quote, tool: "web_search" }];
  const a = groundResearch("grok", research, observations);
  const b = groundResearch("claude", { ...research, evidence: [{ ...research.evidence[0], stance: "opposes" }] }, observations);
  assert.deepEqual(a.map((e) => e.grounded), [true, false]);
  assert.deepEqual(a.map((e) => e.retrieval), ["search_excerpt", null]);
  assert.equal(groundResearch("grok", research, [{ url, text: quote, tool: "web_fetch" }])[0].retrieval, "full_document");
  const dossier = unify([...a, ...b]);
  assert.equal(dossier.length, 1);
  assert.deepEqual(dossier[0].contributions.map((e) => [e.by, e.stance]), [["grok", "supports"], ["claude", "opposes"]]);
  assert.notEqual(canonicalUrl(url), canonicalUrl("https://example.test/report?year=2023"));
  assert(validCitations(["S1"], dossier));
  assert(!validCitations(["S2"], dossier));
  assert.throws(() => canonicalUrl("file:///secret"));
});

test("a quotation retrieved from a different source cannot validate a fabricated attribution", () => {
  const research = { supportingSearch: "Se buscó respaldo", opposingSearch: "Se buscó oposición", gaps: [], evidence: [
    { url: "https://example.test/a", title: "A", quote: "Una frase de otra fuente", stance: "context" as const, relevance: "Contexto" },
  ] };
  assert.equal(groundResearch("gemini", research, [{ url: "https://example.test/b", text: research.evidence[0].quote, tool: "web_fetch" }])[0].grounded, false);
});

test("routing changes capabilities while preserving all four supported evaluators", () => {
  for (const by of ["grok", "gemini", "claude", "openai"] as const) {
    assert(modelFor(by, "fact").providerOptions);
    assert(modelFor(by, "assessment").providerOptions);
  }
  assert.equal(modelFor("grok", "fact").id, modelFor("grok", "assessment").id);
  assert.notEqual(modelFor("claude", "fact").id, modelFor("claude", "assessment").id);
  assert.deepEqual(modelFor("grok", "fact").providerOptions, { xai: { reasoningEffort: "medium" } });
  assert.deepEqual(modelFor("grok", "assessment").providerOptions, { xai: { reasoningEffort: "high" } });
  assert.equal(CASES.find((c) => c.id === "brazil-extension")?.expectedVerdict, null, "the legal case has no predetermined verdict");
});
