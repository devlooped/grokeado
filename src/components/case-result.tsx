import { VERDICT_LABEL } from "@/domain/acta.ts";
import { COUNSEL, JUDGE, MODEL_NAME, type CaseRecord, type CaseView, type ClaimView, type RecordedEvent } from "@/domain/court.ts";
import { Cited, citationRefs, type Citations } from "./citations.tsx";
import { GavelIcon, JudgeSeal, VERDICT_TEXT, VerdictDot, VoteChip } from "./marks.tsx";
import { VoteRationaleNavigation } from "./vote-rationale-navigation.tsx";

export const voteId = (claimId: string, counsel: string) => "voto-" + claimId + "-" + counsel;
export const reasonsId = (claimId: string) => "fundamentos-" + claimId;

// The mark after each quoted claim: its conclusion, linked to the claim with its reasons expanded.
// Hovering or focusing it shows each analyst's vote, linked to that analyst's own reason.
function ClaimMark({ claim }: { claim: ClaimView }) {
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
                <VoteChip model={c} verdict={claim.votes[c].verdict} size="sm" />
              </a>
            ) : <VoteChip key={c} model={c} size="sm" />)}
          </span>
        </span>
      )}
    </span>
  );
}

const bare = (s: string) => s.trim().replace(/[\s.!?…"'«»“”]+$/u, "").replace(/^[\s"'«»“”]+/u, "");

function Highlighted({ text, claims }: { text: string; claims: ClaimView[] }) {
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
        <ClaimMark claim={claim} />
      </span>
    );
    at = start + length;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

function Original({ c, claims }: { c: CaseRecord; claims: ClaimView[] }) {
  const s = c.submission;
  return (
    <figure className="border-y border-rule py-6 pl-7 sm:py-8 sm:pl-9">
      <figcaption className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-ink-soft">
        <span>Contenido</span>
      </figcaption>
      {s.kind === "text" && (
        <blockquote className="whitespace-pre-line font-display text-2xl leading-snug sm:text-3xl">
          {/* Hanging guillemet: the text keeps its left edge. */}
          <span aria-hidden className="-ml-[0.6em] inline-block w-[0.6em] text-celeste select-none">«</span>
          <Highlighted text={s.text} claims={claims} />
        </blockquote>
      )}
      {s.kind === "link" && (
        <a href={s.url} target="_blank" rel="noreferrer noopener" className="break-all font-display text-xl text-celeste-deep underline decoration-celeste/40 underline-offset-4">
          {s.url}
        </a>
      )}
      {s.kind === "image" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={"/c/" + c.id + "/image"} alt="Imagen enviada" className="max-h-[28rem] rounded-sm border border-rule" />
      )}
      {s.kind !== "text" && s.note && <p className="mt-3 text-sm text-ink-soft">Comentario: {s.note}</p>}
    </figure>
  );
}

function ClaimCard({ claim }: { claim: ClaimView }) {
  const j = claim.judgment;
  const agreeing = j ? COUNSEL.filter((c) => claim.votes[c]?.verdict === j.verdict).length : 0;
  return (
    <article id={claim.id} data-claim className="reveal scroll-mt-24 grid gap-4 border-b border-rule py-6 sm:grid-cols-[1fr_auto] sm:items-start">
      <div>
        <p className="font-mono text-xs text-ink-soft">{claim.id}</p>
        <h3 className="mt-1 font-display text-2xl leading-snug">{claim.text}</h3>
        {claim.quote && <p className="mt-1 text-sm italic text-ink-soft">«{claim.quote}»</p>}
        <details id={reasonsId(claim.id)} className="group mt-3 text-sm">
          <summary className="cursor-pointer select-none text-celeste-deep hover:underline">Fundamentos de cada voto</summary>
          <ul className="mt-2 space-y-2">
            {COUNSEL.map((c) => (
              <li key={c} id={voteId(claim.id, c)} tabIndex={-1} className="scroll-mt-24 target:rounded-sm target:bg-celeste/15">
                <span className="font-semibold">{MODEL_NAME[c]}:</span>{" "}
                {claim.votes[c] ? (
                  <>
                    <span className={"font-semibold " + VERDICT_TEXT[claim.votes[c].verdict]}>{VERDICT_LABEL[claim.votes[c].verdict]}.</span>{" "}
                    <span className="text-ink-soft">{claim.votes[c].rationale}</span>
                  </>
                ) : (
                  <span className="text-ink-soft">no votó.</span>
                )}
              </li>
            ))}
            {j?.method === "judge" && (
              <li className="border-l-2 border-seal pl-3">
                <span className="font-semibold text-seal">Moderador ({MODEL_NAME[JUDGE]}):</span> <span className="text-ink-soft">{j.reasoning}</span>
              </li>
            )}
          </ul>
        </details>
      </div>
      <div className="flex items-center gap-4 sm:flex-col sm:items-end">
        <div className="flex gap-2" aria-label="Votos de los analistas">
          {COUNSEL.map((c) => <VoteChip key={c} model={c} verdict={claim.votes[c]?.verdict} />)}
        </div>
        {j?.method === "judge" ? (
          <div className="flex items-center gap-3">
            <div className="text-right">
              <p className={"font-display text-2xl leading-none " + VERDICT_TEXT[j.verdict]}>{VERDICT_LABEL[j.verdict]}</p>
              <p className="mt-1 text-[11px] uppercase tracking-wider text-seal">Sin mayoría · desempató el moderador</p>
            </div>
            <JudgeSeal verdict={j.verdict} model={JUDGE} size="lg" />
          </div>
        ) : j ? (
          <div className="text-right">
            <p className={"font-display text-3xl leading-none " + VERDICT_TEXT[j.verdict]}>{VERDICT_LABEL[j.verdict]}</p>
            <p className="mt-1 text-[11px] uppercase tracking-wider text-ink-soft">Mayoría {agreeing}</p>
          </div>
        ) : null}
      </div>
    </article>
  );
}

export function CaseResult({ c, view, events = [] }: { c: CaseRecord; view: CaseView; events?: readonly RecordedEvent[] }) {
  // The summary links what it mentions: the claims to their cards, the rest to the record below.
  const refs = citationRefs(events, view);
  for (const claim of view.claims) refs.set(claim.id, "#" + claim.id);
  const citations: Citations = { caseId: c.id, refs };
  return (
    <>
      <VoteRationaleNavigation />
      <div className="mt-6"><Original c={c} claims={view.claims} /></div>
      {view.dismissal ? (
        <p className="mt-6 flex items-start gap-3 rounded-sm border border-seal/40 bg-seal/5 p-5">
          <GavelIcon className="mt-1 size-5 shrink-0 text-seal" />
          <span>{view.dismissal}</span>
        </p>
      ) : (
        <>
          {view.summary && (
            <section className="mt-6">
              <h2 className="font-display text-3xl">Resumen del caso</h2>
              <p className="mt-1 text-xs text-ink-soft">Por el moderador ({MODEL_NAME[JUDGE]})</p>
              <p className="mt-3 whitespace-pre-line leading-relaxed"><Cited text={view.summary} ctx={citations} /></p>
            </section>
          )}
          <section className="mt-4">
            {view.claims.map((claim) => <ClaimCard key={claim.id} claim={claim} />)}
            <p className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-ink-soft">
              <span>Cada círculo es el voto de un analista.</span>
              <span className="inline-flex items-center gap-1"><span className="size-2.5 rounded-full bg-verdadero" /> {VERDICT_LABEL.verdadero}</span>
              <span className="inline-flex items-center gap-1"><span className="size-2.5 rounded-full bg-falso" /> {VERDICT_LABEL.falso}</span>
              <span className="inline-flex items-center gap-1"><span className="size-2.5 rounded-full bg-insostenible" /> {VERDICT_LABEL.no_verificable}</span>
              <span className="inline-flex items-center gap-1"><span className="size-2.5 rounded-full bg-enganoso" /> {VERDICT_LABEL.enganoso}</span>
              <span className="inline-flex items-center gap-1 text-seal"><GavelIcon className="size-3.5" /> Sello: desempate del moderador</span>
              <a href="/method#resultados" className="text-celeste-deep underline underline-offset-4">¿Qué significa cada resultado?</a>
            </p>
          </section>
        </>
      )}
    </>
  );
}
