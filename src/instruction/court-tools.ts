import { z } from "zod";
import MarkdownIt from "markdown-it";
import { COUNSEL, VERDICTS, project, type CourtEvent, type Evidence } from "../domain/court.ts";
import { planTurn, seatOf, type Docket, type StampedEvent, type TurnSpec } from "../court/turns.ts";
import { Rejection } from "../court/toolset.ts";
import { validateCorpusCitations, type SettledCorpus } from "../evidence/settled.ts";
import { normalizeOrKeep, type SourceService } from "./sources.ts";
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
  file_instruction: z.object({
    proposals: z.array(z.object({ claimId: claim, url: z.url(), quote: z.string().min(20).max(4000), stance, commentary: z.string().max(8000).optional() }).strict()).max(60),
    searches: z.array(z.object({ claimId: claim, supporting: z.string().min(10), opposing: z.string().min(10) }).strict()),
  }).strict(),
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

// native: pipeline 3, where an analyst files URL + quote proposals at once.
export function phaseActions(phase: InstructionPhase, seat: string, native = false): CourtAction[] {
  if (phase === "intake") return ["enter_claims", "dismiss_case"];
  if (phase === "instruction") return seat === "judge" ? ["unify_evidence"] : native ? ["file_instruction"] : ["file_evidence", "finish_instruction"];
  if (phase === "criticism") return ["review_sources"];
  return seat === "judge" ? ["rule", "decide", "decide_content", "summarize_case"] : ["make_statement", "object", "pass", "reply_objection", "cast_votes", "vote_content"];
}

// Pipeline 3 files its instruction as the typed answer of the decision call,
// not as a tool call, so a seat cannot answer without filing. The schema keeps
// to what the structured output of every provider accepts (no lengths, formats
// or optional fields); the host checks the rest when it files.
export function instructionFilingSchema(claimIds: readonly string[]) {
  if (!claimIds.length) throw new Error("An instruction filing needs the claims of the case");
  const claimId = z.enum(claimIds as [string, ...string[]]).describe("The claim the source refers to");
  const search = z.object({
    supporting: z.string().describe("What you searched for in favor of the claim, and what you found"),
    opposing: z.string().describe("What you searched for against the claim, and what you found"),
  }).strict();
  return z.object({
    proposals: z.array(z.object({
      claimId,
      url: z.string().describe("The exact URL of the page, as your search found it"),
      quote: z.string().describe("A passage of 20 to 4000 characters copied verbatim from that page, in the page's own language; mark omitted text with …"),
      stance: stance.describe("supports: in favor; opposes: against; context: context that neither confirms nor refutes"),
      commentary: z.string().describe("At most one short sentence on what the passage shows, or an empty string; no assessment of the source or of the claim"),
    }).strict()).describe("One proposal per quoted passage, at most 60"),
    searches: z.object(Object.fromEntries(claimIds.map((id) => [id, search]))).strict().describe("For each claim, what you searched for in both directions"),
  }).strict();
}

export type InstructionFilingOutput = {
  proposals: Array<{ claimId: string; url: string; quote: string; stance: string; commentary: string }>;
  searches: Record<string, { supporting: string; opposing: string }>;
};
export type DroppedProposal = { proposal: InstructionFilingOutput["proposals"][number]; reason: string };

const MAX_PROPOSALS = 60;
const proposalInput = CourtActionSchemas.file_instruction.shape.proposals.element;

