import { STAGE_LABEL, VERDICT_LABEL } from "@/domain/acta.ts";
import { JUDGE, MODEL_NAME, type CaseView, type Counsel, type RecordedEvent } from "@/domain/court.ts";
import { GavelIcon, JudgeSeal, ModelMark, VERDICT_TEXT, VerdictGlyph } from "./marks.tsx";

const time = (at: string) =>
  new Date(at).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "America/Argentina/Buenos_Aires" });

function Speaker({ by }: { by: Counsel }) {
  return (
    <span className="grid size-9 shrink-0 place-items-center rounded-full border border-rule bg-paper/80">
      <ModelMark model={by} className="size-5" />
    </span>
  );
}

function Clerk({ children }: { children: React.ReactNode }) {
  return <p className="py-1 text-center font-mono text-[11px] uppercase tracking-[0.18em] text-ink-soft">{children}</p>;
}

function Entry({ e, view }: { e: RecordedEvent; view: CaseView }) {
  switch (e.type) {
    case "session_opened":
      return <Clerk>Empieza el debate · modera {MODEL_NAME[JUDGE]} · {time(e.at)}</Clerk>;
    case "claims_entered":
      return (
        <div className="flex gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-seal text-paper"><GavelIcon className="size-4" /></span>
          <div>
            <p className="text-sm font-semibold">El moderador fija las afirmaciones a examinar</p>
            <ol className="mt-1 space-y-1 text-sm">
              {e.claims.map((c) => <li key={c.id}><span className="font-mono text-xs text-ink-soft">{c.id}</span> {c.text}</li>)}
            </ol>
          </div>
        </div>
      );
    case "dismissed":
      return (
        <div className="flex gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-seal text-paper"><GavelIcon className="size-4" /></span>
          <p className="text-sm"><span className="font-semibold">El moderador descarta el caso.</span> {e.reason}</p>
        </div>
      );
    case "evidence_filed":
      return (
        <div id={e.evidence.id} className="ml-12 scroll-mt-24 rounded-sm border border-rule bg-paper/60 px-4 py-3 target:ring-2 target:ring-celeste">
          <div className="flex items-center gap-2 text-xs text-ink-soft">
            <span className="font-mono font-medium text-ink">{e.evidence.id}</span>
            <ModelMark model={e.evidence.by} className="size-3.5" />
            <span>Evidencia de {MODEL_NAME[e.evidence.by]} sobre {e.evidence.claimId}</span>
          </div>
          <a href={e.evidence.url} target="_blank" rel="noreferrer noopener" className="mt-1 block font-medium text-celeste-deep underline decoration-celeste/40 underline-offset-2 hover:decoration-celeste-deep">
            {e.evidence.title}
          </a>
          <p className="mt-1 text-sm text-ink-soft">{e.evidence.excerpt}</p>
        </div>
      );
    case "floor_granted":
      return <Clerk>El moderador da la palabra a {MODEL_NAME[e.to]} · {STAGE_LABEL[e.stage]}</Clerk>;
    case "statement": {
      const struck = view.struck.has(e.id);
      return (
        <div id={e.id} className="flex scroll-mt-24 gap-3">
          <Speaker by={e.by} />
          <div className="min-w-0 flex-1">
            <p className="text-sm">
              <span className="font-semibold">{MODEL_NAME[e.by]}</span>
              <span className="text-ink-soft"> · {STAGE_LABEL[e.stage]} · </span>
              <span className="font-mono text-xs text-ink-soft">{e.id}</span>
              {struck && <span className="ml-2 rounded-sm bg-seal px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-paper">Anulado</span>}
            </p>
            <p className={"mt-1 whitespace-pre-line font-display text-lg leading-snug " + (struck ? "struck" : "")}>{e.text}</p>
            {e.evidenceIds.length > 0 && (
              <p className="mt-1 text-xs text-ink-soft">
                Cita:{" "}
                {e.evidenceIds.map((id, i) => (
                  <span key={id}>
                    {i > 0 && ", "}
                    <a href={"#" + id} className="font-mono text-celeste-deep hover:underline">{id}</a>
                  </span>
                ))}
              </p>
            )}
          </div>
        </div>
      );
    }
    case "objection":
      return (
        <div className="ml-12 border-l-4 border-seal pl-4">
          <p className="font-display text-xl italic text-seal">Objeción</p>
          <p className="text-sm">
            <span className="font-semibold">{MODEL_NAME[e.by]}</span> objeta <a href={"#" + e.against} className="font-mono text-celeste-deep hover:underline">{e.against}</a>: {e.grounds}
          </p>
        </div>
      );
    case "objection_reply":
      return (
        <div className="ml-12 pl-5 text-sm">
          <span className="font-semibold">{MODEL_NAME[e.by]}</span> responde: <span className="text-ink-soft">{e.text}</span>
        </div>
      );
    case "ruling":
      return (
        <div className="ml-12 flex items-start gap-2 pl-5 text-sm">
          <GavelIcon className="mt-0.5 size-4 shrink-0 text-seal" />
          <p>
            <span className={"font-bold uppercase tracking-wide " + (e.sustained ? "text-seal" : "text-ink")}>{e.sustained ? "Objeción aceptada" : "Objeción rechazada"}.</span>{" "}
            <span className="text-ink-soft">{e.reason}</span>
          </p>
        </div>
      );
    case "vote":
      return (
        <div className="ml-12 flex items-start gap-2 text-sm">
          <ModelMark model={e.by} className="mt-0.5 size-4 shrink-0" />
          <p>
            <span className="font-semibold">{MODEL_NAME[e.by]}</span> vota <span className={"font-semibold " + VERDICT_TEXT[e.verdict]}>{VERDICT_LABEL[e.verdict]}</span> sobre {e.claimId}. <span className="text-ink-soft">{e.rationale}</span>
          </p>
        </div>
      );
    case "judgment":
      return e.method === "judge" ? (
        <div className="flex items-start gap-4 rounded-sm border border-seal/40 bg-seal/5 p-4">
          <JudgeSeal verdict={e.verdict} model={JUDGE} />
          <p className="text-sm">
            <span className="font-semibold">Desempate del moderador sobre {e.claimId}: </span>
            <span className={"font-semibold " + VERDICT_TEXT[e.verdict]}>{VERDICT_LABEL[e.verdict]}.</span> <span className="text-ink-soft">{e.reasoning}</span>
          </p>
        </div>
      ) : (
        <p className="flex items-center justify-center gap-2 text-sm">
          <span className={VERDICT_TEXT[e.verdict]}><VerdictGlyph verdict={e.verdict} className="size-4" /></span>
          Resultado de {e.claimId}: <span className={"font-semibold " + VERDICT_TEXT[e.verdict]}>{VERDICT_LABEL[e.verdict]}</span>, por mayoría.
        </p>
      );
    case "absence":
      return <Clerk>{MODEL_NAME[e.by]} no se pronunció</Clerk>;
    case "session_closed":
      return <Clerk>Termina el debate · {time(e.at)}</Clerk>;
  }
}

export function Acta({ events, view }: { events: RecordedEvent[]; view: CaseView }) {
  return (
    <ol className="space-y-4">
      {events.map((e) => (
        <li key={e.seq}>
          <Entry e={e} view={view} />
        </li>
      ))}
    </ol>
  );
}
