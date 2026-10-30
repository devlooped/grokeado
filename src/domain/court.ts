export const COUNSEL = ["grok", "gemini", "claude", "chatgpt"] as const;
export type Counsel = (typeof COUNSEL)[number];

export const JUDGE = "grok" satisfies Counsel;

export const MODEL_NAME: Record<Counsel, string> = {
  grok: "Grok",
  gemini: "Gemini",
  claude: "Claude",
  chatgpt: "ChatGPT",
};

export const COUNSEL_NAMES = new Intl.ListFormat("es-AR", { style: "long", type: "conjunction" }).format(COUNSEL.map((c) => MODEL_NAME[c]));

export const VERDICTS = ["verdadero", "falso", "no_verificable"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const STAGES = ["opening", "rebuttal", "closing"] as const;
export type Stage = (typeof STAGES)[number];

export type CaseStatus = "queued" | "in_session" | "resolved" | "failed";

export type Submission =
  | { kind: "text"; text: string }
  | { kind: "link"; url: string; note?: string }
  | { kind: "image"; mimeType: string; note?: string };

export interface Claim {
  id: string;
  quote: string;
  text: string;
}

export interface Evidence {
  id: string;
  by: Counsel;
  claimId: string;
  title: string;
  url: string;
  excerpt: string;
  // Optional only for records created before the instruction stage existed.
  stance?: "supports" | "opposes" | "context";
}

export interface InstructionSearch {
  claimId: string;
  supporting: string;
  opposing: string;
}

export interface UnifiedSource {
  id: string;
  title: string;
  url: string;
  contributions: Evidence[];
}

export interface SourceView extends UnifiedSource {
  votes: Partial<Record<Counsel, { veto: boolean; reason: string }>>;
  excluded?: boolean;
}

export type CourtEvent =
  | { type: "session_opened"; judgeModel: string; counselModels: Record<Counsel, string>; simulated?: boolean }
  | { type: "claims_entered"; claims: Claim[] }
  | { type: "dismissed"; reason: string }
  | { type: "instruction_opened" }
  | { type: "evidence_filed"; evidence: Evidence }
  | { type: "instruction_completed"; by: Counsel; searches: InstructionSearch[] }
  | { type: "evidence_unified"; sources: UnifiedSource[] }
  | { type: "source_review_vote"; by: Counsel; sourceId: string; veto: boolean; reason: string }
  | { type: "source_decided"; sourceId: string; excluded: boolean }
  | { type: "instruction_closed" }
  | { type: "floor_granted"; to: Counsel; stage: Stage }
  | { type: "statement"; id: string; by: Counsel; stage: Stage; text: string; evidenceIds: string[] }
  | { type: "objection"; id: string; by: Counsel; against: string; grounds: string }
  | { type: "objection_reply"; objectionId: string; by: Counsel; text: string }
  | { type: "ruling"; objectionId: string; sustained: boolean; reason: string }
  | { type: "vote"; by: Counsel; claimId: string; verdict: Verdict; rationale: string }
  | { type: "judgment"; claimId: string; verdict: Verdict; method: "consensus" | "judge"; reasoning: string }
  | { type: "absence"; by: Counsel; stage: Stage | "discovery" | "instruction" | "source_review" | "objection" }
  | { type: "session_closed" };

export type RecordedEvent = CourtEvent & { seq: number; at: string };

export type CaseRecord = {
  id: string;
  createdAt: string;
  status: CaseStatus;
  submission: Submission;
  ownerId?: string;
  error?: string;
};

export function majority(verdicts: Verdict[]): Verdict | undefined {
  return VERDICTS.find((v) => verdicts.filter((x) => x === v).length >= 3);
}

export interface ClaimView extends Claim {
  votes: Partial<Record<Counsel, { verdict: Verdict; rationale: string }>>;
  judgment?: { verdict: Verdict; method: "consensus" | "judge"; reasoning: string };
}

export interface CaseView {
  claims: ClaimView[];
  evidence: Map<string, Evidence>;
  sources: Map<string, SourceView>;
  struck: Set<string>;
  dismissal?: string;
  closed: boolean;
}

export function project(events: readonly CourtEvent[]): CaseView {
  const view: CaseView = { claims: [], evidence: new Map(), sources: new Map(), struck: new Set(), closed: false };
  const objectionTarget = new Map<string, string>();
  const claim = (id: string) => view.claims.find((c) => c.id === id);
  for (const e of events) {
    switch (e.type) {
      case "claims_entered":
        view.claims = e.claims.map((c) => ({ ...c, votes: {} }));
        break;
      case "dismissed":
        view.dismissal = e.reason;
        break;
      case "evidence_filed":
        view.evidence.set(e.evidence.id, e.evidence);
        break;
      case "evidence_unified":
        view.sources = new Map(e.sources.map((source) => [source.id, { ...source, votes: {} }]));
        break;
      case "source_review_vote": {
        const source = view.sources.get(e.sourceId);
        if (source) source.votes[e.by] = { veto: e.veto, reason: e.reason };
        break;
      }
      case "source_decided": {
        const source = view.sources.get(e.sourceId);
        if (source) source.excluded = e.excluded;
        break;
      }
      case "objection":
        objectionTarget.set(e.id, e.against);
        break;
      case "ruling":
        if (e.sustained) view.struck.add(objectionTarget.get(e.objectionId)!);
        break;
      case "vote": {
        const c = claim(e.claimId);
        if (c) c.votes[e.by] = { verdict: e.verdict, rationale: e.rationale };
        break;
      }
      case "judgment": {
        const c = claim(e.claimId);
        if (c) c.judgment = { verdict: e.verdict, method: e.method, reasoning: e.reasoning };
        break;
      }
      case "session_closed":
        view.closed = true;
        break;
    }
  }
  return view;
}
