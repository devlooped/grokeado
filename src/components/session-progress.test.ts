import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CourtEvent } from "../domain/court.ts";
import { PROGRESS_STEPS, QUICK_PROGRESS_STEPS, quickStage, SessionProgress, sessionStage } from "./session-progress.tsx";

const claims: CourtEvent = { type: "claims_entered", claims: [{ id: "A1", quote: "q", text: "t" }, { id: "A2", quote: "r", text: "u" }] };

test("the stage is the furthest one the recorded events reached", () => {
  assert.equal(sessionStage([]), 0);
  assert.equal(sessionStage([{ type: "session_opened" }, claims, { type: "instruction_opened" }]), 0);
  assert.equal(sessionStage([claims, { type: "evidence_unified" }]), 1);
  assert.equal(sessionStage([{ type: "evidence_unified" }, { type: "statement" }]), 2);
  assert.equal(sessionStage([{ type: "statement" }, { type: "vote" }, { type: "absence" }]), 3);
});

test("the progress marks the current stage and says how many claims are under study", () => {
  const events: CourtEvent[] = [claims, { type: "evidence_unified", sources: [] }];
  const { document } = parseHTML(renderToStaticMarkup(createElement(SessionProgress, { events, queued: false })));
  const steps = [...document.querySelectorAll("ol li")];
  assert.equal(steps.length, PROGRESS_STEPS.length);
  assert.equal(steps.findIndex((li) => li.getAttribute("aria-current") === "step"), 1);
  assert.match(document.querySelector('[role="status"]')!.textContent, /Etapa 2 de 4: Crítica de fuentes/);
  assert.match(document.toString(), /2 afirmaciones en estudio/);
});

test("a Quick check shows two stages: the answers, then the result", () => {
  assert.equal(quickStage([{ type: "session_opened" }, { type: "quick_response" }]), 0);
  assert.equal(quickStage([{ type: "quick_response" }, { type: "content_vote" }]), 1);
  const { document } = parseHTML(renderToStaticMarkup(createElement(SessionProgress, { events: [{ type: "session_opened", judgeModel: "j", counselModels: { grok: "g", gemini: "m", claude: "c", chatgpt: "o" } }], queued: false, check: "quick" })));
  const steps = [...document.querySelectorAll("ol li")];
  assert.equal(steps.length, QUICK_PROGRESS_STEPS.length);
  assert.match(document.querySelector('[role="status"]')!.textContent, /Etapa 1 de 2: Respuestas/);
  assert.match(document.toString(), /Los analistas están respondiendo/);
  assert.doesNotMatch(document.toString(), /moderador está identificando/);
});

test("a queued case shows no current stage", () => {
  const { document } = parseHTML(renderToStaticMarkup(createElement(SessionProgress, { events: [], queued: true })));
  assert.equal(document.querySelector('[aria-current="step"]'), null);
  assert.match(document.toString(), /en espera/);
});
