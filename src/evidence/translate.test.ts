import assert from "node:assert/strict";
import test from "node:test";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { serializeEvidenceDocument, parseEvidenceDocument } from "./okf.ts";
import { translatePromotedEvidence, translateSourceText, translatorFor } from "./translate.ts";
import { validateEvidenceTree } from "./validate.ts";

const original = serializeEvidenceDocument({ type: "fragment", title: "Report", description: "Evidence", sources: ["https://example.test"], generated: { by: "grok", at: "2026-01-01T00:00:00.000Z" }, page: 1 }, "[p.1] Hello [source](https://example.test).\n");

function translationResult() {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ changed: false, title: "", description: "", body: "hello" }) }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
    warnings: [],
  };
}
function mockTranslation() { return new MockLanguageModelV4({ doGenerate: translationResult() }); }
const input = { title: "", description: "", body: "hello" };
const catalogEntry = { id: "openai/gpt-6-luna", name: "Luna", type: "language", tags: [], efforts: ["low"], supportsNoReasoning: true };
const rejection = (message: string, statusCode = 400) => new APICallError({ message, url: "https://example.test", requestBodyValues: {}, statusCode, isRetryable: false });

test("each default translator request explicitly uses minimal thinking", async () => {
  const languageModel = mockTranslation();
  await translatorFor(undefined, languageModel)({ title: "", description: "", body: "hello" }, "en");
  const translator = translatorFor({ id: "google/gemini-3.5-flash-lite", providerOptions: { google: { thinkingConfig: { thinkingLevel: "high", thinkingBudget: 10, includeThoughts: false } } } }, languageModel);
  await translator({ title: "", description: "", body: "hello" }, "en");
  await translator({ title: "", description: "", body: "hello" }, "en");
  assert.deepEqual(languageModel.doGenerateCalls[0].providerOptions, { google: { thinkingConfig: { thinkingLevel: "minimal" } } });
  assert.deepEqual(languageModel.doGenerateCalls[1].providerOptions, { google: { thinkingConfig: { thinkingLevel: "minimal", includeThoughts: false } } });
  assert.deepEqual(languageModel.doGenerateCalls[2].providerOptions, { google: { thinkingConfig: { thinkingLevel: "minimal", includeThoughts: false } } });
});

test("uses reasoningEffort none when an OpenAI model's catalog entry supports it", async () => {
  const languageModel = mockTranslation();
  const translator = translatorFor({ id: "openai/gpt-6-luna", providerOptions: { openai: { reasoningEffort: "high", store: false } } }, languageModel, async () => [catalogEntry]);
  await translator({ title: "", description: "", body: "hello" }, "en");
  assert.deepEqual(languageModel.doGenerateCalls[0].providerOptions, { openai: { reasoningEffort: "none", store: false } });
});

test("uses xAI reasoningEffort none when its catalog entry supports it", async () => {
  const languageModel = mockTranslation();
  const model = { id: "spacexai/grok-4.7", providerOptions: { xai: { reasoningEffort: "high" } } };
  await translatorFor(model, languageModel, async () => [{ ...catalogEntry, id: model.id }])(input, "en");
  assert.deepEqual(languageModel.doGenerateCalls[0].providerOptions, { xai: { reasoningEffort: "none" } });
});

test("omits OpenAI reasoning effort when none is unsupported or the catalog is unavailable", async () => {
  for (const catalog of [async () => [{ ...catalogEntry, supportsNoReasoning: false }], async () => { throw new Error("catalog unavailable"); }]) {
    const languageModel = mockTranslation();
    await translatorFor({ id: catalogEntry.id, providerOptions: { openai: { reasoningEffort: "high", store: false } } }, languageModel, catalog)(input, "en");
    assert.deepEqual(languageModel.doGenerateCalls[0].providerOptions, { openai: { store: false } });
  }
});

test("retries rejected thinking or reasoning settings once without that setting", async () => {
  for (const [model, message, catalog, expected] of [
    [{ id: "google/gemini-3.5-flash-lite", providerOptions: { google: { thinkingConfig: { includeThoughts: false } } } }, "thinking_level is not supported", async () => [], { google: { thinkingConfig: { includeThoughts: false } } }],
    [{ id: catalogEntry.id, providerOptions: { openai: { store: false } } }, "Unsupported value for reasoning_effort", async () => [catalogEntry], { openai: { store: false } }],
  ] as const) {
    let calls = 0;
    const languageModel = new MockLanguageModelV4({ doGenerate: async () => { if (calls++ === 0) throw rejection(message); return translationResult(); } });
    await translatorFor(model, languageModel, catalog)(input, "en");
    assert.equal(languageModel.doGenerateCalls.length, 2);
    assert.deepEqual(languageModel.doGenerateCalls[1].providerOptions, expected);
  }
});

