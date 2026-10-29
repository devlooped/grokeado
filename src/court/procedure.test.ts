import { test } from "node:test";
import assert from "node:assert/strict";
import { project, type Counsel, type CourtEvent, type RecordedEvent } from "../domain/court.ts";
import { holdSession, type Bench } from "./procedure.ts";
import { conductTurn, type Converse, type Docket, type SeatId } from "./turns.ts";
import { toSdkTools } from "./toolset.ts";

type Call = [tool: string, args: Record<string, unknown>];
type Script = (prompt: string, tools: string[]) => Call[];
type Result = { tool: string; isError: boolean; text: string };

const MODELS = { judge: "grok-4.7", counsel: { grok: "grok-4.7", gemini: "gemini-4-argon", claude: "claude-opus-5-5" } };
const DOCKET: Docket = { submission: { kind: "text", text: "CABA tiene más habitantes que Córdoba y la inflación de 2025 fue de un dígito." }, today: "27 de octubre de 2026" };

function makeBench(scripts: Record<SeatId, Script>, docket: Docket = DOCKET) {
  const results: Result[] = [];
  const prompts: Record<SeatId, string[]> = { judge: [], grok: [], gemini: [], claude: [] };
  const events: RecordedEvent[] = [];
  const converse: Converse = async ({ seat, prompt, tools }) => {
    prompts[seat].push(prompt);
    const sdk = toSdkTools(tools);
    for (const [name, args] of scripts[seat](prompt, Object.keys(tools))) {
      const out = (await sdk[name].execute(args as never, {})) as { isError?: boolean; content?: { text: string }[] } | string;
      const isError = typeof out === "object" && out.isError === true;
      results.push({ tool: name, isError, text: typeof out === "string" ? out : out.content?.[0]?.text ?? "" });
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
    if (tools.includes("object")) return name === "claude" && /intervención I1 de/.test(prompt) ? [["object", { grounds: "La cifra citada no aparece en la fuente." }]] : [["pass", {}]];
    if (tools.includes("reply_objection")) return [["reply_objection", { text: "La cifra está en la tabla 3 del informe." }]];
    if (tools.includes("cast_votes")) {
      const statement: Call = ["make_statement", { text: "Mantengo mi evaluación según la evidencia.", evidenceIds: [] }];
      if (!votes) return [statement];
      return [statement, ["cast_votes", { votes: Object.entries(votes).map(([claimId, verdict]) => ({ claimId, verdict, rationale: "Según la evidencia del registro." })) }]];
    }
    if (tools.includes("make_statement")) {
      const p = lastId(prompt, "P") ?? "P1";
      if (name === "gemini" && /tu exposición inicial/.test(prompt)) {
        return [
          ["make_statement", { text: "Cito una evidencia que no está en el registro.", evidenceIds: ["P99"] }],
          ["make_statement", { text: "Cito la evidencia correcta del registro.", evidenceIds: [p] }],
        ];
      }
      return [["make_statement", { text: "Mi evaluación de las afirmaciones.", evidenceIds: [p] }]];
    }
    if (tools.includes("file_evidence") && name !== "claude")
      return [["file_evidence", { claimId: "A1", title: "INDEC, Censo 2022", url: "https://www.indec.gob.ar/", excerpt: "Córdoba: 3.840.905 habitantes." }]];
    return [];
  };
}

const judgeScript: Script = (_prompt, tools) => {
  if (tools.includes("enter_claims"))
    return [["enter_claims", { claims: [{ quote: "CABA tiene más habitantes", text: "La CABA tiene más habitantes que Córdoba." }, { quote: "", text: "La inflación de 2025 fue de un dígito." }] }]];
  if (tools.includes("rule")) return [["rule", { sustained: true, reason: "La evidencia no contiene la cifra." }]];
  if (tools.includes("decide")) return [["decide", { decisions: [{ claimId: "A2", verdict: "verdadero", reasoning: "La evidencia P2 del registro es la más directa." }] }]];
  return [];
};

test("a full session reaches consensus where 2 of 3 agree and sends a split to the judge", async () => {
  const { bench, results, prompts, events } = makeBench({
    judge: judgeScript,
    grok: counsel("grok", { A1: "falso", A2: "verdadero" }),
    gemini: counsel("gemini", { A1: "falso", A2: "falso" }),
    claude: counsel("claude", null),
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
  assert.equal(events.filter((e) => e.type === "vote").length, 4);

  assert.equal(prompts.claude.filter((p) => /Etapa de investigación/.test(p)).length, 2, "a counsel who files no evidence gets one retry");
  assert.ok(events.some((e) => e.type === "absence" && e.by === "claude" && e.stage === "discovery"), "and is then recorded as absent from discovery");

  for (const p of prompts.grok) {
    assert.match(p, /Sos Grok, uno de los tres analistas/, "every turn carries the role brief");
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
  });
  await assert.rejects(holdSession(bench), /no resolvió la objeción O1/);
  assert.ok(!events.some((e) => e.type === "ruling"), "no ruling is recorded in the judge's name");
});

test("the judge can dismiss a submission with no verifiable claims", async () => {
  const dismiss: Script = (_p, tools) => (tools.includes("dismiss_case") ? [["dismiss_case", { reason: "Es una opinión, no una afirmación fáctica." }]] : []);
  const { bench, events } = makeBench({ judge: dismiss, grok: () => [], gemini: () => [], claude: () => [] });
  await holdSession(bench);
  assert.deepEqual(events.map((e) => e.type), ["session_opened", "dismissed", "session_closed"]);
});

