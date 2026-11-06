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
import { collectEvidence, fetchProposedUrls, proposedUrls, rejectionRecord } from "../instruction/collection.ts";
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

test("pipeline 3: analysts file URL and quote proposals, the host collects them without a unification turn, and criticism reads the index", async () => {
  const artifacts = new MemoryArtifactStore(), operations = new MemoryOperationRepository(), repository = new MemoryPhaseRepository();
  const submission = { kind: "text" as const, text: "SIMULACIÓN LOCAL: afirmación para verificar.", resolvedLanguage: "es" };
  const stored: CaseRecord = { id: "fixture", createdAt: "2026-11-05T00:00:00.000Z", status: "in_session", pipelineVersion: 3, submission, models: modelSnapshot(DEFAULT_MODELS) };
  let downloads = 0;
  const reader = () => new SourceService("fixture", "es", { operations, artifacts, translatorModelId: "fixture/translator", translatorFingerprint: "fixture-v1",
    verifyLanguage: async () => ({ matches: true }), extract: extractSource, translate: async (input) => ({ ...input, changed: false }),
    download: async (url) => { downloads++; return { ok: true, finalUrl: url, redirects: 0, contentType: "text/plain", bytes: new TextEncoder().encode("SIMULACIÓN LOCAL: Documento ficticio con datos 42, sin valor probatorio. " + url) }; },
  });
  const events: RecordedEvent[] = [], audit: unknown[] = [], played: string[] = [];
  const requests: Array<{ kind: string; prompt: string; tools: string[]; format?: string }> = [];
  await holdSession({ submission, models: { judge: "fixture", counsel: Object.fromEntries(COUNSEL.map((seat) => [seat, "fixture"])) as Record<typeof COUNSEL[number], string> },
    commit: async (batch) => { events.push(...batch); },
    settle: (record) => settleEvidence("fixture", "es", record, reader(), artifacts),
    collect: async (record) => {
      const fetched = await fetchProposedUrls(reader(), proposedUrls(record));
      const collected = await collectEvidence(record, fetched, reader());
      audit.push(...collected.rejected.map(rejectionRecord));
      return collected.events;
    },
    play: async (spec, record, attempt) => {
      played.push(spec.kind);
      const mock = createMockSeat({ spec, record, submission, shared: true, native: true }, false).model;
      const model = new MockLanguageModelV4({ doGenerate: async (options) => {
        requests.push({ kind: spec.kind, prompt: JSON.stringify(options.prompt), tools: (options.tools ?? []).map((tool) => tool.name), format: options.responseFormat?.type });
        return mock.doGenerate(options);
      } });
      return playSharedTurn("fixture", { submission, today: "fixture", language: "es", models: DEFAULT_MODELS, simulated: true }, spec, record, attempt, {
        record: stored, reader: reader(), artifacts, repository, model, worker: mockResearchWorker,
        prepare: async () => "SIMULACIÓN LOCAL: informe de investigación ficticio.",
        audit: async (_id, _key, body) => { audit.push(body); }, activity: async (_id, body) => { audit.push(body); },
        prompt: async (_id, _key, body) => { audit.push(body); },
      });
    },
  });
  assert.equal(events.at(-1)?.type, "session_closed");
  assert.ok(!played.includes("unification"), "the host collects in place of the moderator");
  assert.equal(events.filter((event) => event.type === "evidence_proposed").length, 12);
  assert.equal(events.filter((event) => event.type === "evidence_filed").length, 12);
  assert.equal(downloads, 3, "each proposed URL is fetched once");
  assert.equal(project(events).sources.size, 3);
  assert.equal((await loadSettledCorpus("fixture", events, artifacts)).documents.size, 2, "three vetoes exclude the unreliable fixture");
  const instruction = requests.filter((request) => request.kind === "instruction");
  assert.equal(instruction.length, 4, "each analyst files with one typed answer");
  for (const request of instruction) assert.deepEqual([request.tools, request.format], [[], "json"]);
  const reviews = requests.filter((request) => request.kind === "source_review");
  assert.ok(reviews.length && reviews.every((request) => request.tools.join() === "review_sources" && /E1 · [^]*E2 · [^]*E3 · /.test(request.prompt)));
  const preparation = repository.states.get("fixture:instruction:grok:preparation")?.body;
  assert.match(String(preparation?.tools), /"type":"provider"/, "pipeline 3 preparation holds the provider's tools");
  assert.ok(parseCaseLog(buildCaseLog(events, audit, [])).length > events.length);
});
test("pipeline 3: a typed filing that does not parse, or that the host rejects, is corrected after feedback in a step of its own", async () => {
  const artifacts = new MemoryArtifactStore(), operations = new MemoryOperationRepository(), repository = new MemoryPhaseRepository();
  const submission = { kind: "text" as const, text: "SIMULACIÓN LOCAL: afirmación para verificar.", resolvedLanguage: "es" };
  const stored: CaseRecord = { id: "fixture", createdAt: "2026-11-05T00:00:00.000Z", status: "in_session", pipelineVersion: 3, submission, models: modelSnapshot(DEFAULT_MODELS) };
  const reader = new SourceService("fixture", "es", { operations, artifacts, extract: extractSource, translatorModelId: "fixture/translator", translatorFingerprint: "fixture-typed-v1", translate: async (input) => ({ ...input, changed: false }), verifyLanguage: async () => ({ matches: true }), download: async () => { throw new Error("No source acquisition is expected"); } });
  const record = [{ type: "claims_entered", claims: [{ id: "A1", quote: "", text: "SIMULACIÓN LOCAL: afirmación." }], seq: 1, at: "2026-11-05T00:00:00.000Z" }] as RecordedEvent[];
  const proposal = { claimId: "A1", url: "https://example.org/report", quote: "The report states the figure verbatim.", stance: "supports", commentary: "" };
  const answers = [
    "Here is my filing: sources below.",
    JSON.stringify({ proposals: [proposal], searches: { A1: { supporting: "Busqué a favor.", opposing: "corta" } } }),
    JSON.stringify({ proposals: [proposal, { ...proposal, quote: "short" }], searches: { A1: { supporting: "Busqué a favor en fuentes oficiales.", opposing: "Busqué en contra en medios establecidos." } } }),
  ];
  const prompts: string[] = [];
  const model = new MockLanguageModelV4({ doGenerate: async (options) => {
    assert.equal(options.responseFormat?.type, "json");
    assert.equal(options.tools, undefined);
    prompts.push(JSON.stringify(options.prompt));
    return { content: [{ type: "text" as const, text: answers[prompts.length - 1]! }], finishReason: { unified: "stop" as const, raw: undefined },
      usage: { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } }, warnings: [] };
  } });
  const audit: Array<{ kind: string; data: { toolCalls?: Array<{ toolName: string }> } }> = [];
  const deps = { record: stored, reader, artifacts, repository, model, prepare: async () => "Informe de investigación.", activity: async () => {}, audit: async (_caseId: string, _key: string, body: unknown) => { audit.push(body as typeof audit[number]); } };
  const docket = { submission, today: "2026-11-05", language: "es", models: DEFAULT_MODELS, simulated: true };
  const spec = { kind: "instruction" as const, counsel: "grok" as const };
  let units = 0, outcome;
  while (!(outcome = await advanceSharedTurn("fixture", docket, spec, record, 0, deps))) units++;
  assert.equal(prompts.length, 3);
  assert.ok(units >= 5, "every generation and every filing runs in a unit of its own");
  assert.match(prompts[1]!, /did not match the filing format/);
  assert.match(prompts[2]!, /could not file your answer: searches\.0\.opposing: /);
  assert.equal(outcome.done, true);
  assert.deepEqual(outcome.events.map((event) => event.type), ["evidence_proposed", "instruction_completed"]);
  assert.deepEqual(audit.filter((body) => body.kind === "model_step").map((body) => body.data.toolCalls?.map((call) => call.toolName)), [[], ["file_instruction"], ["file_instruction"]]);
  const bytes = [...(await artifacts.read("fixture")).entries()].find(([path]) => path.endsWith("decision-2/filing.json"))![1];
  const filing = JSON.parse(typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes));
  assert.deepEqual(filing.dropped.map((entry: { reason: string }) => entry.reason.split(":")[0]), ["quote"]);
});

