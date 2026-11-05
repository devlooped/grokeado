import assert from "node:assert/strict";
import test from "node:test";
import { MemoryArtifactStore, normalizeArtifactBytes } from "./artifacts.ts";

test("new artifacts are write-once across every namespace and generic writer", async () => {
  const store = new MemoryArtifactStore();
  for (const path of ["instruction/sources/src_a/original.bin", "evidence/E1.md", "discussion/grok/run/draft.md", "case.jsonl"]) {
    await store.write("fixture", new Map([[path, "original"]]));
    await store.write("fixture", new Map([[path, "original"]]));
    await assert.rejects(store.write("fixture", new Map([[path, "changed"]])), /Immutable artifact conflict/);
  }
  const files = await store.read("fixture");
  files.get("evidence/E1.md")![0] = 0;
  assert.equal(new TextDecoder().decode((await store.read("fixture")).get("evidence/E1.md")), "original");
});

test("artifact paths reject traversal, private checkpoints, hash spoofing, and legacy root logs", () => {
  for (const path of ["acta.jsonl", "transcript.jsonl", "phase-sessions/a.json", "instruction/../evidence/E1.md", "instruction//a", "evidence/./a", "evidence/.sha256/fake.json", "discussion/a\\b", "evidence/E1.md\0", "C:/evidence/E1.md"]) assert.throws(() => normalizeArtifactBytes(path, "x"));
});
