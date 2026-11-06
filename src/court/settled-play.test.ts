import assert from "node:assert/strict";
import test from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import { COUNSEL, project, type CaseRecord, type CourtEvent, type RecordedEvent } from "../domain/court.ts";
import { MemoryArtifactStore } from "../evidence/artifacts.ts";
import { buildCaseLog, parseCaseLog } from "../evidence/case-log.ts";
import { settleEvidence, loadSettledCorpus } from "../evidence/settled.ts";
import { MemoryOperationRepository } from "../instruction/source-store.ts";
import { SourceService, extractSource } from "../instruction/sources.ts";
import { mockResearchWorker } from "../instruction/mock.ts";
import { DEFAULT_MODELS, modelSnapshot } from "./models.ts";
import { createMockSeat } from "./mock.ts";
import { MemoryPhaseRepository } from "./phase-session.ts";
import { holdSession } from "./procedure.ts";
import { advanceSharedTurn, playSharedTurn } from "./settled-play.ts";

test("four independent source-backed analysts settle once, then every debate path is corpus-only and sessions continue", async () => {
  const artifacts = new MemoryArtifactStore(), operations = new MemoryOperationRepository(), repository = new MemoryPhaseRepository();
  const submission = { kind: "text" as const, text: "SIMULACIÓN LOCAL: afirmación para verificar.", resolvedLanguage: "es" };
  const stored: CaseRecord = { id: "fixture", createdAt: "2026-11-05T00:00:00.000Z", status: "in_session", pipelineVersion: 2, submission, models: modelSnapshot(DEFAULT_MODELS) };
  let downloads = 0, extraction = 0, translations = 0;
  const reader = () => new SourceService("fixture", "es", { operations, artifacts, translatorModelId: "fixture/translator", translatorFingerprint: "fixture-v1",
    verifyLanguage: async () => ({ matches: true }),
    download: async (url) => { downloads++; return { ok: true, finalUrl: url, redirects: 0, contentType: "text/plain", bytes: new TextEncoder().encode("SIMULACIÓN LOCAL: fuente ficticia, valor 42. " + url) }; },
    extract: async (...args) => { extraction++; return extractSource(...args); },
    translate: async (input) => { translations++; return { ...input, changed: false }; },
  });
  const events: RecordedEvent[] = [], audit: unknown[] = [];
  const requests: Array<{ phase: string; seat: string; prompt: unknown; tools: string[]; providerOptions: unknown }> = [];
  await holdSession({ submission, models: { judge: "fixture", counsel: Object.fromEntries(COUNSEL.map((seat) => [seat, "fixture"])) as Record<typeof COUNSEL[number], string> },
    commit: async (batch) => { events.push(...batch); },
    settle: (record) => settleEvidence("fixture", "es", record, reader(), artifacts),
    play: async (spec, record, attempt) => {
      const mock = createMockSeat({ spec, record, submission, shared: true }, false).model;
      let generations = 0;
      const model = new MockLanguageModelV4({ doGenerate: async (options) => {
        generations++;
        const phase = record.some((event) => event.type === "instruction_closed") ? "debate" : "instruction";
        requests.push({ phase, seat: "counsel" in spec ? spec.counsel : "judge", prompt: options.prompt, tools: (options.tools ?? []).map((tool) => tool.name), providerOptions: options.providerOptions });
        return mock.doGenerate(options);
      } });
      // The workflow runs each unit in a step of its own: never more than one generation.
      for (let prepared = false; ;) {
        const before = generations;
        const outcome = await advanceSharedTurn("fixture", { submission, today: "fixture", language: "es", models: DEFAULT_MODELS, simulated: true }, spec, record, attempt, {
          record: stored, reader: reader(), artifacts, repository, model, worker: mockResearchWorker,
          // Preparation takes two units: one still under way, one complete.
          prepare: async () => (prepared = !prepared) ? undefined : "SIMULACIÓN LOCAL: análisis preparatorio, no prueba.",
          audit: async (_id, _key, body) => { audit.push(body); }, activity: async (_id, body) => { audit.push(body); },
          prompt: async (_id, _key, body) => { audit.push(body); },
        }).catch(async (error) => { throw new Error(JSON.stringify((await operations.list("fixture")).filter((operation) => operation.status === "uncertain").map(({ stage, error }) => ({ stage, error }))), { cause: error }); });
        assert.ok(generations - before <= 1, "one decision generation per unit");
        if (outcome) return outcome;
      }
    },
  });
  assert.equal(events.at(-1)?.type, "session_closed");
  assert.equal(downloads, 3, "four analysts reuse the same three source acquisitions");
  assert.equal(extraction, 3);
  assert.equal(project(events).sources.size, 3);
  const corpus = await loadSettledCorpus("fixture", events, artifacts);
  assert.equal(corpus.documents.size, 2, "three vetoes exclude the unreliable fixture");
  for (const request of requests.filter((request) => request.phase === "debate")) {
    assert.ok(request.tools.includes("read_evidence"));
    assert.ok(!request.tools.some((name) => /web_|x_search|read_source|file_evidence/.test(name)));
    assert.doesNotMatch(JSON.stringify(request.prompt), /source_language|\/unreliable|instruction_completed|Fuente sin autor/);
    if (request.seat === "chatgpt") assert.match(JSON.stringify(request.providerOptions), /promptCacheKey/);
    if (request.seat === "claude") assert.match(JSON.stringify(request.prompt), /cacheControl/);
  }
  for (const seat of [...COUNSEL, "judge"]) {
    const state = repository.states.get(`fixture:debate:${seat}:decision`)?.body;
    assert.ok(state);
    assert.ok(Object.keys(state.turns).length > 1, "one persistent session per seat, not per intervention");
    assert.equal(state.activeTurn, undefined);
  }
  assert.ok(translations > 0);
  const log = parseCaseLog(buildCaseLog(events, audit, []));
  assert.equal(log.filter((record) => record.kind === "court_event").length, events.length);
  assert.ok(log.some((record) => record.kind === "model_step"));
  assert.ok(log.some((record) => record.kind === "tool_call"), "tool activity survives public case-log archival");
  // Every unit records the same prompt records again: buildCaseLog would reject a changed one.
  const prompts = log.filter((record) => record.kind === "prompt");
  for (const channel of ["preparation", "decision"]) {
    const system = prompts.filter((record) => record.data.role === "system" && record.data.channel === channel);
    assert.equal(new Set(system.map((record) => `${record.phase}:${record.seat}`)).size, system.length, "one system prompt per session");
    assert.ok(system.length >= 5 && system.every((record) => String(record.data.text).startsWith("LANGUAGE RULE: The case language is Latin American Spanish.")));
  }
  const tasks = prompts.filter((record) => record.data.role === "task");
  assert.ok(tasks.some((record) => /^Set the claims to examine\./.test(String(record.data.text))));
  assert.ok(tasks.every((record) => !String(record.data.text).startsWith("{")), "the task text leaves out the machine spec");
});

