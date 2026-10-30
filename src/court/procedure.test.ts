import { test } from "node:test";
import assert from "node:assert/strict";
import { project, type Counsel, type CourtEvent, type RecordedEvent } from "../domain/court.ts";
import { holdSession, type Bench } from "./procedure.ts";
import { conductTurn, type Converse, type Docket, type SeatId } from "./turns.ts";
import { toAiTools } from "./toolset.ts";

type Call = [tool: string, args: Record<string, unknown>];
type Script = (prompt: string, tools: string[]) => Call[];
type Result = { tool: string; isError: boolean; text: string };

const MODELS = { judge: "grok-4.7", counsel: { grok: "grok-4.7", gemini: "gemini-4-argon", claude: "claude-opus-5-5", openai: "gpt-5.5" } };
const DOCKET: Docket = { submission: { kind: "text", text: "CABA tiene más habitantes que Córdoba y la inflación de 2025 fue de un dígito." }, today: "27 de octubre de 2026" };

function makeBench(scripts: Record<SeatId, Script>, docket: Docket = DOCKET) {
  const results: Result[] = [];
  const prompts: Record<SeatId, string[]> = { judge: [], grok: [], gemini: [], claude: [], openai: [] };
  const events: RecordedEvent[] = [];
  const converse: Converse = async ({ seat, prompt, tools }) => {
    prompts[seat].push(prompt);
    const sdk = toAiTools(tools);
    for (const [name, args] of scripts[seat](prompt, Object.keys(tools))) {
      const out = await sdk[name].execute(args);
      const isError = typeof out === "object" && "error" in out;
      results.push({ tool: name, isError, text: typeof out === "string" ? out : out.error });
    }
  };
  const bench: Bench = {
    submission: docket.submission,
    models: MODELS,
    play: (spec, record, attempt) => conductTurn(docket, spec, record, attempt, converse),
    commit: async (batch) => void events.push(...batch),
  };
  return { bench, results, prompts, events };
}

const lastId = (prompt: string, prefix: string) => [...prompt.matchAll(new RegExp("\\[(" + prefix + "\\d+)\\]", "g"))].at(-1)?.[1];

function counsel(name: Counsel, votes: Record<string, string> | null): Script {
  return (prompt, tools) => {
    if (tools.includes("review_sources")) return [["review_sources", { votes: [{ sourceId: "S1", veto: false, reason: "Documento oficial con metodología publicada." }] }]];
    if (tools.includes("object")) return name === "claude" && /intervención I1 de/.test(prompt) ? [["object", { grounds: "La cifra citada no aparece en la fuente." }]] : [["pass", {}]];
    if (tools.includes("reply_objection")) return [["reply_objection", { text: "La cifra está en la tabla 3 del informe." }]];
    if (tools.includes("cast_votes")) {
      const statement: Call = ["make_statement", { text: "Mantengo mi evaluación según la evidencia.", evidenceIds: [] }];
      if (!votes) return [statement];
      return [statement, ["cast_votes", { votes: Object.entries(votes).map(([claimId, verdict]) => ({ claimId, verdict, rationale: "Según la evidencia del registro." })) }]];
    }
    if (tools.includes("make_statement")) {
      const p = lastId(prompt, "S") ?? "S1";
      if (name === "gemini" && /tu exposición inicial/.test(prompt)) {
        return [
          ["make_statement", { text: "Cito una evidencia que no está en el registro.", evidenceIds: ["P99"] }],
          ["make_statement", { text: "Cito la evidencia correcta del registro.", evidenceIds: [p] }],
        ];
      }
      return [["make_statement", { text: "Mi evaluación de las afirmaciones.", evidenceIds: [p] }]];
    }
    if (tools.includes("file_evidence") && name !== "claude")
      return [
        ["file_evidence", { claimId: "A1", title: "INDEC, Censo 2022", url: "https://www.indec.gob.ar/", excerpt: "Córdoba: 3.840.905 habitantes.", stance: "opposes" }],
        ["finish_instruction", { searches: ["A1", "A2"].map((claimId) => ({ claimId, supporting: "Busqué datos que respaldaran la afirmación; no encontré respaldo verificable.", opposing: "Busqué cifras oficiales que contradijeran la afirmación." })) }],
      ];
    return [];
  };
}

