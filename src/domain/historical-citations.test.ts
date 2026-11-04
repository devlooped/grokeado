import assert from "node:assert/strict";
import { test } from "node:test";
import { project, type CourtEvent, type RecordedEvent } from "./court.ts";
import { displayHistoricalCitations } from "./historical-citations.ts";

const stamp = (events: CourtEvent[]): RecordedEvent[] => events.map((e, i) => ({ ...e, seq: i + 1, at: "2026-01-01T00:00:00Z" }));

test("historical source references are rewritten consistently without changing recorded evidence", () => {
  const original = stamp([
    { type: "evidence_filed", evidence: { id: "P1", by: "grok", claimId: "A1", title: "S1 en el título original", url: "https://example.org/S1", excerpt: "S1 en el documento original." } },
    { type: "evidence_unified", sources: [{ id: "S1", url: "https://example.org/S1", title: "Documento S1", contributions: [] }] },
    { type: "source_review_vote", by: "grok", sourceId: "S1", veto: false, reason: "S1 es fiable." },
    { type: "source_decided", sourceId: "S1", excluded: false },
    { type: "statement", id: "I1", by: "grok", stage: "opening", text: "S1 y S99; https://example.org/S1 /evidence/grok/S1.md#p2.", evidenceIds: ["S1", "/evidence/grok/S1.md#p2"] },
    { type: "objection", id: "O1", by: "gemini", against: "I1", grounds: "S1 no dice eso." },
    { type: "objection_reply", objectionId: "O1", by: "grok", text: "S1 lo confirma." },
    { type: "ruling", objectionId: "O1", sustained: false, reason: "S1 es pertinente." },
    { type: "vote", by: "grok", claimId: "A1", verdict: "verdadero", rationale: "Según S1." },
    { type: "judgment", claimId: "A1", verdict: "verdadero", method: "judge", reasoning: "La fuente S1 respalda el resultado." },
    { type: "case_summary", text: "Resumen con S1." },
  ]);
  const snapshot = structuredClone(original);
  const { events, aliases } = displayHistoricalCitations(original);
  assert.deepEqual(original, snapshot);
  assert.equal(aliases.get("E1"), "S1");
  const source = project(events).sources.get("E1")!;
  assert.equal(source.excluded, false);
  assert.equal(source.votes.grok?.reason, "E1 es fiable.");
  assert.equal(source.title, "Documento S1");
  assert.equal(source.url, "https://example.org/S1");
  const statement = events.find((e) => e.type === "statement")!;
  assert.equal(statement.type, "statement");
  assert.equal(statement.text, "E1 y S99; https://example.org/S1 /evidence/grok/S1.md#p2.");
  assert.deepEqual(statement.evidenceIds, ["E1", "/evidence/grok/S1.md#p2"]);
  for (const event of events.slice(5)) assert.doesNotMatch(JSON.stringify(event), /S1/);
  assert.deepEqual(events[0], original[0]);
});

test("mixed historical and new identifiers never collide", () => {
  const source = (id: string) => ({ id, url: "https://example.org/" + id, title: id, contributions: [] });
  const events = stamp([{ type: "evidence_unified", sources: [source("S1"), source("E1"), source("S2"), source("S3")] }]);
  const converted = displayHistoricalCitations(events);
  const sources = [...project(converted.events).sources.keys()];
  assert.deepEqual(sources, ["E2", "E1", "E3", "E4"]);
  assert.equal(new Set(sources).size, sources.length);
  assert.deepEqual([...converted.aliases], [["E2", "S1"], ["E3", "S2"], ["E4", "S3"]]);
});
