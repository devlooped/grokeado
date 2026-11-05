import { z } from "zod";
import MarkdownIt from "markdown-it";
import { COUNSEL, VERDICTS, type CourtEvent, type Evidence } from "../domain/court.ts";
import { planTurn, seatOf, type Docket, type StampedEvent, type TurnSpec } from "../court/turns.ts";
import { Rejection } from "../court/toolset.ts";
import { validateCorpusCitations, type SettledCorpus } from "../evidence/settled.ts";
import type { SourceService } from "./sources.ts";
import type { InstructionPhase } from "./authorization.ts";

const claim = z.string().regex(/^A[1-9]\d*$/);
const stance = z.enum(["supports", "opposes", "context"]);
const verdict = z.enum(VERDICTS);
const vote = z.object({ claimId: claim, verdict, rationale: z.string().min(10) }).strict();
export const CourtActionSchemas = {
  enter_claims: z.object({ claims: z.array(z.object({ quote: z.string(), text: z.string().min(10) }).strict()).min(1).max(5) }).strict(),
  dismiss_case: z.object({ reason: z.string().min(10) }).strict(),
  file_evidence: z.object({ sourceId: z.string().regex(/^src_[a-f0-9]{24}$/), blockIds: z.array(z.string().regex(/^p[1-9]\d*:b[1-9]\d*$/)).min(1).max(100), claimId: claim, stance, commentary: z.string().max(8000).optional() }).strict(),
  finish_instruction: z.object({ searches: z.array(z.object({ claimId: claim, supporting: z.string().min(10), opposing: z.string().min(10) }).strict()) }).strict(),
  unify_evidence: z.object({}).strict(),
  review_sources: z.object({ votes: z.array(z.object({ sourceId: z.string().regex(/^E[1-9]\d*$/), veto: z.boolean(), reason: z.string().min(10) }).strict()) }).strict(),
  make_statement: z.object({ text: z.string().min(20), evidenceIds: z.array(z.string()).max(100) }).strict(),
  object: z.object({ grounds: z.string().min(10) }).strict(), pass: z.object({}).strict(),
  reply_objection: z.object({ text: z.string().min(10) }).strict(),
  rule: z.object({ sustained: z.boolean(), reason: z.string().min(10) }).strict(),
  cast_votes: z.object({ votes: z.array(vote) }).strict(),
  decide: z.object({ decisions: z.array(z.object({ claimId: claim, verdict, reasoning: z.string().min(20) }).strict()) }).strict(),
  vote_content: z.object({ verdict: verdict.nullable(), rationale: z.string().min(10) }).strict(),
  decide_content: z.object({ verdict, reasoning: z.string().min(20) }).strict(),
  summarize_case: z.object({ text: z.string().min(20) }).strict(),
};
export type CourtAction = keyof typeof CourtActionSchemas;

export function turnPhase(spec: TurnSpec): InstructionPhase {
  if (spec.kind === "intake") return "intake";
  if (spec.kind === "instruction" || spec.kind === "unification") return "instruction";
  if (spec.kind === "source_review") return "criticism";
  return "debate";
}

export function phaseActions(phase: InstructionPhase, seat: string): CourtAction[] {
  if (phase === "intake") return ["enter_claims", "dismiss_case"];
  if (phase === "instruction") return seat === "judge" ? ["unify_evidence"] : ["file_evidence", "finish_instruction"];
  if (phase === "criticism") return ["review_sources"];
  return seat === "judge" ? ["rule", "decide", "decide_content", "summarize_case"] : ["make_statement", "object", "pass", "reply_objection", "cast_votes", "vote_content"];
}

const prose = new Set(["text", "quote", "reason", "grounds", "rationale", "reasoning", "supporting", "opposing", "commentary"]);

export async function normalizeCourtInput(value: unknown, reader: SourceService, key?: string): Promise<unknown> {
  if (typeof value === "string") return key && prose.has(key) ? (await reader.normalize("", value)).body : value;
  if (Array.isArray(value)) { const result = []; for (const child of value) result.push(await normalizeCourtInput(child, reader, key)); return result; }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(value)) result[name] = await normalizeCourtInput(child, reader, name);
    return result;
  }
  return value;
}