// The file_instruction input of a typed filing. A proposal file_instruction
// would reject is dropped on its own, with its reason: one invalid proposal
// does not lose the others.
export function instructionFiling(output: InstructionFilingOutput): { input: z.input<typeof CourtActionSchemas.file_instruction>; dropped: DroppedProposal[] } {
  const proposals: z.infer<typeof proposalInput>[] = [], dropped: DroppedProposal[] = [];
  for (const proposal of output.proposals) {
    const { commentary, ...rest } = proposal;
    const parsed = proposalInput.safeParse(commentary.trim() ? { ...rest, commentary: commentary.trim() } : rest);
    if (!parsed.success) dropped.push({ proposal, reason: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") });
    else if (proposals.length >= MAX_PROPOSALS) dropped.push({ proposal, reason: `more than ${MAX_PROPOSALS} proposals` });
    else proposals.push(parsed.data);
  }
  return { input: { proposals, searches: Object.entries(output.searches).map(([claimId, search]) => ({ claimId, ...search })) }, dropped };
}

// Pipeline 3 records the source review as a typed answer too: one vote for
// each source of the index, keyed by its ID, so that none can be left out.
export function sourceReviewSchema(sourceIds: readonly string[]) {
  const vote = z.object({
    veto: z.boolean().describe("true to exclude the source from the corpus"),
    reason: z.string().describe("The concrete reason for your vote, in at least one full sentence"),
  }).strict();
  return z.object({
    votes: z.object(Object.fromEntries(sourceIds.map((id) => [id, vote]))).strict().describe("Your vote on each source of the index"),
  }).strict();
}

export type SourceReviewOutput = { votes: Record<string, { veto: boolean; reason: string }> };

// A typed decision of pipeline 3: the seat first answers in prose, without a
// format, then the host asks in a follow-up for the same decision in the
// format, and records it with the court action. Models that always think
// (Claude) cannot combine thinking with a forced answer in one request.
export type TypedDecision = {
  action: "file_instruction" | "review_sources";
  schema: z.ZodType;
  // The follow-up message that asks for the typed answer.
  request: string;
  // The artifact that records what the host filed.
  artifact: string;
  input(output: unknown): { input: unknown; dropped: DroppedProposal[] };
};

export function typedDecision(phase: InstructionPhase, record: readonly CourtEvent[]): TypedDecision | undefined {
  const view = project(record);
  if (phase === "instruction") return {
    action: "file_instruction", schema: instructionFilingSchema(view.claims.map((claim) => claim.id)), artifact: "filing.json",
    request: "Now give the filing you decided, in the requested format: for each source, its exact URL and the verbatim quote, copied from the preparation report in the source's language, its claim and its stance; and for each claim what you searched for in both directions.",
    input: (output) => instructionFiling(output as InstructionFilingOutput),
  };
  if (phase === "criticism") return {
    action: "review_sources", schema: sourceReviewSchema([...view.sources.values()].map((source) => source.id)), artifact: "review.json",
    request: "Now give the votes you decided, in the requested format: one for each source of the index, with its concrete reason.",
    input: (output) => ({ input: { votes: Object.entries((output as SourceReviewOutput).votes).map(([sourceId, vote]) => ({ sourceId, ...vote })) }, dropped: [] }),
  };
  return undefined;
}

const prose = new Set(["text", "quote", "reason", "grounds", "rationale", "reasoning", "supporting", "opposing", "commentary"]);

// lenient: the prose of instruction and criticism keeps its own language when
// its translation fails, instead of failing the case.
export async function normalizeCourtInput(value: unknown, reader: SourceService, key?: string, lenient = false): Promise<unknown> {
  if (typeof value === "string") return key && prose.has(key) ? (lenient ? await normalizeOrKeep(reader, "", value) : await reader.normalize("", value)).body : value;
  if (Array.isArray(value)) { const result = []; for (const child of value) result.push(await normalizeCourtInput(child, reader, key, lenient)); return result; }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(value)) result[name] = await normalizeCourtInput(child, reader, name, lenient);
    return result;
  }
  return value;
}

