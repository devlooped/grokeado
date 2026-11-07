import assert from "node:assert/strict";
import { test } from "node:test";
import { COUNSEL, type Counsel, type RecordedEvent, type Verdict } from "../domain/court.ts";
import { languageRule } from "../domain/language.ts";
import { holdQuickSession, QUICK_VOTE_REQUEST, quickPrompt, quickTiebreakPrompt, quickVoteMessages, type QuickAnswer, type QuickBench, type QuickDecision, type QuickEntry, type QuickFailure, type QuickVote } from "./quick.ts";

const MODELS = { judge: "spacexai/grok-4.7", counsel: { grok: "spacexai/grok-4.7", gemini: "google/gemini-4-argon", claude: "anthropic/claude-opus-5.5", chatgpt: "openai/gpt-6.1-sol" } };
const AT = "2026-11-07T12:00:00.000Z";

type Script = {
  answers?: Partial<Record<Counsel, Array<QuickAnswer | QuickFailure>>>;
  votes?: Partial<Record<Counsel, Array<QuickVote | QuickFailure>>>;
  tiebreak?: Array<QuickDecision | QuickFailure>;
};

function makeBench(script: Script) {
  const events: RecordedEvent[] = [];
  const calls: string[] = [];
  const retries: Array<{ by: Counsel; retry?: QuickFailure }> = [];
  const tiebreaks: QuickEntry[][] = [];
  const bench: QuickBench = {
    submission: { kind: "text", text: "Según el INDEC, la pobreza bajó al 31,6 % en el primer semestre de 2026.", check: "quick" },
    models: MODELS,
    answer: async (by, attempt) => {
      calls.push(`answer:${by}:${attempt}`);
      return script.answers?.[by]?.[attempt] ?? { text: "Respuesta de " + by, sources: [{ url: "https://www.indec.gob.ar/" + by }], at: AT };
    },
    vote: async (by, answer, attempt, retry) => {
      calls.push(`vote:${by}:${attempt}`);
      retries.push({ by, retry });
      assert.equal(answer.text.startsWith("Respuesta"), true);
      return script.votes?.[by]?.[attempt] ?? { verdict: "falso", rationale: "Fundamento suficiente del voto.", at: AT };
    },
    tiebreak: async (entries, attempt) => {
      calls.push(`tiebreak:${attempt}`);
      tiebreaks.push(entries);
      return script.tiebreak?.[attempt] ?? { verdict: "enganoso", reasoning: "Las respuestas muestran una cifra fuera de contexto.", at: AT };
    },
    commit: async (batch) => void events.push(...batch),
  };
  return { bench, events, calls, retries, tiebreaks };
}

const vote = (verdict: Verdict): QuickVote => ({ verdict, rationale: "Fundamento suficiente del voto.", at: AT });
const EXPERT_EVENTS = new Set(["claims_entered", "instruction_opened", "evidence_filed", "evidence_unified", "floor_granted", "statement", "objection", "vote", "judgment", "case_summary"]);

test("four agreeing votes give a consensus result without calling the moderator", async () => {
  const { bench, events, calls } = makeBench({});
  await holdQuickSession(bench);
  assert.deepEqual(events.map((e) => e.type), ["session_opened", ...COUNSEL.map(() => "quick_response"), ...COUNSEL.map(() => "content_vote"), "content_judgment", "session_closed"]);
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1));
  assert.deepEqual(events.filter((e) => e.type === "quick_response").map((e) => e.type === "quick_response" && e.by), [...COUNSEL]);
  const judgment = events.find((e) => e.type === "content_judgment");
  assert.deepEqual(judgment && { ...judgment, seq: 0, at: "" }, { type: "content_judgment", verdict: "falso", method: "consensus", reasoning: "", seq: 0, at: "" });
  assert.ok(!calls.some((c) => c.startsWith("tiebreak")));
  assert.ok(!events.some((e) => EXPERT_EVENTS.has(e.type)), "no Expert turn is played");
  const response = events.find((e) => e.type === "quick_response");
  assert.deepEqual(response?.type === "quick_response" && response.sources, [{ url: "https://www.indec.gob.ar/grok" }]);
});

