import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { COUNSEL, type CourtEvent } from "../domain/court.ts";
import { saveContributedSources } from "../evidence/contributions.ts";

test("sanitized AT-185-GA fixture preserves manifest multiplicities, not alleged network calls", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/at-185-ga.json", import.meta.url), "utf8"));
  assert.equal(fixture.groups.length, 30);
  assert.equal(new Set(fixture.groups.map((group: { url: string }) => group.url)).size, 30);
  assert.equal(fixture.groups.reduce((sum: number, group: { manifests: number }) => sum + group.manifests, 0), 63);
  assert.equal(fixture.manifestCount - fixture.exactUrlCount, 33);
  assert.equal(fixture.excessManifests, 33);
  const repeated = fixture.groups.filter((group: { manifests: number }) => group.manifests > 1);
  assert.equal(repeated.length, 9);
  assert.equal(repeated.reduce((sum: number, group: { manifests: number }) => sum + group.manifests, 0), 42);
  assert.deepEqual(fixture.manifestStatuses, { translated: 47, already_in_language: 11, translation_failed: 5 });
  for (const group of fixture.groups) assert.equal(new URL(group.url).hostname, "example.test");
});

test("legacy baseline repeats processing across analysts and workflow retries", async () => {
  const url = "https://example.test/shared.txt";
  let downloads = 0;
  let translations = 0;
  const deps = {
    download: async () => {
      downloads++;
      return { ok: true as const, bytes: new TextEncoder().encode("Sanitized English fixture"), contentType: "text/plain", finalUrl: url, redirects: 0 };
    },
    translate: async () => { translations++; return { text: "Ejemplo saneado", changed: true }; },
    write: async () => {},
  };
  const events: CourtEvent[] = COUNSEL.map((by, index) => ({
    type: "evidence_filed", evidence: { id: `P${index + 1}`, by, claimId: "A1", title: "Fixture", url, excerpt: "Sanitized English fixture" },
  }));
  for (let attempt = 0; attempt < 2; attempt++) {
    await Promise.all(events.map((event) => saveContributedSources("fixture", [event, event], "es", deps)));
  }
  assert.equal(downloads, 8);
  assert.equal(translations, 8);
});
