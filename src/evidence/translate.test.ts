import assert from "node:assert/strict";
import test from "node:test";
import { serializeEvidenceDocument, parseEvidenceDocument } from "./okf.ts";
import { translatePromotedEvidence, translateSourceText } from "./translate.ts";
import { validateEvidenceTree } from "./validate.ts";

const original = serializeEvidenceDocument({ type: "fragment", title: "Report", description: "Evidence", sources: ["https://example.test"], generated: { by: "grok", at: "2026-01-01T00:00:00.000Z" }, page: 1 }, "[p.1] Hello [source](https://example.test).\n");

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
