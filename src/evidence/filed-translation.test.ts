import assert from "node:assert/strict";
import test from "node:test";
import type { StampedEvent } from "../court/turns.ts";
import { translateFiledEvidence } from "./translate.ts";

const filed: StampedEvent = { type: "evidence_filed", at: "2026-01-01T00:00:00.000Z", evidence: {
  id: "P1", by: "grok", claimId: "A1", title: "Relatório oficial", url: "https://example.test/report", excerpt: '"O investigado não entregou os documentos." [p.1]', stance: "opposes",
} };
const completed: StampedEvent = { type: "instruction_completed", at: "2026-01-01T00:00:01.000Z", by: "grok", searches: [] };

test("translates filed quotations and titles while preserving the original and attribution", async () => {
  assert.equal(filed.type, "evidence_filed");
  const events = await translateFiledEvidence([filed, completed], "es", async (input, language) => {
    assert.equal(language, "es");
    assert.equal(input.title, filed.evidence.title);
    assert.equal(input.body, filed.evidence.excerpt);
    return { changed: true, title: "Informe oficial", description: "", body: '"El investigado no entregó los documentos." [p.1]' };
  });
  assert.equal(events[0].type, "evidence_filed");
  assert.deepEqual(events[0].evidence, { ...filed.evidence, title: "Informe oficial", excerpt: '"El investigado no entregó los documentos." [p.1]', translation: { language: "es", original: { title: filed.evidence.title, excerpt: filed.evidence.excerpt } } });
  assert.deepEqual(events[1], completed);
  assert.equal(filed.evidence.title, "Relatório oficial", "input is not modified");
  assert.deepEqual(await translateFiledEvidence(events, "es", async () => { throw new Error("must not translate twice"); }), events);
});

test("passes through text already in the case language and supports translation to English", async () => {
  const events = await translateFiledEvidence([filed], "en", async (input, language) => {
    assert.equal(language, "en");
    return { changed: false, ...input, body: "ignored" };
  });
  assert.deepEqual(events, [filed]);
  const [translated] = await translateFiledEvidence([filed], "en", async (input, language) => {
    assert.equal(language, "en");
    return { ...input, changed: true, title: "Official report", body: '"The subject did not deliver the documents." [p.1]' };
  });
  assert.equal(translated.type, "evidence_filed");
  assert.equal(translated.evidence.translation?.language, "en");
  assert.match(translated.evidence.excerpt, /The subject/);
});

test("rejects failed or incomplete translations rather than losing evidence references", async () => {
  for (const body of ["", "Documentos sin marcador"]) {
    await assert.rejects(translateFiledEvidence([filed], "es", async (input) => ({ ...input, changed: true, title: "Informe", body })), /referencias/);
  }
  await assert.rejects(translateFiledEvidence([filed], "es", async () => { throw new Error("translator unavailable"); }), /translator unavailable/);
});
