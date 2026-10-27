import { test } from "node:test";
import assert from "node:assert/strict";
import { project, type Counsel, type CourtEvent, type RecordedEvent } from "../domain/court.ts";
import { holdSession, type Court } from "./procedure.ts";
import { toSdkTools, type Seat, type Toolset } from "./seat.ts";

type Call = [tool: string, args: Record<string, unknown>];
type Script = (prompt: string, tools: string[]) => Call[];

function scriptedSeat(script: Script, results: { tool: string; isError: boolean; text: string }[], sends: string[]): Seat {
  return {
    async send(prompt: string, tools: Toolset) {
      sends.push(prompt);
      const sdk = toSdkTools(tools);
      for (const [name, args] of script(prompt, Object.keys(tools))) {
        const out = (await sdk[name].execute(args as never, {})) as { isError?: boolean; content?: { text: string }[] } | string;
        const isError = typeof out === "object" && out.isError === true;
        results.push({ tool: name, isError, text: typeof out === "string" ? out : out.content?.[0]?.text ?? "" });
      }
    },
    async dispose() {},
  };
}

const lastId = (prompt: string, prefix: string) => [...prompt.matchAll(new RegExp("\\[(" + prefix + "\\d+)\\]", "g"))].at(-1)?.[1];

function counsel(name: Counsel, votes: Record<string, string> | null): Script {
  return (prompt, tools) => {
    if (tools.includes("object")) return name === "claude" && /intervención S1 de/.test(prompt) ? [["object", { grounds: "La cifra citada no aparece en la fuente." }]] : [["pass", {}]];
    if (tools.includes("reply_objection")) return [["reply_objection", { text: "La cifra está en la tabla 3 del informe." }]];
    if (tools.includes("cast_votes")) {
      const statement: Call = ["address_court", { text: "Mantengo mi evaluación según la prueba.", evidenceIds: [] }];
      if (!votes) return [statement];
      return [statement, ["cast_votes", { votes: Object.entries(votes).map(([claimId, verdict]) => ({ claimId, verdict, rationale: "Según la prueba del acta." })) }]];
    }
    if (tools.includes("address_court")) {
      const p = lastId(prompt, "P") ?? "P1";
      if (name === "gemini" && /apertura/.test(prompt)) {
        return [
          ["address_court", { text: "Cito una prueba que no existe en el acta.", evidenceIds: ["P99"] }],
          ["address_court", { text: "Cito la prueba correcta del acta.", evidenceIds: [p] }],
        ];
      }
      return [["address_court", { text: "Mi evaluación de las afirmaciones.", evidenceIds: [p] }]];
    }
    if (tools.includes("file_evidence") && name !== "claude")
      return [["file_evidence", { claimId: "A1", title: "INDEC, Censo 2022", url: "https://www.indec.gob.ar/", excerpt: "Córdoba: 3.840.905 habitantes." }]];
    return [];
  };
}

const judgeScript: Script = (_prompt, tools) => {
  if (tools.includes("enter_claims"))
    return [["enter_claims", { claims: [{ quote: "CABA tiene más habitantes", text: "La CABA tiene más habitantes que Córdoba." }, { quote: "", text: "La inflación de 2025 fue de un dígito." }] }]];
  if (tools.includes("rule")) return [["rule", { sustained: true, reason: "La prueba no contiene la cifra." }]];
  if (tools.includes("decide")) return [["decide", { decisions: [{ claimId: "A2", verdict: "verdadero", reasoning: "La prueba P2 del acta es la más directa." }] }]];
  return [];
};

