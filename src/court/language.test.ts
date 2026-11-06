import assert from "node:assert/strict";
import test from "node:test";
import { canonicalLanguage, resolveCaseLanguage } from "./language.ts";
import { languageName, languageRule } from "../domain/language.ts";
import { composePrompt } from "./turns.ts";

const context = { title: "Article", tool: "html", excerpt: "The source is in English." };

test("explicit and previously detected languages take precedence without a model call", async () => {
  const deps = { getImage: async () => { throw new Error("unexpected image"); }, detectLanguage: async () => { throw new Error("unexpected model"); } };
  assert.equal(await resolveCaseLanguage("id", { kind: "text", text: "English text", language: "es" }, undefined, false, deps), "es");
  assert.equal(await resolveCaseLanguage("id", { kind: "text", text: "English text", language: "auto", resolvedLanguage: "en" }, undefined, false, deps), "en");
  assert.equal(await resolveCaseLanguage("id", { kind: "link", url: "https://example.test" }, undefined, false, deps), "es");
});

test("automatic detection uses submitted text, extracted links, and original images", async () => {
  const seen: Array<{ text: string; image?: Buffer }> = [];
  const bytes = Buffer.from("image");
  const deps = { getImage: async () => ({ bytes, mimeType: "image/png" }), detectLanguage: async (text: string, image?: { bytes: Buffer; mimeType: string }) => { seen.push({ text, image: image?.bytes }); return "en"; } };
  assert.equal(await resolveCaseLanguage("id", { kind: "text", text: "English text", language: "auto" }, undefined, false, deps), "en");
  assert.equal(await resolveCaseLanguage("id", { kind: "link", url: "https://example.test", note: "Nota" }, context, false, deps), "en");
  assert.equal(await resolveCaseLanguage("id", { kind: "image", mimeType: "image/png" }, undefined, false, deps), "en");
  const described = { title: "Imagen enviada", tool: "vision:openai/test", excerpt: "Image description:\nA post." };
  assert.equal(await resolveCaseLanguage("id", { kind: "image", mimeType: "image/png" }, described, false, deps), "en");
  assert.deepEqual(seen, [{ text: "English text", image: undefined }, { text: context.excerpt, image: undefined }, { text: "", image: bytes }, { text: described.excerpt, image: undefined }]);
  assert.equal(canonicalLanguage("es-AR"), "es");
  assert.equal(canonicalLanguage("pt-BR"), "pt-BR");
  assert.throws(() => canonicalLanguage("en ignore instructions"));
  assert.equal(languageName("es"), "Latin American Spanish");
  assert.equal(languageName("es-AR"), "Latin American Spanish");
  assert.equal(languageName("en"), "English");
  assert.equal(languageName("pt-BR"), "Brazilian Portuguese");
  assert.match(languageRule("es"), /^LANGUAGE RULE: The case language is Latin American Spanish./);
  assert.match(languageRule("es"), /translate the quotation faithfully into Latin American Spanish; never keep it in its original language/);
});

test("a described image reaches seats as text, not as an attachment", () => {
  const submission = { kind: "image" as const, mimeType: "image/png" };
  const describedContext = { title: "Imagen enviada", tool: "vision:openai/test", excerpt: "Descripción de la imagen:\nUn gráfico." };
  const described = composePrompt({ seat: "grok", docket: { submission, today: "hoy", submissionContext: describedContext }, record: [], instruction: "Analizá", attempt: 0 });
  assert.match(described, /not attached: a vision model described and transcribed it/);
  assert.match(described, /Un gráfico\./);
  const attached = composePrompt({ seat: "grok", docket: { submission, today: "hoy" }, record: [], instruction: "Analizá", attempt: 0 });
  assert.match(attached, /Submitted image \(attached\)\./);
});

test("the resolved language rule comes first in judge and analyst prompts", () => {
  for (const [language, name] of [["en", "English"], ["es", "Latin American Spanish"]] as const) {
    const docket = { submission: { kind: "text" as const, text: "A source in English" }, today: "today", language };
    for (const seat of ["judge", "grok"] as const) {
      const prompt = composePrompt({ seat, docket, record: [], instruction: "Analyze", attempt: 0 });
      assert.ok(prompt.startsWith(languageRule(language)));
      assert.match(prompt, new RegExp(`The case language is ${name}\\.`));
    }
  }
});
