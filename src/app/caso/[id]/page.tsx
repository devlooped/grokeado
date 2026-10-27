import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { retryCase } from "@/app/actions.ts";
import { Acta } from "@/components/acta.tsx";
import { AutoRefresh } from "@/components/auto-refresh.tsx";
import { GavelIcon, JudgeSeal, VERDICT_TEXT, VoteChip } from "@/components/marks.tsx";
import { submissionExcerpt, VERDICT_LABEL } from "@/domain/acta.ts";
import { COUNSEL, JUDGE, MODEL_NAME, type CaseRecord, type ClaimView } from "@/domain/court.ts";
import { project } from "@/domain/court.ts";
import { getCase, getEvents } from "@/store.ts";

export async function generateMetadata(props: PageProps<"/caso/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  const c = getCase(id);
  return { title: c ? "Causa Nº " + id + " · Grokeado" : "Grokeado" };
}

const date = (at: string) => new Date(at).toLocaleString("es-AR", { dateStyle: "long", timeStyle: "short", timeZone: "America/Argentina/Buenos_Aires" });

function Highlighted({ text, claims }: { text: string; claims: ClaimView[] }) {
  const marks = claims
    .map((c) => ({ id: c.id, start: c.quote ? text.indexOf(c.quote) : -1, length: c.quote.length }))
    .filter((m) => m.start >= 0 && m.length > 0)
    .sort((a, b) => a.start - b.start)
    .filter((m, i, all) => i === 0 || m.start >= all[i - 1].start + all[i - 1].length);
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const m of marks) {
    parts.push(text.slice(at, m.start));
    parts.push(
      <mark key={m.id} className="cita">
        {text.slice(m.start, m.start + m.length)}
        <sup className="ml-0.5 font-mono text-[10px] text-celeste-deep">{m.id}</sup>
      </mark>
    );
    at = m.start + m.length;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

function Original({ c, claims }: { c: CaseRecord; claims: ClaimView[] }) {
  const s = c.submission;
  return (
    <figure className="rounded-sm border border-rule bg-white/60 p-5">
      <figcaption className="mb-2 font-mono text-[11px] uppercase tracking-widest text-ink-soft">Material denunciado</figcaption>
      {s.kind === "text" && (
        <blockquote className="whitespace-pre-line font-display text-xl leading-relaxed">
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
        <img src={"/caso/" + c.id + "/imagen"} alt="Imagen denunciada" className="max-h-[28rem] rounded-sm border border-rule" />
      )}
      {s.kind !== "text" && s.note && <p className="mt-3 text-sm text-ink-soft">Comentario: {s.note}</p>}
    </figure>
  );
}

function ClaimCard({ claim }: { claim: ClaimView }) {
  const j = claim.judgment;
  const agreeing = j ? COUNSEL.filter((c) => claim.votes[c]?.verdict === j.verdict).length : 0;
  return (
    <article className="reveal grid gap-4 border-b border-rule py-6 sm:grid-cols-[1fr_auto] sm:items-start">
      <div>
        <p className="font-mono text-xs text-ink-soft">{claim.id}</p>
        <h3 className="mt-1 font-display text-2xl leading-snug">{claim.text}</h3>
        {claim.quote && <p className="mt-1 text-sm italic text-ink-soft">«{claim.quote}»</p>}
        <details className="group mt-3 text-sm">
          <summary className="cursor-pointer select-none text-celeste-deep hover:underline">Fundamentos de cada voto</summary>
          <ul className="mt-2 space-y-2">
            {COUNSEL.map((c) => (
              <li key={c}>
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
                <span className="font-semibold text-seal">Juez ({MODEL_NAME[JUDGE]}):</span> <span className="text-ink-soft">{j.reasoning}</span>
              </li>
            )}
          </ul>
        </details>
      </div>
      <div className="flex items-center gap-4 sm:flex-col sm:items-end">
        <div className="flex gap-2" aria-label="Votos de los letrados">
          {COUNSEL.map((c) => (
            <VoteChip key={c} model={c} verdict={claim.votes[c]?.verdict} />
          ))}
        </div>
        {j?.method === "judge" ? (
          <div className="flex items-center gap-3">
            <div className="text-right">
              <p className={"font-display text-2xl leading-none " + VERDICT_TEXT[j.verdict]}>{VERDICT_LABEL[j.verdict]}</p>
              <p className="mt-1 text-[11px] uppercase tracking-wider text-seal">Sin mayoría · decidió el juez</p>
            </div>
            <JudgeSeal verdict={j.verdict} model={JUDGE} size="lg" />
          </div>
        ) : j ? (
          <div className="text-right">
            <p className={"font-display text-3xl leading-none " + VERDICT_TEXT[j.verdict]}>{VERDICT_LABEL[j.verdict]}</p>
            <p className="mt-1 text-[11px] uppercase tracking-wider text-ink-soft">Mayoría {agreeing} de 3</p>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function InSession({ c }: { c: CaseRecord }) {
  return (
    <section className="mx-auto max-w-2xl py-16 text-center">
      <AutoRefresh everyMs={5000} />
      <div className="inline-flex items-center gap-2 rounded-full border border-seal/40 px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.25em] text-seal">
        <span className="session-light size-2.5 rounded-full bg-seal" /> En sesión
      </div>
      <div className="mx-auto mt-8 grid size-28 place-items-center rounded-full border-2 border-ink bg-white/60">
        <GavelIcon className="gavel size-14 text-ink" />
      </div>
      <h1 className="mt-8 font-display text-5xl sm:text-6xl">La corte está en sesión</h1>
      <p className="mx-auto mt-4 max-w-md text-ink-soft">
        Grok, Gemini y Claude están investigando y debatiendo tu denuncia. Cuando se levante la sesión vas a ver el fallo y el acta completa. Esta página se actualiza sola.
      </p>
      <p className="mx-auto mt-8 line-clamp-3 max-w-lg font-display text-lg italic text-ink-soft">«{submissionExcerpt(c.submission)}»</p>
      <p className="mt-6 font-mono text-xs text-ink-soft">Causa Nº {c.id}</p>
    </section>
  );
}

function Suspended({ c }: { c: CaseRecord }) {
  return (
    <section className="mx-auto max-w-2xl py-16 text-center">
      <h1 className="font-display text-5xl">La sesión se suspendió</h1>
      <p className="mx-auto mt-4 max-w-md text-ink-soft">El tribunal no pudo completar la sesión. Podés volver a presentarla.</p>
      {c.error && <p className="mx-auto mt-3 max-w-md font-mono text-xs text-ink-soft">{c.error}</p>}
      <form action={retryCase.bind(null, c.id)} className="mt-6">
        <button className="rounded-sm bg-ink px-6 py-3 font-medium text-paper hover:bg-celeste-deep">Volver a presentar</button>
      </form>
    </section>
  );
}

export default async function CasePage(props: PageProps<"/caso/[id]">) {
  await connection();
  const { id } = await props.params;
  const c = getCase(id);
  if (!c) notFound();
  if (c.status === "queued" || c.status === "in_session") return <InSession c={c} />;
  if (c.status === "failed") return <Suspended c={c} />;

  const events = getEvents(id);
  const view = project(events);
  const byJudge = view.claims.filter((cl) => cl.judgment?.method === "judge").length;

  return (
    <>
      <header className="reveal flex flex-wrap items-end justify-between gap-4 pt-8">
        <div>
          <p className="font-mono text-xs uppercase tracking-widest text-ink-soft">Causa Nº {c.id} · {date(c.createdAt)}</p>
          <h1 className="mt-2 font-display text-5xl">{view.dismissal ? "Denuncia desestimada" : "Fallo"}</h1>
        </div>
        {!view.dismissal && (
          <p className="max-w-xs text-right text-sm text-ink-soft">
            {view.claims.length} {view.claims.length === 1 ? "afirmación examinada" : "afirmaciones examinadas"}
            {byJudge > 0 ? ", " + byJudge + " " + (byJudge === 1 ? "decidida" : "decididas") + " por el juez" : ", todas por mayoría"}.
          </p>
        )}
      </header>

      <div className="mt-6">
        <Original c={c} claims={view.claims} />
      </div>

      {view.dismissal ? (
        <p className="mt-6 flex items-start gap-3 rounded-sm border border-seal/40 bg-seal/5 p-5">
          <GavelIcon className="mt-1 size-5 shrink-0 text-seal" />
          <span>{view.dismissal}</span>
        </p>
      ) : (
        <section className="mt-4">
          {view.claims.map((claim) => (
            <ClaimCard key={claim.id} claim={claim} />
          ))}
          <p className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-ink-soft">
            <span>Cada círculo es el voto de un letrado.</span>
            <span className="inline-flex items-center gap-1"><span className="size-2.5 rounded-full bg-verdadero" /> Verdadero</span>
            <span className="inline-flex items-center gap-1"><span className="size-2.5 rounded-full bg-falso" /> Falso</span>
            <span className="inline-flex items-center gap-1"><span className="size-2.5 rounded-full bg-dudoso" /> No verificable</span>
            <span className="inline-flex items-center gap-1 text-seal"><GavelIcon className="size-3.5" /> Sello: decidió el juez</span>
          </p>
        </section>
      )}

      <section className="mt-16">
        <div className="rule-double pt-4">
          <h2 className="font-display text-4xl">Acta de la sesión</h2>
          <p className="mt-1 text-sm text-ink-soft">Registro completo, en orden, de todo lo que ocurrió en la sala.</p>
        </div>
        <div className="mt-8">
          <Acta events={events} view={view} />
        </div>
      </section>
    </>
  );
}
