import assert from "node:assert/strict";
import test from "node:test";
import { serializeEvidenceDocument } from "./okf.ts";
import { assembleWorkspace, citationAuthors, citationsFor, isVisibleInStage, isWritablePath } from "./workspace.ts";

const files = new Map<string, string>([
  ["evidence/base/docs/submission.md", "base"],
  ["evidence/grok/passage.md", "grok"],
  ["evidence/chatgpt/note.md", "peer"],
  ["scratch/notes.txt", "scratch"],
  ["outside.txt", "no"],
]);

test("hides peer namespaces until objections and keeps writes on the seat", () => {
  const exposicion = [...assembleWorkspace(files, "chatgpt", "exposicion").keys()].sort();
  assert.deepEqual(exposicion, ["evidence/base/docs/submission.md", "evidence/chatgpt/note.md", "scratch/notes.txt"]);
  assert.equal(isVisibleInStage("evidence/grok/passage.md", "chatgpt", "exposicion"), false);

  const objecion = assembleWorkspace(files, "chatgpt", "objecion");
  assert.equal(objecion.has("evidence/grok/passage.md"), true);
  assert.equal(objecion.has("outside.txt"), false);

  const conclusion = assembleWorkspace(files, "chatgpt", "conclusion");
  assert.equal(conclusion.has("evidence/grok/passage.md"), true);
  assert.equal(conclusion.has("outside.txt"), false);

  assert.equal(isWritablePath("evidence/chatgpt/note.md", "chatgpt"), true);
  assert.equal(isWritablePath("scratch/notes.txt", "chatgpt"), true);
  assert.equal(isWritablePath("evidence/grok/passage.md", "chatgpt"), false);
  assert.equal(isWritablePath("evidence/base/docs/submission.md", "chatgpt"), false);
  assert.deepEqual(citationAuthors("chatgpt", "exposicion"), ["base", "chatgpt"]);
  assert.ok(citationAuthors("chatgpt", "objecion").includes("grok"));
});

test("citations follow the stage allowlist", () => {
  const visible = new Map<string, string>([
    ["evidence/base/index.md", "# index"],
    ["evidence/grok/passage.md", serializeEvidenceDocument({
      type: "fragment",
      title: "Passage",
      description: "Neutral.",
      sources: ["evidence/base/raw/a.txt"],
      generated: { by: "grok", at: "2026-10-30T12:00:00.000Z" },
      page: 2,
    }, "[p.2] text")],
  ]);
  assert.deepEqual(citationsFor(visible, citationAuthors("chatgpt", "exposicion")), []);
  assert.deepEqual(citationsFor(visible, citationAuthors("chatgpt", "objecion")), ["/evidence/grok/passage.md#p2"]);
});