test("a retry after generation and court-action checkpoints reuses messages, actions, and the paid step", async () => {
  const artifacts = new MemoryArtifactStore(), operations = new MemoryOperationRepository(), repository = new MemoryPhaseRepository();
  const submission = { kind: "text" as const, text: "SIMULACIÓN LOCAL: afirmación para verificar.", resolvedLanguage: "es" };
  const record: CaseRecord = { id: "fixture", createdAt: "2026-11-05T00:00:00.000Z", status: "in_session", pipelineVersion: 2, submission, models: modelSnapshot(DEFAULT_MODELS) };
  const reader = new SourceService("fixture", "es", { operations, artifacts, extract: extractSource, translatorModelId: "fixture/translator", translatorFingerprint: "fixture-retry-v1", translate: async (input) => ({ ...input, changed: false }), verifyLanguage: async () => ({ matches: true }), download: async () => { throw new Error("No source acquisition is expected"); } });
  const spec = { kind: "intake" as const }, events: CourtEvent[] = [];
  const underlying = createMockSeat({ spec, record: events, submission, shared: true }, false).model;
  let generations = 0, interrupt = true;
  const model = new MockLanguageModelV4({ doGenerate: async (options) => { generations++; return underlying.doGenerate(options); } });
  const audit = new Map<string, unknown>();
  const deps = { record, reader, artifacts, repository, model, activity: async () => {}, prepare: async () => "Análisis de simulación.", audit: async (_caseId: string, key: string, body: unknown) => {
    if (audit.has(key)) assert.deepEqual(body, audit.get(key));
    audit.set(key, body);
    if (interrupt) { interrupt = false; throw new Error("Interrupted after durable generation before message checkpoint"); }
  } };
  const docket = { submission, today: "2026-11-05", language: "es", models: DEFAULT_MODELS, simulated: true };
  await assert.rejects(playSharedTurn("fixture", docket, spec, events, 0, deps), /Interrupted/);
  const outcome = await playSharedTurn("fixture", docket, spec, events, 0, deps);
  assert.equal(outcome.done, true);
  assert.equal(outcome.events.filter((event) => event.type === "claims_entered").length, 1);
  assert.equal(generations, 1);
  assert.equal(audit.size, 1);
  const state = repository.states.get("fixture:intake:judge:decision")!.body;
  const prefix = JSON.stringify(state.messages);
  assert.deepEqual(await playSharedTurn("fixture", docket, spec, events, 0, deps), outcome);
  assert.equal(JSON.stringify(repository.states.get("fixture:intake:judge:decision")!.body.messages), prefix);
  assert.equal(generations, 1);
});
