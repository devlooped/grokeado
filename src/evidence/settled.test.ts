import assert from "node:assert/strict";
import test from "node:test";
import { COUNSEL, type CourtEvent, type RecordedEvent } from "../domain/court.ts";
import { MemoryOperationRepository } from "../instruction/source-store.ts";
import { extractSource, SourceService } from "../instruction/sources.ts";
import { MemoryArtifactStore } from "./artifacts.ts";
import { loadSettledCorpus, parseSettledDocument, readEvidence, settleEvidence, validateCorpusCitations } from "./settled.ts";
import { validateCourtText } from "../instruction/court-tools.ts";

const stamp = (events: CourtEvent[]): RecordedEvent[] => events.map((event, index) => ({ ...event, seq: index + 1, at: "2026-11-05T00:00:00.000Z" }));

async function fixture(vetoes = 0, body = "# Informe\n\nContenido canónico 42") {
  const artifacts = new MemoryArtifactStore();
  const counts = { download: 0, translate: 0 };
  const reader = new SourceService("fixture", "es", {
    operations: new MemoryOperationRepository(), artifacts, translatorModelId: "fixture/translator", translatorFingerprint: "fixture-v1",
    verifyLanguage: async () => ({ matches: true }),
    download: async (url) => { counts.download++; return { ok: true, bytes: new TextEncoder().encode(body), contentType: "text/plain", finalUrl: url, redirects: 0 }; },
    extract: extractSource, translate: async (input) => { counts.translate++; return { ...input, changed: false }; },
  });
  const result = await reader.read({ url: "https://example.test/report.txt" });
  assert.equal(result.status, "ready");
  const contribution = { id: "P1", by: "grok" as const, claimId: "A1", title: "Informe", url: "https://example.test/report.txt", excerpt: "Contenido canónico 42", sourceId: result.sourceId, blockIds: ["p1:b2"] };
  const events = stamp([
    { type: "claims_entered", claims: [{ id: "A1", text: "Afirmación en español", quote: "Cita en español" }] },
    { type: "evidence_filed", evidence: contribution },
    { type: "evidence_unified", sources: [{ id: "E1", title: "Informe", url: contribution.url, sourceId: result.sourceId, contributions: [contribution] }] },
    ...COUNSEL.map((by, index): CourtEvent => ({ type: "source_review_vote", by, sourceId: "E1", veto: index < vetoes, reason: "Motivo de la revisión" })),
    { type: "source_decided", sourceId: "E1", excluded: vetoes >= 3 },
  ]);
  return { artifacts, counts, reader, events };
}