test("a 2-2 split asks the moderator, who receives only the answers and votes", async () => {
  const { bench, events, tiebreaks } = makeBench({ votes: { grok: [vote("verdadero")], gemini: [vote("verdadero")] } });
  await holdQuickSession(bench);
  assert.equal(tiebreaks.length, 1);
  assert.deepEqual(tiebreaks[0], COUNSEL.map((by) => ({ by, answer: "Respuesta de " + by, vote: { verdict: by === "grok" || by === "gemini" ? "verdadero" : "falso", rationale: "Fundamento suficiente del voto." } })));
  const judgment = events.find((e) => e.type === "content_judgment");
  assert.equal(judgment?.type === "content_judgment" && judgment.method, "judge");
  assert.equal(judgment?.type === "content_judgment" && judgment.verdict, "enganoso");
  assert.equal(events.at(-1)?.type, "session_closed");
});

test("a moderator that fails twice fails the case", async () => {
  const { bench } = makeBench({ votes: { grok: [vote("verdadero")], gemini: [vote("verdadero")] }, tiebreak: [{ error: "timeout" }, { error: "timeout" }] });
  await assert.rejects(holdQuickSession(bench), /no desempató/);
});

test("a vote that does not parse, or is too short, is asked again once with the error", async () => {
  const { bench, events, retries } = makeBench({ votes: {
    grok: [{ error: "No object generated", text: "falso porque sí" }],
    gemini: [{ verdict: "falso", rationale: "corto", at: AT, text: "{\"verdict\":\"falso\",\"rationale\":\"corto\"}" }],
  } });
  await holdQuickSession(bench);
  assert.deepEqual(retries.filter((r) => r.by === "grok").map((r) => r.retry), [undefined, { error: "No object generated", text: "falso porque sí" }]);
  assert.deepEqual(retries.filter((r) => r.by === "gemini").map((r) => r.retry?.error), [undefined, "the rationale is too short"]);
  assert.equal(events.filter((e) => e.type === "content_vote").length, 4);
});

test("an answer that fails is tried once more; a seat whose answer fails twice is absent", async () => {
  const { bench, events, calls } = makeBench({ answers: { gemini: [{ error: "timeout" }], claude: [{ error: "timeout" }, { error: "gateway error" }] } });
  await holdQuickSession(bench);
  assert.deepEqual(calls.filter((c) => c.includes("gemini")), ["answer:gemini:0", "answer:gemini:1", "vote:gemini:0"]);
  assert.deepEqual(calls.filter((c) => c.includes("claude")), ["answer:claude:0", "answer:claude:1"]);
  assert.deepEqual(events.filter((e) => e.type === "quick_response").map((e) => e.type === "quick_response" && e.by), ["grok", "gemini", "chatgpt"]);
  assert.deepEqual(events.filter((e) => e.type === "absence").map((e) => e.type === "absence" && [e.by, e.stage]), [["claude", "content"]]);
  assert.equal(events.find((e) => e.type === "content_judgment")?.type === "content_judgment" && events.find((e) => e.type === "content_judgment")!.method, "consensus");
});

test("fewer than three votes fail the case, after recording the answers, votes and absences", async () => {
  const { bench, events, calls } = makeBench({
    answers: { claude: [{ error: "timeout" }, { error: "gateway error" }] },
    votes: { chatgpt: [{ error: "bad" }, { error: "bad again" }] },
  });
  await assert.rejects(holdQuickSession(bench), /Menos de tres analistas votaron.*Claude: gateway error.*ChatGPT: bad again/);
  assert.deepEqual(events.filter((e) => e.type === "quick_response").map((e) => e.type === "quick_response" && e.by), ["grok", "gemini", "chatgpt"], "a seat without a vote keeps its answer");
  assert.deepEqual(events.filter((e) => e.type === "absence").map((e) => e.type === "absence" && e.by), ["claude", "chatgpt"]);
  assert.equal(events.filter((e) => e.type === "content_vote").length, 2);
  assert.ok(!events.some((e) => e.type === "session_closed" || e.type === "content_judgment"));
  assert.ok(!calls.some((c) => c.startsWith("tiebreak")));
});