test("recognizes Gateway invalid-request errors and preserves non-reasoning options", async () => {
  const error = Object.assign(new Error("Unknown parameter: thinkingLevel"), { name: "GatewayInvalidRequestError", statusCode: 400 });
  let calls = 0;
  const languageModel = new MockLanguageModelV4({ doGenerate: async () => { if (calls++ === 0) throw error; return translationResult(); } });
  await translatorFor({ id: "google/gemini-3.5-flash-lite", providerOptions: { google: { responseModalities: ["TEXT"] } } }, languageModel)(input, "en");
  assert.deepEqual(languageModel.doGenerateCalls[1].providerOptions, { google: { responseModalities: ["TEXT"] } });
});

test("recognizes a structured unsupported parameter when the message omits its name", async () => {
  const error = new APICallError({ message: "Invalid value: none", url: "https://example.test", requestBodyValues: {}, statusCode: 400, responseBody: JSON.stringify({ error: { param: "reasoning_effort", message: "Value none is not supported" } }) });
  let calls = 0;
  const languageModel = new MockLanguageModelV4({ doGenerate: async () => { if (calls++ === 0) throw error; return translationResult(); } });
  await translatorFor({ id: catalogEntry.id }, languageModel, async () => [catalogEntry])(input, "en");
  assert.equal(languageModel.doGenerateCalls.length, 2);
  assert.deepEqual(languageModel.doGenerateCalls[1].providerOptions, { openai: {} });
});

test("other providers retain their existing options without a catalog lookup", async () => {
  const languageModel = mockTranslation();
  const catalog = async () => { throw new Error("must not be called"); };
  await translatorFor({ id: "anthropic/test", providerOptions: { anthropic: { effort: "high" } } }, languageModel, catalog)(input, "en");
  assert.deepEqual(languageModel.doGenerateCalls[0].providerOptions, { anthropic: { effort: "high" } });
});

test("does not retry unrelated errors or retry again when the fallback fails", async () => {
  for (const error of [rejection("Invalid schema"), rejection("thinking_level is not supported", 401), rejection("thinking_level is not supported", 429)]) {
    const languageModel = new MockLanguageModelV4({ doGenerate: async () => { throw error; } });
    await assert.rejects(translatorFor(undefined, languageModel)(input, "en"), (actual) => actual === error);
    assert.equal(languageModel.doGenerateCalls.length, 1);
  }
  let calls = 0;
  const failure = rejection("Invalid schema");
  const languageModel = new MockLanguageModelV4({ doGenerate: async () => { throw calls++ === 0 ? rejection("thinking_level is not supported") : failure; } });
  await assert.rejects(translatorFor(undefined, languageModel)(input, "en"), (actual) => actual === failure);
  assert.equal(languageModel.doGenerateCalls.length, 2);
});

test("translated promoted files retain original, provenance, references, and a valid evidence tree", async () => {
  const path = "evidence/grok/doc.md";
  const files = new Map([[path, new TextEncoder().encode(original)]]);
  await translatePromotedEvidence(files, "run", "grok", "es", async (input, language) => {
    assert.equal(language, "es");
    return { changed: true, title: "Informe", description: "Prueba", body: input.body.replace("Hello", "Hola") };
  });
  const translated = new TextDecoder().decode(files.get(path));
  assert.equal(parseEvidenceDocument(translated).title, "Informe");
  assert.match(translated, /Hola/);
  assert.deepEqual(validateEvidenceTree(files), []);
  const saved = [...files].find(([name]) => name.includes("/originals/"));
  assert.equal(JSON.parse(new TextDecoder().decode(saved![1])).original, original);
});

test("same-language text stays unchanged and altered references are rejected", async () => {
  const files = new Map([["evidence/grok/doc.md", new TextEncoder().encode(original)]]);
  await translatePromotedEvidence(files, "run", "grok", "en", async (input) => ({ changed: false, ...input }));
  assert.equal(files.size, 1);
  assert.equal(new TextDecoder().decode(files.values().next().value), original);
  await assert.rejects(translatePromotedEvidence(files, "run", "grok", "es", async (input) => ({ changed: true, ...input, body: "contenido sin cita" })), /referencias/);
  assert.equal(files.size, 1);
});

test("long source translations are not truncated and unchanged chunks retain exact original text", async () => {
  const source = "a".repeat(10000) + "hello";
  const calls: string[] = [];
  const result = await translateSourceText(source, "es", async (input) => { calls.push(input.body); return { ...input, changed: input.body === "hello", body: input.body === "hello" ? "hola" : input.body }; });
  assert.deepEqual(calls, ["a".repeat(10000), "hello"]);
  assert.equal(result.text, "a".repeat(10000) + "hola");
  assert.equal(result.changed, true);
});