for (const vetoes of [0, 1, 2, 3, 4]) test(`${vetoes} vetoes preserve the three-of-four rule during settlement`, async () => {
  const { artifacts, reader, events, counts } = await fixture(vetoes);
  const before = { ...counts };
  const event = await settleEvidence("fixture", "es", events, reader, artifacts);
  assert.deepEqual(counts, before, "settlement does no source processing");
  const committed = [...events, { ...event, seq: events.length + 1, at: events[0]!.at }];
  const corpus = await loadSettledCorpus("fixture", committed, artifacts);
  assert.equal(corpus.documents.size, vetoes < 3 ? 1 : 0);
  assert.deepEqual(await settleEvidence("fixture", "es", events, reader, artifacts), event);
  if (vetoes < 3) {
    assert.match(corpus.index, /^- \[E1 — /);
    assert.doesNotMatch(corpus.index, /Contenido/);
    const read = readEvidence(corpus, { id: "E1", blockIds: ["p1:b2"] });
    assert.equal(read.blocks[0]?.text, "Contenido canónico 42");
    validateCorpusCitations(corpus, ["E1", "E1#p1", "/evidence/E1.md#p1:b2"]);
  }
  for (const citation of ["E2", "S1", "P1", "E1#p999", "/evidence/grok/docs/draft.md", "/instruction/sources/original.bin"]) assert.throws(() => validateCorpusCitations(corpus, [citation]), /Citation/);
  assert.throws(() => readEvidence(corpus, { id: "../instruction/base/submission.json" }), { name: "ZodError" });
});

test("an empty source set and missing reviews are explicit valid corpora", async () => {
  const { artifacts, reader, events } = await fixture();
  const unreviewed = events.filter((event) => event.type !== "source_review_vote");
  const settled = await settleEvidence("fixture", "es", unreviewed, reader, artifacts);
  assert.ok(settled.manifestHash);
  const empty = new MemoryArtifactStore();
  const event = await settleEvidence("empty", "en", [], reader, empty);
  const corpus = await loadSettledCorpus("empty", stamp([event]), empty);
  assert.equal(corpus.documents.size, 0);
  assert.equal(corpus.index, "");
});

test("no uncommitted/partial manifest is readable and missing admitted artifacts block debate", async () => {
  const { artifacts, reader, events } = await fixture();
  const settled = await settleEvidence("fixture", "es", events, reader, artifacts);
  await assert.rejects(loadSettledCorpus("fixture", events, artifacts), /not been committed/);
  const read = artifacts.read.bind(artifacts);
  const broken = { write: artifacts.write.bind(artifacts), read: async (id: string) => { const files = await read(id); files.delete("evidence/E1.md"); return files; } };
  await assert.rejects(loadSettledCorpus("fixture", stamp([settled]), broken), /missing or changed/);
  const files = await artifacts.read("fixture");
  const source = new TextDecoder().decode(files.get("evidence/E1.md"));
  assert.equal(parseSettledDocument(source).metadata.id, "E1");
  assert.throws(() => parseSettledDocument(source + "changed"), /hash mismatch/);
  assert.throws(() => parseSettledDocument(source.replace("schemaVersion: 2", "schemaVersion: 2\nschemaVersion: 2")), /unique|map keys/i);
});

test("internal links cannot promote an excluded source or provisional draft as a dependency", async () => {
  for (const link of ["[excluded](E2.md)", "[draft](/instruction/base/submission.json)", "[unknown](#p99)", "![asset](../instruction/raw.png)"]) {
    const { artifacts, reader, events } = await fixture(0, link);
    await assert.rejects(settleEvidence("fixture", "es", events, reader, artifacts), /leaves admitted corpus/);
    assert.equal((await artifacts.read("fixture")).has("evidence/manifest.json"), false);
  }
});

test("settlement failure before manifest publication can retry without changing completed files", async () => {
  const { artifacts, reader, events } = await fixture();
  let fail = true;
  const store = { read: artifacts.read.bind(artifacts), write: async (id: string, files: Parameters<typeof artifacts.write>[1]) => {
    if (files.has("evidence/manifest.json") && fail) { fail = false; throw new Error("fixture interrupted publication"); }
    await artifacts.write(id, files);
  } };
  await assert.rejects(settleEvidence("fixture", "es", events, reader, store), /interrupted/);
  assert.equal((await artifacts.read("fixture")).has("evidence/manifest.json"), false);
  const event = await settleEvidence("fixture", "es", events, reader, store);
  assert.equal((await loadSettledCorpus("fixture", stamp([event]), store)).documents.size, 1);
});

test("every source-bearing court field rejects outside URLs and unadmitted Markdown links", async () => {
  const { artifacts, reader, events } = await fixture();
  const event = await settleEvidence("fixture", "es", events, reader, artifacts);
  const corpus = await loadSettledCorpus("fixture", stamp([event]), artifacts);
  for (const text of ["Fuente https://outside.test/report", "[reporte](https://outside.test/report)", "[antecedente](../instruction/base/submission.json)", "[borrador](draft.md)", "[contacto](mailto:outside@example.test)", "[original](/evidence/grok/docs/draft.md)", "Dato según S1", "Dato según E2"]) {
    for (const field of ["text", "grounds", "reason", "reasoning", "rationale"]) assert.throws(() => validateCourtText(corpus, { [field]: text }));
  }
  assert.doesNotThrow(() => validateCourtText(corpus, { text: "Dato de E1#p1, [pasaje](/evidence/E1.md#p1:b2)." }));
});