test("three votes without a majority go to the moderator", async () => {
  const { bench, events, tiebreaks } = makeBench({
    answers: { claude: [{ error: "timeout" }, { error: "timeout" }] },
    votes: { grok: [vote("verdadero")], gemini: [vote("no_verificable")] },
  });
  await holdQuickSession(bench);
  assert.equal(tiebreaks[0]!.find((e) => e.by === "claude")?.answer, undefined);
  assert.equal(events.find((e) => e.type === "content_judgment")?.type === "content_judgment" && events.find((e) => e.type === "content_judgment")!.seq, events.length - 1);
});

test("the prompt is FACT CHECK: and the content, with the language rule as the system prompt", () => {
  const text = quickPrompt({ kind: "text", text: "La pobreza bajó al 31,6 %." }, "es");
  assert.equal(text.system, languageRule("es"));
  assert.deepEqual(text.messages, [{ role: "user", content: "FACT CHECK: La pobreza bajó al 31,6 %." }]);

  const link = quickPrompt({ kind: "link", url: "https://example.com/nota", note: "¿Es cierto el dato del título?" }, "en");
  assert.equal(link.system, languageRule("en"));
  assert.deepEqual(link.messages, [{ role: "user", content: "FACT CHECK: https://example.com/nota\n¿Es cierto el dato del título?" }]);
  assert.deepEqual(quickPrompt({ kind: "link", url: "https://example.com/nota" }, "es").messages[0]!.content, "FACT CHECK: https://example.com/nota");

  const bytes = new Uint8Array([1, 2, 3]);
  const image = quickPrompt({ kind: "image", mimeType: "image/png", note: "La cifra del gráfico" }, "es", { bytes, mimeType: "image/png" });
  assert.deepEqual(image.messages, [{ role: "user", content: [
    { type: "text", text: "FACT CHECK:" },
    { type: "file", data: bytes, mediaType: "image/png" },
    { type: "text", text: "La cifra del gráfico" },
  ] }]);
  assert.throws(() => quickPrompt({ kind: "image", mimeType: "image/png" }, "es"), /needs the image/);
});

test("the vote continues the answer's conversation, and a retry shows the previous output and its error", () => {
  const prompt = quickPrompt({ kind: "text", text: "Dato a chequear." }, "es").messages;
  assert.deepEqual(quickVoteMessages(prompt, "Es falso."), [...prompt, { role: "assistant", content: "Es falso." }, { role: "user", content: QUICK_VOTE_REQUEST }]);
  const retried = quickVoteMessages(prompt, "Es falso.", { error: "No object generated", text: "falso" });
  assert.deepEqual(retried.slice(-2).map((m) => m.role), ["assistant", "user"]);
  assert.match(String(retried.at(-1)!.content), /No object generated/);
});

test("the tie-break prompt holds the content, each answer and vote, and no tools", () => {
  const { system, messages } = quickTiebreakPrompt({ kind: "text", text: "Dato a chequear." }, "es", [
    { by: "grok", answer: "Es falso.", vote: { verdict: "falso", rationale: "Otro dato." } },
    { by: "claude" },
  ]);
  assert.ok(system.startsWith(languageRule("es")));
  assert.match(system, /do not research/);
  const text = (messages[0]!.content as Array<{ type: string; text?: string }>).map((part) => part.text).join("\n");
  assert.match(text, /FACT CHECK: Dato a chequear\./);
  assert.match(text, /## Grok\nAnswer:\nEs falso\.\nVote: falso\. Otro dato\./);
  assert.match(text, /## Claude\nNo answer\.\nNo vote\./);
});
