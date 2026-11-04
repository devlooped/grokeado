import type { CourtEvent } from "@/domain/court.ts";

// The stages of the method page, in the order the court goes through them.
export const PROGRESS_STEPS = ["Instrucción", "Crítica de fuentes", "Debate", "Resultado"] as const;

const STAGE_OF: Partial<Record<CourtEvent["type"], number>> = {
  evidence_unified: 1,
  source_review_vote: 1,
  source_decided: 1,
  instruction_closed: 2,
  floor_granted: 2,
  statement: 2,
  objection: 2,
  objection_reply: 2,
  ruling: 2,
  vote: 3,
  judgment: 3,
  case_summary: 3,
  session_closed: 3,
};

// The stage the court is in: the furthest one any recorded event belongs to.
export function sessionStage(events: readonly Pick<CourtEvent, "type">[]): number {
  return events.reduce((stage, e) => Math.max(stage, STAGE_OF[e.type] ?? 0), 0);
}

export function SessionProgress({ events, queued }: { events: readonly CourtEvent[]; queued: boolean }) {
  const current = queued ? -1 : sessionStage(events);
  const claims = events.findLast((e) => e.type === "claims_entered")?.claims.length ?? 0;
  return (
    <div className="mx-auto mt-10 max-w-xl text-left">
      <p className="sr-only" role="status">
        {queued ? "El caso está en espera." : "Etapa " + (current + 1) + " de " + PROGRESS_STEPS.length + ": " + PROGRESS_STEPS[current] + "."}
      </p>
      <ol className="grid grid-cols-4 gap-2" aria-label="Etapas del análisis">
        {PROGRESS_STEPS.map((step, i) => {
          const state = i < current ? "done" : i === current ? "current" : "pending";
          return (
            <li key={step} aria-current={state === "current" ? "step" : undefined}>
              <span
                className={
                  "block h-1.5 rounded-full " +
                  (state === "done" ? "bg-ink" : state === "current" ? "session-light bg-seal" : "bg-rule")
                }
              />
              <span className={"mt-2 block text-xs " + (state === "pending" ? "text-ink-soft" : "font-medium text-ink")}>
                {step}
                <span className="sr-only">{state === "done" ? " (terminada)" : state === "current" ? " (en curso)" : " (pendiente)"}</span>
              </span>
            </li>
          );
        })}
      </ol>
      <p className="mt-4 text-center text-sm text-ink-soft">
        {queued
          ? "El caso está en espera; el panel lo toma en un momento."
          : claims > 0
            ? claims + (claims === 1 ? " afirmación en estudio." : " afirmaciones en estudio.")
            : "El moderador está identificando las afirmaciones."}
      </p>
    </div>
  );
}