export function validateCourtText(corpus: SettledCorpus, value: unknown): void {
  if (typeof value === "string") {
    if (/(?:[a-z][a-z\d+.-]*:\/\/|\bwww\.)[^\s<>]+/i.test(value)) throw new Rejection("Citá únicamente las pruebas admitidas por su identificador E y sección, no enlaces externos.");
    const stack = [...new MarkdownIt({ html: false, linkify: false }).parse(value, {})];
    while (stack.length) {
      const token = stack.pop()!;
      if (token.children) stack.push(...token.children);
      const href = token.attrGet(token.type === "image" ? "src" : "href");
      if (href !== null) {
        if (typeof href !== "string") throw new Rejection("Referencia no válida.");
        validateCorpusCitations(corpus, [href]);
      }
    }
    const citations = value.match(/\/(?:evidence|instruction|discussion)\/[^\s),;]+|\b[ESP][1-9]\d*(?:#p\d+(?::b\d+)?)?/g) ?? [];
    validateCorpusCitations(corpus, citations);
  } else if (Array.isArray(value)) value.forEach((child) => validateCourtText(corpus, child));
  else if (value && typeof value === "object") Object.values(value).forEach((child) => validateCourtText(corpus, child));
}

export function modelFacingEvents(events: readonly CourtEvent[]): CourtEvent[] {
  // Audit-only originals never enter any participating model's context.
  return JSON.parse(JSON.stringify(events, (key, value) => key === "translation" || key === "original" ? undefined : value)) as CourtEvent[];
}

export function createCourtActions(docket: Docket, spec: TurnSpec, record: readonly CourtEvent[], reader: SourceService, corpus?: SettledCorpus) {
  const plan = planTurn(spec, record, docket.submission, [], Boolean(docket.submissionContext?.excerpt));
  const phase = turnPhase(spec);
  const run = async (name: CourtAction, raw: unknown): Promise<string | { error: string }> => {
    if (!phaseActions(phase, seatOf(spec)).includes(name) || !plan.tools[name]) return { error: "action_not_allowed_this_turn" };
    try {
      const input = CourtActionSchemas[name].parse(raw);
      let prepared = await normalizeCourtInput(input, reader);
      let reference: Pick<Evidence, "sourceId" | "blockIds" | "commentary"> | undefined;
      let citations: string[] | undefined;
      if (name === "file_evidence") {
        const filing = CourtActionSchemas.file_evidence.parse(prepared);
        const { source, blocks } = await reader.passages(filing.sourceId, filing.blockIds);
        const excerpt = blocks.map((block) => `[${block.id}] ${block.text}`).join("\n\n");
        if (excerpt.length > 30_000) throw new Rejection("El aporte debe seleccionar un pasaje más acotado.");
        prepared = { claimId: filing.claimId, stance: filing.stance, title: source.document.title, url: source.acquisition.finalUrl, excerpt };
        reference = { sourceId: source.sourceId, blockIds: filing.blockIds, ...(filing.commentary ? { commentary: filing.commentary } : {}) };
      } else if (name === "unify_evidence") {
        const contributions = record.flatMap((event) => event.type === "evidence_filed" ? [event.evidence] : []);
        const groups = new Map<string, string[]>();
        for (const contribution of contributions) {
          if (!contribution.sourceId) throw new Rejection("Falta la identidad canónica de un aporte.");
          if (!groups.has(contribution.sourceId)) groups.set(contribution.sourceId, []);
          groups.get(contribution.sourceId)!.push(contribution.id);
        }
        prepared = { groups: [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([, evidenceIds]) => ({ evidenceIds })) };
      }
      if (corpus) {
        validateCourtText(corpus, prepared);
        if (name === "make_statement") {
          const statement = CourtActionSchemas.make_statement.parse(prepared);
          citations = statement.evidenceIds;
          validateCorpusCitations(corpus, citations);
          prepared = { ...statement, evidenceIds: citations.map((citation) => /(?:^|\/)(E\d+)/.exec(citation)![1]!) };
        }
      }
      const actual = plan.tools[name]!;
      const accepted = actual.schema.parse(prepared);
      const first = plan.produced.length;
      const output = (actual.handle as (input: unknown) => string)(accepted);
      for (const event of plan.produced.slice(first)) {
        if (event.type === "evidence_filed" && reference) Object.assign(event.evidence, reference);
        if (event.type === "evidence_unified") for (const source of event.sources) source.sourceId = source.contributions[0]?.sourceId;
        if (event.type === "statement" && citations) event.evidenceIds = citations;
      }
      return (await reader.normalize("", output)).body;
    } catch (error) {
      if (error instanceof Rejection) return { error: (await reader.normalize("", error.message)).body };
      return { error: "court_action_unavailable" };
    }
  };
  return { plan, run, phase, seat: seatOf(spec), outcome: () => ({ events: plan.produced as StampedEvent[], done: plan.done() }) };
}
