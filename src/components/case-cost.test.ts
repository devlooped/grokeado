import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { caseCosts } from "../domain/cost.ts";
import { CaseCost } from "./case-cost.tsx";

test("Costo starts collapsed and includes a chart, table, all pivots, USD, and incomplete pricing disclosure", () => {
  const costs = caseCosts([
    { provider: "openai", model: "openai/test", effort: "high", role: "moderator", inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { provider: "spacexai", model: "spacexai/image", effort: null, role: "imagine", inputTokens: null, outputTokens: null, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ], { "openai/test": { input: 2, output: 10 } });
  const { document } = parseHTML(renderToStaticMarkup(createElement(CaseCost, { costs })));
  assert.equal(document.querySelector("details")!.hasAttribute("open"), false);
  assert.equal(document.querySelector("summary")!.textContent, "Costo · $3.0000 USD + ?");
  assert.deepEqual([...document.querySelectorAll("option")].map((o) => o.textContent), ["Provider", "Model", "Role"]);
  assert.ok(document.querySelector('[role="img"]'));
  assert.equal(document.querySelectorAll("tbody tr").length, 2);
  assert.match(document.querySelector("table")!.textContent, /openai.*1\.000\.000.*100\.000.*\$3\.0000/);
  assert.match(document.querySelector('[role="status"]')!.textContent, /1 llamadas sin precio/);
  assert.match(document.querySelector("table")!.textContent, /spacexai—————/);
  assert.ok(document.querySelector('a[href="https://models.dev"]'));
});

test("historical and simulated cases do not invent zero cost", () => {
  const html = renderToStaticMarkup(createElement(CaseCost));
  assert.match(html, /no tiene uso de tokens registrado/);
  assert.doesNotMatch(html, /\$0|<table/);
});
