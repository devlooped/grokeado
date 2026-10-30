import { COUNSEL, majority, project, type Claim, type Counsel, type CourtEvent, type RecordedEvent, type Submission } from "../domain/court.ts";
import type { StampedEvent, TurnOutcome, TurnSpec } from "./turns.ts";

export interface Bench {
  submission: Submission;
  models: { judge: string; counsel: Record<Counsel, string> };
  simulated?: boolean;
  // One attempt of one seat, given everything on the record so far.
  play(spec: TurnSpec, record: readonly CourtEvent[], attempt: number): Promise<TurnOutcome>;
  // Persists newly recorded events; must be idempotent by seq.
  commit(events: readonly RecordedEvent[]): Promise<void>;
}

const MAX_ATTEMPTS = 2;

// Pure orchestration: no I/O besides the bench, so it can run inside a workflow and be tested with a scripted bench.
export async function holdSession(bench: Bench): Promise<void> {
  const log: RecordedEvent[] = [];
  let pending: RecordedEvent[] = [];

  const note = (e: CourtEvent) => void pending.push(stamp(e, new Date().toISOString()));
  const stamp = (e: CourtEvent, at: string): RecordedEvent => {
    const recorded = { ...e, seq: log.length + 1, at } as RecordedEvent;
    log.push(recorded);
    return recorded;
  };
  const flush = async () => {
    const batch = pending;
    pending = [];
    await bench.commit(batch);
  };

  // Turns in one round run in parallel, so evidence and objections come back with provisional ids; number them here.
  const absorb = (outcomes: TurnOutcome[]) => {
    for (const outcome of outcomes) {
      const renamed = new Map<string, string>();
      for (const e of outcome.events as StampedEvent[]) {
        let event: CourtEvent = e;
        if (e.type === "evidence_filed") {
          const id = "P" + (log.filter((x) => x.type === "evidence_filed").length + 1);
          renamed.set(e.evidence.id, id);
          event = { ...e, evidence: { ...e.evidence, id } };
        } else if (e.type === "objection") {
          const id = "O" + (log.filter((x) => x.type === "objection").length + 1);
          renamed.set(e.id, id);
          event = { ...e, id };
        } else if (e.type === "statement") {
          event = { ...e, evidenceIds: e.evidenceIds.map((id) => renamed.get(id) ?? id) };
        }
        pending.push(stamp(event, e.at));
      }
    }
  };

  const attempts = async (spec: TurnSpec): Promise<TurnOutcome> => {
    let events: StampedEvent[] = [];
    let done = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !done; attempt++) {
      const outcome = await bench.play(spec, [...log, ...events], attempt);
      events = [...events, ...outcome.events];
      done = outcome.done;
    }
    return { events, done };
  };

  const round = async (specs: TurnSpec[]): Promise<boolean[]> => {
    const outcomes = await Promise.all(specs.map(attempts));
    absorb(outcomes);
    await flush();
    return outcomes.map((o) => o.done);
  };

  const solo = async (spec: TurnSpec): Promise<boolean> => (await round([spec]))[0]!;

  const absent = async (by: Counsel, stage: Extract<CourtEvent, { type: "absence" }>["stage"]) => {
    note({ type: "absence", by, stage });
    await flush();
  };

  const claims = (): Claim[] => log.flatMap((e) => (e.type === "claims_entered" ? e.claims : []));
  const statementOf = (by: Counsel, stage: string) => log.find((e) => e.type === "statement" && e.by === by && e.stage === stage);

  async function objectionRound(speaker: Counsel, statementId: string) {
    const objectors = COUNSEL.filter((c) => c !== speaker);
    const first = log.length;
    const done = await round(objectors.map((counsel) => ({ kind: "objection", counsel, speaker, statementId })));
    for (const [i, ok] of done.entries()) if (!ok) await absent(objectors[i]!, "objection");

    for (const objection of log.slice(first).flatMap((e) => (e.type === "objection" ? [e] : []))) {
      if (!(await solo({ kind: "reply", speaker, objector: objection.by, objectionId: objection.id }))) await absent(speaker, "objection");
      if (!(await solo({ kind: "ruling", objectionId: objection.id }))) throw new Error("El moderador no resolvió la objeción " + objection.id + ".");
    }
  }

  note({ type: "session_opened", judgeModel: bench.models.judge, counselModels: bench.models.counsel, ...(bench.simulated ? { simulated: true } : {}) });
  await flush();

  if (!(await solo({ kind: "intake" }))) throw new Error("El moderador no fijó las afirmaciones.");
  if (log.some((e) => e.type === "dismissed")) {
    note({ type: "session_closed" });
    await flush();
    return;
  }

  note({ type: "instruction_opened" });
  await flush();
  const instructed = await round(COUNSEL.map((counsel) => ({ kind: "instruction", counsel })));
  for (const [i, ok] of instructed.entries()) if (!ok) await absent(COUNSEL[i]!, "instruction");

  if (!(await solo({ kind: "unification" }))) throw new Error("El moderador no unificó las pruebas de la instrucción.");
  const sources = [...project(log).sources.values()];
  if (sources.length) {
    const reviewed = await round(COUNSEL.map((counsel) => ({ kind: "source_review", counsel })));
    for (const [i, ok] of reviewed.entries()) if (!ok) await absent(COUNSEL[i]!, "source_review");
    const view = project(log);
    for (const source of view.sources.values()) {
      const vetoes = COUNSEL.filter((c) => source.votes[c]?.veto).length;
      note({ type: "source_decided", sourceId: source.id, excluded: vetoes > COUNSEL.length / 2 });
    }
  }
  note({ type: "instruction_closed" });
  await flush();

  for (const stage of ["opening", "rebuttal"] as const) {
    for (const counsel of COUNSEL) {
      note({ type: "floor_granted", to: counsel, stage });
      await flush();
      if (!(await solo({ kind: "statement", counsel, stage }))) {
        await absent(counsel, stage);
        continue;
      }
      const statement = statementOf(counsel, stage);
      if (statement?.type === "statement") await objectionRound(counsel, statement.id);
    }
  }

  for (const counsel of COUNSEL) {
    note({ type: "floor_granted", to: counsel, stage: "closing" });
    await flush();
    const done = await solo({ kind: "closing", counsel });
    if (!done && !log.some((e) => e.type === "vote" && e.by === counsel)) await absent(counsel, "closing");
  }

  for (const claim of claims()) {
    const verdicts = log.flatMap((e) => (e.type === "vote" && e.claimId === claim.id ? [e.verdict] : []));
    const verdict = majority(verdicts);
    if (verdict) note({ type: "judgment", claimId: claim.id, verdict, method: "consensus", reasoning: "" });
  }
  await flush();

  const judged = new Set(log.flatMap((e) => (e.type === "judgment" ? [e.claimId] : [])));
  if (claims().some((c) => !judged.has(c.id)) && !(await solo({ kind: "tiebreak" }))) throw new Error("El moderador no desempató.");

  note({ type: "session_closed" });
  await flush();
}
