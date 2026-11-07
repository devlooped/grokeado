import assert from "node:assert/strict";
import test from "node:test";
import { courtModel } from "../court/models.ts";
import type { researchWorker } from "./research.ts";
import { sourceDownloader } from "./research.ts";

const model = courtModel("spacexai/grok-4.7", null);
const post = "https://x.com/Migraciones_AR/status/2115308014546657747";
const answer = (text: string, urls: string[]): typeof researchWorker => async () => ({ text, modelId: model.id, usage: undefined as never,
  sources: urls.map((url, index) => ({ type: "source" as const, sourceType: "url" as const, id: "s" + index, url })) });

test("an X post is read when the X search cites it and returns its text", async () => {
  const result = await sourceDownloader(model, undefined, answer("Texto del post", [post]))(post);
  assert.equal(result.ok, true);
  assert.equal(result.ok && new TextDecoder().decode(result.bytes), "Texto del post");
});

test("an unread X post says which check failed", async () => {
  const other = "https://x.com/i/status/2115308014546657747";
  assert.deepEqual(await sourceDownloader(model, undefined, answer("Texto", [other]))(post),
    { ok: false, error: "X post content unavailable: the X search did not cite this post (cited " + other + ")" });
  assert.deepEqual(await sourceDownloader(model, undefined, answer("Texto", []))(post),
    { ok: false, error: "X post content unavailable: the X search did not cite this post (no sources cited)" });
  assert.deepEqual(await sourceDownloader(model, undefined, answer("  ", [post]))(post),
    { ok: false, error: "X post content unavailable: the X search returned no text" });
});
