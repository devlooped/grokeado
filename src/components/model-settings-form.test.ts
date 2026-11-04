import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MODEL_ROLE } from "../court/models.ts";
import { ModelSettingsForm, type ModelRow } from "./model-settings-form.tsx";

test("ModelSettingsForm offers searchable catalog IDs, the defaults and the efforts of the chosen model", () => {
  const rows: ModelRow[] = [
    { ...MODEL_ROLE.translator, modelId: "google/gemini-3.5-flash-lite", effort: null, overridden: false },
    { ...MODEL_ROLE.judge, modelId: "openai/gpt-6-luna", effort: "low", overridden: true },
    { ...MODEL_ROLE["cover.image"], modelId: "spacexai/grok-imagine-image-2.0", effort: null, overridden: false },
  ];
  const html = renderToStaticMarkup(createElement(ModelSettingsForm, { rows, catalog: [
    { id: "google/gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite", type: "language", tags: [], efforts: ["low", "high"] },
    { id: "openai/gpt-6-luna", name: "Luna", type: "language", tags: [], efforts: ["low", "medium", "high"] },
    { id: "spacexai/grok-imagine-image-2.0", name: "Imagine", type: "image", tags: [], efforts: [] },
  ] }));
  assert.match(html, /<datalist id="gateway-models-language"><option value="google\/gemini-3.5-flash-lite">Gemini 3.5 Flash Lite<\/option><option value="openai\/gpt-6-luna">Luna<\/option><\/datalist>/);
  assert.match(html, /<datalist id="gateway-models-image"><option value="spacexai\/grok-imagine-image-2.0">/);
  assert.match(html, /<input id="translator:model" list="gateway-models-language"[^>]*value="google\/gemini-3.5-flash-lite"/);
  assert.match(html, /Predeterminado: spacexai\/grok-4.7 · esfuerzo high/);
  assert.match(html, /personalizado/);
  // The image role has no effort selector.
  assert.doesNotMatch(html, /name="cover.image:effort"/);
  const judgeEfforts = /name="judge:effort"[^>]*>(.*?)<\/select>/.exec(html)?.[1] ?? "";
  assert.match(judgeEfforts, /value="medium"/);
  const translatorEfforts = /name="translator:effort"[^>]*>(.*?)<\/select>/.exec(html)?.[1] ?? "";
  assert.doesNotMatch(translatorEfforts, /value="medium"/);
});