const judgeScript: Script = (prompt, tools) => {
  if (tools.includes("unify_evidence")) {
    const evidenceIds = [...new Set([...prompt.matchAll(/\[(P\d+)\]/g)].map((m) => m[1]))];
    return [["unify_evidence", { groups: evidenceIds.length ? [{ evidenceIds }] : [] }]];
  }
  if (tools.includes("enter_claims"))
    return [["enter_claims", { claims: [{ quote: "CABA tiene más habitantes", text: "La CABA tiene más habitantes que Córdoba." }, { quote: "", text: "La inflación de 2025 fue de un dígito." }] }]];
  if (tools.includes("rule")) return [["rule", { sustained: true, reason: "La evidencia no contiene la cifra." }]];
  if (tools.includes("decide")) return [["decide", { decisions: [{ claimId: "A2", verdict: "verdadero", reasoning: "La evidencia P2 del registro es la más directa." }] }]];
  return [];
};

test("a full session reaches consensus where 3 of 4 agree and sends a split to the judge", async () => {
  const { bench, results, prompts, events } = makeBench({
    judge: judgeScript,
    grok: counsel("grok", { A1: "falso", A2: "verdadero" }),
    gemini: counsel("gemini", { A1: "falso", A2: "falso" }),
    claude: counsel("claude", null),
    openai: counsel("openai", { A1: "falso", A2: "no_verificable" }),
  });
  await holdSession(bench);

  assert.equal(events[0].type, "session_opened");
  assert.equal(events.at(-1)?.type, "session_closed");
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1), "seq is contiguous");

  const view = project(events);
  assert.deepEqual(view.claims.map((c) => [c.id, c.judgment?.verdict, c.judgment?.method]), [
    ["A1", "falso", "consensus"],
    ["A2", "verdadero", "judge"],
  ]);
  assert.ok(view.struck.has("I1"), "sustained objection strikes the objected statement");

  const rejected = results.find((r) => r.isError && r.tool === "make_statement");
  assert.match(rejected?.text ?? "", /P99/, "citing evidence not in the record is rejected back to the model");

  const evidenceIds = events.flatMap((e) => (e.type === "evidence_filed" ? [e.evidence.id] : []));
  assert.deepEqual(evidenceIds.slice(0, 2), ["P1", "P2"], "evidence filed in parallel is numbered uniquely");
  assert.equal(new Set(evidenceIds).size, evidenceIds.length);

  assert.equal(prompts.claude.filter((p) => /tu conclusión/.test(p)).length, 2, "a missing vote gets one retry");
  assert.ok(events.some((e) => e.type === "absence" && e.by === "claude" && e.stage === "closing"), "a counsel that never votes is recorded as absent");
  assert.equal(events.filter((e) => e.type === "vote").length, 6);

  assert.equal(prompts.claude.filter((p) => /Etapa de instrucción:/.test(p)).length, 2, "an unfinished instruction gets one retry");
  assert.ok(events.some((e) => e.type === "absence" && e.by === "claude" && e.stage === "instruction"), "and is then recorded as absent from instruction");

  for (const p of prompts.grok) {
    assert.match(p, /Sos Grok, uno de los cuatro analistas/, "every turn carries the role brief");
    assert.match(p, /Registro del debate hasta ahora/, "and the record, since seats keep no memory");
  }
  assert.match(prompts.grok.at(-1)!, /\[I1\]/, "later turns see earlier statements");
});

test("a judge who never rules on an objection suspends the session instead of a ruling being invented", async () => {
  const silentJudge: Script = (prompt, tools) => (tools.includes("rule") ? [] : judgeScript(prompt, tools));
  const { bench, events } = makeBench({
    judge: silentJudge,
    grok: counsel("grok", null),
    gemini: counsel("gemini", null),
    claude: counsel("claude", null),
    openai: counsel("openai", null),
  });
  await assert.rejects(holdSession(bench), /no resolvió la objeción O1/);
  assert.ok(!events.some((e) => e.type === "ruling"), "no ruling is recorded in the judge's name");
});

test("the judge can dismiss a submission with no verifiable claims", async () => {
  const dismiss: Script = (_p, tools) => (tools.includes("dismiss_case") ? [["dismiss_case", { reason: "Es una opinión, no una afirmación fáctica." }]] : []);
  const { bench, events } = makeBench({ judge: dismiss, grok: () => [], gemini: () => [], claude: () => [], openai: () => [] });
  await holdSession(bench);
  assert.deepEqual(events.map((e) => e.type), ["session_opened", "dismissed", "session_closed"]);
});

