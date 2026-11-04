import { VERDICT_LABEL } from "@/domain/acta.ts";
import { COUNSEL, MODEL_NAME, seatModels, type CaseRecord, type CaseView, type ClaimView, type RecordedEvent, type SeatModels } from "@/domain/court.ts";
import { Cited, citationRefs, type Citations } from "./citations.tsx";
import { ClaimsIcon, GavelIcon, JudgeSeal, MegaphoneIcon, VERDICT_TEXT, VerdictDot, VoteChip } from "./marks.tsx";
import { CasePanel } from "./case-panel.tsx";
import { VoteRationaleNavigation } from "./vote-rationale-navigation.tsx";

export const voteId = (claimId: string, counsel: string) => "voto-" + claimId + "-" + counsel;
export const reasonsId = (claimId: string) => "fundamentos-" + claimId;

// The mark after each quoted claim: its conclusion, linked to the claim with its reasons expanded.
// Hovering or focusing it shows each analyst's vote, linked to that analyst's own reason.
function ClaimMark({ claim, models }: { claim: ClaimView; models: SeatModels }) {
  const j = claim.judgment;
  const voted = COUNSEL.some((c) => claim.votes[c]);
  const label = "Afirmación " + claim.id + (j ? ": " + VERDICT_LABEL[j.verdict] + (j.method === "judge" ? " (desempate del moderador)" : "") : "") + ". Ver fundamentos";
  return (
    <span className="group/claim relative ml-1.5 inline-block align-middle">
      <a
        href={"#" + reasonsId(claim.id)}
        title={label}
        aria-label={label}
        className="inline-flex items-center gap-1 rounded-full border border-rule bg-paper py-0.5 pr-2 pl-0.5 font-mono text-[11px] leading-none font-medium text-ink-soft no-underline shadow-sm transition hover:border-ink-soft hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-celeste-deep"
      >
        {j ? <VerdictDot verdict={j.verdict} /> : <span className="size-4" aria-hidden />}
        {j?.method === "judge" && <GavelIcon className="size-3 text-seal" />}
        {claim.id}
      </a>
      {voted && (
        <span className="invisible absolute bottom-full left-1/2 z-20 -translate-x-1/2 pb-2 opacity-0 transition group-focus-within/claim:visible group-focus-within/claim:opacity-100 group-hover/claim:visible group-hover/claim:opacity-100">
          <span role="group" aria-label={"Votos de los analistas sobre " + claim.id} className="flex gap-1.5 whitespace-nowrap rounded-sm border border-rule bg-paper p-1.5 shadow-md">
            {COUNSEL.map((c) => claim.votes[c] ? (
              <a key={c} href={"#" + voteId(claim.id, c)} aria-label={"Ver fundamento de " + MODEL_NAME[c] + ": " + VERDICT_LABEL[claim.votes[c].verdict]} className="rounded-full transition hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-celeste-deep">
                <VoteChip model={c} verdict={claim.votes[c].verdict} used={models[c]} size="sm" />
              </a>
            ) : <VoteChip key={c} model={c} used={models[c]} size="sm" />)}
          </span>
        </span>
      )}
    </span>
  );
}

