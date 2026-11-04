import assert from "node:assert/strict";
import test from "node:test";
import type { CourtEvent } from "../domain/court.ts";
import { saveContributedSources } from "./contributions.ts";

const event = (url: string): CourtEvent => ({ type: "evidence_filed", evidence: { id: "P1", by: "grok", claimId: "A1", title: "Source", url, excerpt: "An actual excerpt", stance: "supports" } });

test("downloads filed sources once, retaining original and labelled translation", async () => {
  const uploads: Map<string, Uint8Array | string>[] = [];
  const url = "https://example.test/report.txt";
  const original = new TextEncoder().encode("Hello world");
  await saveContributedSources("case", [event(url), event(url)], "es", {
    download: async () => ({ ok: true, bytes: original, contentType: "text/plain", finalUrl: url, redirects: 0 }),
    translate: async (text, language) => { assert.equal(text, "Hello world"); assert.equal(language, "es"); return { text: "Hola mundo", changed: true }; },
    write: async (_id, files) => { uploads.push(new Map(files)); },
  });
  assert.equal(uploads.length, 1);
  const files = uploads[0]!;
  const find = (suffix: string) => [...files].find(([path]) => path.endsWith(suffix))![1];
  assert.deepEqual(find("original.bin"), original);
  assert.equal(find("extracted.txt"), "Hello world");
  assert.equal(find("translated.txt"), "Hola mundo");
  const manifest = JSON.parse(find("source.json") as string);
  assert.equal(manifest.status, "translated");
  assert.equal(manifest.language, "es");
  assert.equal(manifest.originalExtension, "txt");
});

test("records a failed download instead of fabricating a translation", async () => {
  const files = new Map<string, Uint8Array | string>();
  await saveContributedSources("case", [event("https://example.test")], "en", {
    download: async () => ({ ok: false, error: "HTTP 403" }),
    translate: async () => { throw new Error("unexpected translation"); },
    write: async (_id, items) => { for (const [path, content] of items) files.set(path, content); },
  });
  assert.equal(JSON.parse([...files.values()][0] as string).status, "download_failed");
});

test("keeps same-language sources without a redundant translation and records unsupported formats", async () => {
  const uploads: Map<string, Uint8Array | string>[] = [];
  await saveContributedSources("case", [event("https://example.test/a.md"), event("https://example.test/b.bin")], "en", {
    download: async (url) => ({ ok: true, bytes: new TextEncoder().encode("English text"), contentType: "application/octet-stream", finalUrl: url, redirects: 0 }),
    translate: async (text) => ({ text, changed: false }),
    write: async (_id, files) => { uploads.push(new Map(files)); },
  });
  const manifest = (files: Map<string, Uint8Array | string>) => JSON.parse([...files].find(([path]) => path.endsWith("source.json"))![1] as string);
  assert.equal(manifest(uploads[0]!).status, "already_in_language");
  assert.equal([...uploads[0]!.keys()].some((path) => path.endsWith("translated.txt")), false);
  assert.equal(manifest(uploads[1]!).status, "extraction_unavailable");
});
