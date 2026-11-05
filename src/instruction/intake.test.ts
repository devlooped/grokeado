import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MODELS } from "../court/models.ts";
import type { Submission } from "../domain/court.ts";
import { MemoryArtifactStore } from "../evidence/artifacts.ts";
import { collectInstruction } from "./intake.ts";
import { MemoryOperationRepository } from "./source-store.ts";
import { extractSource, SourceService, type SourceDependencies } from "./sources.ts";

function fixture(language: string) {
  const counts = { download: 0, describe: 0, detect: 0, translate: 0 };
  const artifacts = new MemoryArtifactStore();
  const sources: SourceDependencies = {
    operations: new MemoryOperationRepository(), artifacts, extract: extractSource,
    translatorModelId: "fixture/translator", translatorFingerprint: "fixture-v1",
    verifyLanguage: async () => ({ matches: true }),
    download: async (url) => { counts.download++; return { ok: true, bytes: new TextEncoder().encode("FOREIGN_SENTINEL 42"), finalUrl: url, contentType: "text/plain", redirects: 0 }; },
    translate: async (input) => {
      counts.translate++;
      return { title: input.title.replaceAll("FOREIGN_SENTINEL", language === "es" ? "Fuente canónica" : "Canonical source"), body: input.body.replaceAll("FOREIGN_SENTINEL", language === "es" ? "Texto canónico" : "Canonical text"), description: "", changed: true };
    },
  };
  const deps = { sources, artifacts, saveLanguage: async () => {},
    getImage: async () => ({ bytes: Buffer.from("RAW_IMAGE_SENTINEL"), mimeType: "image/png" }),
    describe: async () => { counts.describe++; return { text: "FOREIGN_SENTINEL 42", tool: "vision:fixture", confidence: 1 }; },
    detect: async () => { counts.detect++; return language; },
  };
  return { counts, deps };
}

for (const language of ["es", "en"]) for (const submission of [
  { kind: "text", text: "FOREIGN_SENTINEL 42" },
  { kind: "link", url: "https://example.test/report.txt", note: "FOREIGN_SENTINEL" },
  { kind: "image", mimeType: "image/png", note: "FOREIGN_SENTINEL" },
] satisfies Submission[]) test(`${language} ${submission.kind} intake exposes no originals and retries reuse collection/detection/normalization`, async () => {
  const { counts, deps } = fixture(language);
  const result = await collectInstruction("fixture", submission, DEFAULT_MODELS, false, deps);
  assert.equal(result.language, language);
  assert.doesNotMatch(JSON.stringify(result), /FOREIGN_SENTINEL|RAW_IMAGE_SENTINEL/);
  const before = { ...counts };
  assert.deepEqual(await collectInstruction("fixture", { ...submission, resolvedLanguage: language }, DEFAULT_MODELS, false, deps), result);
  assert.deepEqual(counts, before);
  if (submission.kind === "image") assert.equal(counts.describe, 1);
  if (submission.kind === "link") {
    const read = await new SourceService("fixture", language, deps.sources).read({ url: submission.url });
    assert.equal(read.status, "ready");
    assert.equal(counts.download, 1);
  }
});

test("failed image descriptions or translations fail closed, never attach the raw image", async () => {
  const { counts, deps } = fixture("es");
  deps.describe = async () => { counts.describe++; throw new Error("vision unavailable"); };
  const submission: Submission = { kind: "image", mimeType: "image/png" };
  await assert.rejects(collectInstruction("fixture", submission, DEFAULT_MODELS, false, deps), /uncertain/);
  await assert.rejects(collectInstruction("fixture", submission, DEFAULT_MODELS, false, deps), /uncertain/);
  assert.equal(counts.describe, 1);
  const second = fixture("en");
  second.deps.sources.translate = async () => { throw new Error("translation unavailable"); };
  await assert.rejects(collectInstruction("fixture", { kind: "text", text: "FOREIGN_SENTINEL" }, DEFAULT_MODELS, false, second.deps), /uncertain/);
});