const bare = (s: string) => s.trim().replace(/[\s.!?…"'«»“”]+$/u, "").replace(/^[\s"'«»“”]+/u, "");

function Highlighted({ text, claims, models }: { text: string; claims: ClaimView[]; models: SeatModels }) {
  // A claim that quotes the whole content only gets its mark: underlining everything adds nothing.
  const whole = claims.length === 1 && claims[0]!.quote && bare(claims[0]!.quote) === bare(text);
  const marks = claims
    .map((c) => ({ claim: c, start: c.quote ? text.indexOf(c.quote) : -1, length: c.quote.length }))
    .filter((m) => m.start >= 0 && m.length > 0)
    .sort((a, b) => a.start - b.start)
    .filter((m, i, all) => i === 0 || m.start >= all[i - 1].start + all[i - 1].length);
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const { claim, start, length } of marks) {
    parts.push(text.slice(at, start));
    parts.push(
      <span key={claim.id}>
        {whole ? text.slice(start, start + length) : <mark className="cita" data-verdict={claim.judgment?.verdict}>{text.slice(start, start + length)}</mark>}
        <ClaimMark claim={claim} models={models} />
      </span>
    );
    at = start + length;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

function Original({ c, claims, models }: { c: CaseRecord; claims: ClaimView[]; models: SeatModels }) {
  const s = c.submission;
  return (
    <figure className="min-w-0 rounded-sm border border-rule bg-paper/60 p-5">
      <figcaption className="mb-5 flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-sm border border-rule text-celeste-deep"><MegaphoneIcon className="size-5" /></span>
        <span className="font-display text-2xl">Lo que se dijo</span>
      </figcaption>
      {s.kind === "text" && (
        <blockquote className="pl-3 break-words whitespace-pre-line font-display text-2xl leading-snug">
          {/* Hanging guillemet: the text keeps its left edge. */}
          <span aria-hidden className="-ml-[0.6em] inline-block w-[0.6em] text-celeste select-none">«</span>
          <Highlighted text={s.text} claims={claims} models={models} />
        </blockquote>
      )}
      {s.kind === "link" && (
        <a href={s.url} target="_blank" rel="noreferrer noopener" className="break-all font-display text-xl text-celeste-deep underline decoration-celeste/40 underline-offset-4">
          {s.url}
        </a>
      )}
      {s.kind === "image" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={"/c/" + c.id + "/image"} alt="Imagen enviada" className="max-h-72 max-w-full rounded-sm border border-rule object-contain" />
      )}
      {s.kind !== "text" && s.note && <p className="mt-3 text-sm text-ink-soft">Comentario: {s.note}</p>}
    </figure>
  );
}

function ClaimCard({ claim, models }: { claim: ClaimView; models: SeatModels }) {
  const j = claim.judgment;
  const agreeing = j ? COUNSEL.filter((c) => claim.votes[c]?.verdict === j.verdict).length : 0;
  return (
    <article id={claim.id} data-claim className="reveal grid scroll-mt-24 gap-x-6 gap-y-4 border-t border-rule py-5 sm:grid-cols-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,1fr)_10rem_auto]">
      <div className="min-w-0 sm:col-span-2 lg:col-span-1">
        <p className="font-mono text-[11px] text-ink-soft">{claim.id}</p>
        <h3 className="mt-1 break-words font-display text-xl leading-snug">{claim.text}</h3>
      </div>
      <div className="flex items-center gap-3">
        {j ? (
          <>
            {j.method === "judge" ? <JudgeSeal verdict={j.verdict} judge={models.judge} /> : <VerdictDot verdict={j.verdict} className="size-6" />}
            <div>
              <p className={"font-display text-2xl leading-none " + VERDICT_TEXT[j.verdict]}>{VERDICT_LABEL[j.verdict]}</p>
              <p className={"mt-1 text-[10px] " + (j.method === "judge" ? "text-seal" : "text-ink-soft")}>{j.method === "judge" ? "Desempate del moderador" : "Mayoría · " + agreeing + " de " + COUNSEL.length}</p>
            </div>
          </>
        ) : <p className="text-sm text-ink-soft">Sin resultado registrado</p>}
      </div>
      <div className="flex flex-wrap items-center gap-3 sm:justify-end lg:self-center" role="group" aria-label={"Votos de los analistas sobre " + claim.id}>
        {COUNSEL.map((c) => claim.votes[c] ? (
          <a key={c} href={"#" + voteId(claim.id, c)} aria-label={"Ver fundamento de " + MODEL_NAME[c] + ": " + VERDICT_LABEL[claim.votes[c].verdict]} className="rounded-full focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-celeste-deep">
            <VoteChip model={c} verdict={claim.votes[c].verdict} used={models[c]} />
          </a>
        ) : <VoteChip key={c} model={c} used={models[c]} />)}
      </div>
      <details id={reasonsId(claim.id)} className="text-sm sm:col-span-2 lg:col-span-3">
        <summary className="w-fit cursor-pointer select-none text-xs text-celeste-deep hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-celeste-deep">Fundamentos de cada voto<span className="sr-only"> sobre {claim.id}</span></summary>
        <ul className="mt-3 space-y-3 rounded-sm bg-paper-deep/50 p-4">
          {COUNSEL.map((c) => (
            <li key={c} id={voteId(claim.id, c)} tabIndex={-1} className="scroll-mt-24 target:rounded-sm target:bg-celeste/15">
              <span className="font-semibold">{MODEL_NAME[c]}:</span>{" "}
              {claim.votes[c] ? (
                <>
                  <span className={"font-semibold " + VERDICT_TEXT[claim.votes[c].verdict]}>{VERDICT_LABEL[claim.votes[c].verdict]}.</span>{" "}
                  <span className="text-ink-soft">{claim.votes[c].rationale}</span>
                </>
              ) : <span className="text-ink-soft">no votó.</span>}
            </li>
          ))}
          {j?.method === "judge" && (
            <li className="border-l-2 border-seal pl-3">
              <span className="font-semibold text-seal">Moderador:</span> <span className="text-ink-soft">{j.reasoning}</span>
            </li>
          )}
        </ul>
      </details>
    </article>
  );
}

export function CaseResult({ c, view, events = [], models = seatModels(c, events) }: { c: CaseRecord; view: CaseView; events?: readonly RecordedEvent[]; models?: SeatModels }) {
  // The summary links what it mentions: the claims to their cards, the rest to the record below.
  const refs = citationRefs(events, view);
  for (const claim of view.claims) refs.set(claim.id, "#" + claim.id);
  const citations: Citations = { caseId: c.id, refs };
  return (
    <>
      <VoteRationaleNavigation />
      <div data-case-overview className="mt-6 space-y-4">
        <div className="grid items-start gap-4 lg:has-[section]:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <Original c={c} claims={view.claims} models={models} />
          <CasePanel c={c} models={models} />
        </div>
        {view.dismissal ? (
          <p className="flex items-start gap-3 rounded-sm border border-seal/40 bg-seal/5 p-5">
            <GavelIcon className="mt-1 size-5 shrink-0 text-seal" />
            <span>{view.dismissal}</span>
          </p>
        ) : view.claims.length > 0 && (
          <section aria-labelledby="case-claims-title" className="rounded-sm border border-rule bg-paper/60 px-5 pt-5">
            <div className="mb-4 flex items-center gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-sm border border-rule text-celeste-deep"><ClaimsIcon className="size-5" /></span>
              <h2 id="case-claims-title" className="font-display text-2xl">Afirmaciones</h2>
              <span className="ml-auto font-mono text-xs text-ink-soft">{view.claims.length} {view.claims.length === 1 ? "examinada" : "examinadas"}</span>
            </div>
            {view.claims.map((claim) => <ClaimCard key={claim.id} claim={claim} models={models} />)}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-rule py-4 text-[11px] text-ink-soft">
              <span>Cada círculo es un voto:</span>
              <span className="inline-flex items-center gap-1"><span className="size-2.5 rounded-full bg-verdadero" /> {VERDICT_LABEL.verdadero}</span>
              <span className="inline-flex items-center gap-1"><span className="size-2.5 rounded-full bg-falso" /> {VERDICT_LABEL.falso}</span>
              <span className="inline-flex items-center gap-1"><span className="size-2.5 rounded-full bg-insostenible" /> {VERDICT_LABEL.no_verificable}</span>
              <span className="inline-flex items-center gap-1"><span className="size-2.5 rounded-full bg-enganoso" /> {VERDICT_LABEL.enganoso}</span>
              <a href="/method#resultados" className="text-celeste-deep underline underline-offset-4">Cómo leer los resultados</a>
            </div>
          </section>
        )}
      </div>
      {!view.dismissal && view.summary && (
        <section aria-labelledby="case-summary-title" className="mt-8 rule-double pt-5">
          <h2 id="case-summary-title" className="font-display text-3xl">Resumen del caso</h2>
          <p className="mt-1 text-xs text-ink-soft">Por el moderador</p>
          <p className="mt-3 whitespace-pre-line leading-relaxed"><Cited text={view.summary} ctx={citations} /></p>
        </section>
      )}
    </>
  );
}