export function validateCourtText(corpus: SettledCorpus, value: unknown): void {
  if (typeof value === "string") {
    if (/(?:[a-z][a-z\d+.-]*:\/\/|\bwww\.)[^\s<>]+/i.test(value)) throw new Rejection("Cite only admitted evidence, by its E identifier and section, not external links.");
    const stack = [...new MarkdownIt({ html: false, linkify: false }).parse(value, {})];
    while (stack.length) {
      const token = stack.pop()!;
      if (token.children) stack.push(...token.children);
      const href = token.attrGet(token.type === "image" ? "src" : "href");
      if (href !== null) {
        if (typeof href !== "string") throw new Rejection("Invalid reference.");
        validateCorpusCitations(corpus, [href]);
      }
    }
    const citations = value.match(/\/(?:evidence|instruction|discussion)\/[^\s),;]+|\b[ESP][1-9]\d*(?:#p\d+(?::b\d+)?)?/g) ?? [];
    validateCorpusCitations(corpus, citations);
  } else if (Array.isArray(value)) value.forEach((child) => validateCourtText(corpus, child));
  else if (value && typeof value === "object") Object.values(value).forEach((child) => validateCourtText(corpus, child));
}

// The quote and URL of a proposal are matched against the source as written:
// only the analyst's own prose is normalized into the case language.
async function normalizeFiling(input: z.infer<typeof CourtActionSchemas.file_instruction>, reader: SourceService) {
  const proposals = [];
  for (const proposal of input.proposals) proposals.push(proposal.commentary ? { ...proposal, commentary: (await normalizeOrKeep(reader, "", proposal.commentary)).body } : proposal);
  return { proposals, searches: await normalizeCourtInput(input.searches, reader, undefined, true) };
}

export function modelFacingEvents(events: readonly CourtEvent[]): CourtEvent[] {
  // Audit-only originals never enter any participating model's context.
  return JSON.parse(JSON.stringify(events, (key, value) => key === "translation" || key === "original" ? undefined : value)) as CourtEvent[];
}

export function createCourtActions(docket: Docket, spec: TurnSpec, record: readonly CourtEvent[], reader: SourceService, corpus?: SettledCorpus, native = false) {
  const plan = planTurn(spec, record, docket.submission, [], Boolean(docket.submissionContext?.excerpt), native);
  const phase = turnPhase(spec);
  const run = async (name: CourtAction, raw: unknown): Promise<string | { error: string }> => {
    if (!phaseActions(phase, seatOf(spec), native).includes(name) || !plan.tools[name]) return { error: "action_not_allowed_this_turn" };
    try {
      const input = CourtActionSchemas[name].parse(raw);
      let prepared = name === "file_instruction" ? await normalizeFiling(CourtActionSchemas.file_instruction.parse(input), reader) : await normalizeCourtInput(input, reader, undefined, name === "review_sources");
      let reference: Pick<Evidence, "sourceId" | "blockIds" | "commentary"> | undefined;
      let citations: string[] | undefined;
      if (name === "file_evidence") {
        const filing = CourtActionSchemas.file_evidence.parse(prepared);
        const { source, blocks } = await reader.passages(filing.sourceId, filing.blockIds);
        const excerpt = blocks.map((block) => `[${block.id}] ${block.text}`).join("\n\n");
        if (excerpt.length > 30_000) throw new Rejection("Select a shorter passage for the contribution.");
        prepared = { claimId: filing.claimId, stance: filing.stance, title: source.document.title, url: source.acquisition.finalUrl, excerpt };
        reference = { sourceId: source.sourceId, blockIds: filing.blockIds, ...(filing.commentary ? { commentary: filing.commentary } : {}) };
      } else if (name === "unify_evidence") {
        const contributions = record.flatMap((event) => event.type === "evidence_filed" ? [event.evidence] : []);
        const groups = new Map<string, string[]>();
        for (const contribution of contributions) {
          if (!contribution.sourceId) throw new Rejection("A contribution has no canonical source identity.");
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
      // Tool outputs and rejections are written by the app, in English like its
      // prompts: only the model reads them, so they are not translated.
      return output;
    } catch (error) {
      if (error instanceof Rejection) return { error: error.message };
      return { error: "court_action_unavailable" };
    }
  };
  return { plan, run, phase, seat: seatOf(spec), outcome: () => ({ events: plan.produced as StampedEvent[], done: plan.done() }) };
}