test("a full session reaches consensus where 2 of 3 agree and sends a split to the judge", async () => {
  const results: { tool: string; isError: boolean; text: string }[] = [];
  const sends: Record<string, string[]> = { judge: [], grok: [], gemini: [], claude: [] };
  const court: Court = {
    judge: scriptedSeat(judgeScript, results, sends.judge),
    counsel: {
      grok: scriptedSeat(counsel("grok", { A1: "falso", A2: "verdadero" }), results, sends.grok),
      gemini: scriptedSeat(counsel("gemini", { A1: "falso", A2: "falso" }), results, sends.gemini),
      claude: scriptedSeat(counsel("claude", null), results, sends.claude),
    },
    judgeModel: "grok-4.7",
    counselModels: { grok: "grok-4.7", gemini: "gemini-4-argon", claude: "claude-opus-5-5" },
  };
  const events: RecordedEvent[] = [];
  await holdSession(court, {
    submission: { kind: "text", text: "CABA tiene más habitantes que Córdoba y la inflación de 2025 fue de un dígito." },
    images: [],
    today: "27 de octubre de 2026",
    record: (e: CourtEvent) => {
      const r = { ...e, seq: events.length + 1, at: new Date().toISOString() };
      events.push(r);
      return r;
    },
  });

  assert.equal(events[0].type, "session_opened");
  assert.equal(events.at(-1)?.type, "session_closed");

  const view = project(events);
  assert.deepEqual(view.claims.map((c) => [c.id, c.judgment?.verdict, c.judgment?.method]), [
    ["A1", "falso", "consensus"],
    ["A2", "verdadero", "judge"],
  ]);
  assert.ok(view.struck.has("S1"), "sustained objection strikes the objected statement");

  const rejected = results.find((r) => r.isError && r.tool === "address_court");
  assert.match(rejected?.text ?? "", /P99/, "citing evidence not in the record is rejected back to the model");

  assert.equal(sends.claude.filter((p) => /alegato final/.test(p)).length, 2, "a missing vote gets one retry");
  assert.ok(events.some((e) => e.type === "absence" && e.by === "claude" && e.stage === "closing"), "a counsel that never votes is recorded as absent");
  assert.equal(events.filter((e) => e.type === "vote").length, 4);

  assert.equal(sends.claude.filter((p) => /Etapa de instrucción/.test(p)).length, 2, "a counsel who files no evidence gets one retry");
  assert.ok(events.some((e) => e.type === "absence" && e.by === "claude" && e.stage === "discovery"), "and is then recorded as absent from discovery");

  assert.match(sends.grok[0], /Sos Grok, uno de los tres letrados/, "first turn carries the role brief");
  assert.doesNotMatch(sends.grok[1], /Sos Grok, uno de los tres letrados/, "later turns carry only the news");
});

test("a judge who never rules on an objection suspends the session instead of a ruling being invented", async () => {
  const silentJudge: Script = (prompt, tools) => (tools.includes("rule") ? [] : judgeScript(prompt, tools));
  const sink = { results: [] as { tool: string; isError: boolean; text: string }[], sends: [] as string[] };
  const seat = (s: Script) => scriptedSeat(s, sink.results, sink.sends);
  const events: CourtEvent[] = [];
  await assert.rejects(
    holdSession(
      {
        judge: seat(silentJudge),
        counsel: { grok: seat(counsel("grok", null)), gemini: seat(counsel("gemini", null)), claude: seat(counsel("claude", null)) },
        judgeModel: "j",
        counselModels: { grok: "a", gemini: "b", claude: "c" },
      },
      { submission: { kind: "text", text: "x".repeat(30) }, images: [], today: "hoy", record: (e) => (events.push(e), { ...e, seq: events.length, at: "" }) }
    ),
    /no resolvió la objeción O1/
  );
  assert.ok(!events.some((e) => e.type === "ruling"), "no ruling is recorded in the judge's name");
});

test("the judge can dismiss a submission with no verifiable claims", async () => {
  const noop: Seat = { send: async () => {}, dispose: async () => {} };
  const judge: Seat = {
    async send(_p, tools) {
      await toSdkTools(tools).dismiss_case.execute({ reason: "Es una opinión, no una afirmación fáctica." }, {});
    },
    dispose: async () => {},
  };
  const events: CourtEvent[] = [];
  await holdSession(
    { judge, counsel: { grok: noop, gemini: noop, claude: noop }, judgeModel: "j", counselModels: { grok: "a", gemini: "b", claude: "c" } },
    { submission: { kind: "text", text: "Messi es el mejor." }, images: [], today: "hoy", record: (e) => (events.push(e), { ...e, seq: events.length, at: "" }) }
  );
  assert.deepEqual(events.map((e) => e.type), ["session_opened", "dismissed", "session_closed"]);
});
