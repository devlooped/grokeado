import assert from "node:assert/strict";
import test from "node:test";
import { cachePromptTranslations, localizePromptRecords, promptTranslationKey, type PromptTranslationCache } from "./prompt-translation.ts";

function memoryCache() {
  const entries = new Map<string, { language: string; source: string; translation: string; modelId: string }>();
  const cache: PromptTranslationCache = {
    get: async (keys) => new Map(keys.flatMap((key) => entries.has(key) ? [[key, entries.get(key)!.translation] as const] : [])),
    save: async ({ key, ...entry }) => { if (!entries.has(key)) entries.set(key, entry); },
  };
  return { cache, entries };
}

const prompt = (id: string, text: string) => ({ schemaVersion: 2, id, kind: "prompt", at: "2026-11-06T00:00:00.000Z", seat: "grok", phase: "debate", data: { sessionId: "s", channel: "decision", role: "task", text } });
const step = { schemaVersion: 2, id: "step:1", kind: "model_step", at: "2026-11-06T00:00:01.000Z", data: { usage: {} } };

test("prompt records are translated once into the case language and cached by source text", async () => {
  const { cache, entries } = memoryCache();
  const calls: string[] = [];
  const translate = async (text: string, language: string) => { calls.push(text); return `[${language}] ${text}`; };
  const audit = [prompt("prompt:1", "Cast your vote."), prompt("prompt:2", "Cast your vote."), step, prompt("prompt:3", "Write a summary.")];
  const localized = await localizePromptRecords(audit, "es", cache, translate, "fixture/translator");
  assert.deepEqual(calls, ["Cast your vote.", "Write a summary."], "identical prompts are translated once");
  assert.deepEqual(localized.map((record) => (record as { data: { text?: string } }).data.text), ["[es] Cast your vote.", "[es] Cast your vote.", undefined, "[es] Write a summary."]);
  assert.deepEqual(localized[2], step);
  assert.equal(entries.get(promptTranslationKey("Cast your vote.", "es"))?.source, "Cast your vote.");

  // Another case, or a rerun, reads the cache; a changed prompt has a new key.
  calls.length = 0;
  await localizePromptRecords([prompt("prompt:1", "Cast your vote."), prompt("prompt:4", "Cast your final vote.")], "es", cache, translate, "fixture/translator");
  assert.deepEqual(calls, ["Cast your final vote."]);
  assert.notEqual(promptTranslationKey("Cast your vote.", "es"), promptTranslationKey("Cast your final vote.", "es"));
  assert.notEqual(promptTranslationKey("Cast your vote.", "es"), promptTranslationKey("Cast your vote.", "pt-BR"));
});

test("an English case keeps its prompts, and warming the cache is bounded per step", async () => {
  const { cache, entries } = memoryCache();
  const translate = async (text: string) => `ES ${text}`;
  const audit = [prompt("prompt:1", "One."), prompt("prompt:2", "Two."), prompt("prompt:3", "Three.")];
  assert.deepEqual(await localizePromptRecords(audit, "en", cache, async () => { throw new Error("must not translate"); }, "fixture"), audit);
  assert.deepEqual(await cachePromptTranslations(audit, "es", cache, translate, "fixture", 2), { missing: 1 });
  assert.equal(entries.size, 2);
  assert.deepEqual(await cachePromptTranslations(audit, "es", cache, translate, "fixture", 2), { missing: 0 });
  assert.equal(entries.size, 3);
});

test("a failed translation leaves no prompt in English", async () => {
  const { cache } = memoryCache();
  await assert.rejects(localizePromptRecords([prompt("prompt:1", "One.")], "es", cache, async () => { throw new Error("translator unavailable"); }, "fixture"), /translator unavailable/);
});