test("instruction finishes before opening and only an absolute majority can annul a shared source", async (t) => {
  for (const [vetoCount, absent, excluded] of [
    [4, false, true], [3, false, true], [2, false, false], [1, false, false], [0, false, false], [2, true, false],
  ] as const) {
    await t.test(`${vetoCount} vetoes, absent=${absent}`, async () => {
      const names = ["grok", "gemini", "claude", "openai"] as const;
      const scripts = Object.fromEntries(names.map((name, i) => {
        const base = counsel(name === "claude" ? "grok" : name, { A1: "falso", A2: "falso" });
        const script: Script = (prompt, tools) => {
          if (tools.includes("review_sources")) return absent && name === "openai" ? [] : [["review_sources", { votes: [{ sourceId: "S1", veto: i < vetoCount, reason: "Evalué la autoría y la metodología de esta fuente." }] }]];
          if (tools.includes("make_statement")) return base(prompt, tools).map(([tool, input]) => tool === "make_statement" ? [tool, { ...input, evidenceIds: [] }] : [tool, input]);
          return base(prompt, tools);
        };
        return [name, script];
      })) as Record<Counsel, Script>;
      const { bench, events, prompts } = makeBench({ judge: judgeScript, ...scripts });
      await holdSession(bench);
      const source = project(events).sources.get("S1")!;
      assert.equal(source.excluded, excluded);
      assert.equal(source.contributions.length, 4, "deduplicated source retains all four authors");
      assert.equal(Object.keys(source.votes).length, absent ? 3 : 4);
      const unified = events.findIndex((e) => e.type === "evidence_unified");
      const closed = events.findIndex((e) => e.type === "instruction_closed");
      const opening = events.findIndex((e) => e.type === "floor_granted");
      assert.ok(unified < closed && closed < opening);
      assert.ok(events.filter((e) => e.type === "source_review_vote").every((e) => e.seq > events[unified].seq && e.seq < events[closed].seq));
      assert.ok(events.filter((e) => e.type === "evidence_filed").every((e) => e.seq < events[unified].seq));
      for (const name of names) {
        const prompt = prompts[name].find((p) => /Tenés la palabra para tu exposición inicial/.test(p))!;
        assert.match(prompt, excluded ? /\[S1\] ANULADA/ : /\[S1\] ADMITIDA/);
        for (const author of ["Grok", "Gemini", "Claude", "ChatGPT"]) assert.ok(prompt.includes("Aporte de " + author));
      }
      if (absent) {
        assert.equal(prompts.openai.filter((p) => /Turno de crítica de fuentes\./.test(p)).length, 2);
        assert.ok(events.some((e) => e.type === "absence" && e.by === "openai" && e.stage === "source_review"));
      }
    });
  }
});

test("an unfinished moderator unification blocks exposures rather than silently inventing a shared record", async () => {
  const silent: Script = (prompt, tools) => tools.includes("unify_evidence") ? [] : judgeScript(prompt, tools);
  const { bench, events, prompts } = makeBench({ judge: silent, grok: counsel("grok", null), gemini: counsel("gemini", null), claude: counsel("claude", null), openai: counsel("openai", null) });
  await assert.rejects(holdSession(bench), /no unificó las pruebas/);
  assert.equal(prompts.judge.filter((p) => /Unificá las pruebas de la instrucción con/.test(p)).length, 2);
  assert.ok(!events.some((e) => e.type === "floor_granted"));
});

test("instruction with no evidence records unsuccessful searches and shares an empty dossier", async () => {
  const script: Script = (_prompt, tools) => {
    if (tools.includes("finish_instruction")) return [["finish_instruction", { searches: ["A1", "A2"].map((claimId) => ({ claimId, supporting: "Busqué respaldo a favor sin encontrar documentos verificables.", opposing: "Busqué respaldo en contra sin encontrar documentos verificables." })) }]];
    if (tools.includes("object")) return [["pass", {}]];
    if (tools.includes("cast_votes")) return [
      ["make_statement", { text: "La evidencia no alcanza para verificar estas afirmaciones.", evidenceIds: [] }],
      ["cast_votes", { votes: ["A1", "A2"].map((claimId) => ({ claimId, verdict: "no_verificable", rationale: "No encontramos pruebas verificables en ninguno de los dos sentidos." })) }],
    ];
    if (tools.includes("make_statement")) return [["make_statement", { text: "No contamos con evidencia verificable sobre las afirmaciones.", evidenceIds: [] }]];
    return [];
  };
  const { bench, events, prompts } = makeBench({ judge: judgeScript, grok: script, gemini: script, claude: script, openai: script });
  await holdSession(bench);
  assert.equal(project(events).sources.size, 0);
  assert.equal(events.filter((e) => e.type === "instruction_completed").length, 4);
  assert.ok(!events.some((e) => e.type === "source_review_vote" || e.type === "absence"));
  assert.ok(project(events).claims.every((c) => c.judgment?.verdict === "no_verificable"));
  assert.ok(prompts.grok.some((p) => p.includes("Sin fuentes. No inventes evidencia")));
});

