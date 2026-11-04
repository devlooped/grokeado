import Link from "next/link";
import { connection } from "next/server";
import { submissionExcerpt, VERDICT_LABEL } from "@/domain/acta.ts";
import { caseCardImageUrl } from "@/domain/case-card.ts";
import { COUNSEL, JUDGE, MODEL_NAME, project, type CaseRecord, type ClaimView } from "@/domain/court.ts";
import { GavelIcon, ModelMark, VERDICT_TEXT, VoteChip } from "@/components/marks.tsx";
import { voteId } from "@/components/case-result.tsx";
import { auth0 } from "@/lib/auth0.ts";
import { canRequestCase } from "@/lib/case-access.ts";
import { BetaNotice } from "@/components/beta-notice.tsx";
import { RequestForm } from "@/components/request-form.tsx";
import { CaseLinkStatus } from "@/components/case-link-status.tsx";
import { coverVersions, getEvents, listCases } from "@/store.ts";

const MAX_CLAIMS = 3;
const caseHref = (id: string) => "/caso/" + id;
const shortDate = (at: string) => new Date(at).toLocaleDateString("es-AR", { day: "numeric", month: "short", year: "numeric", timeZone: "America/Argentina/Buenos_Aires" });

function CoverImage({ c, cover }: { c: CaseRecord; cover?: string }) {
  const src = c.status === "resolved" ? caseCardImageUrl(c.id, cover) : c.submission.kind === "image" ? caseHref(c.id) + "/imagen" : cover ? caseHref(c.id) + "/portada?v=" + cover : undefined;
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" loading="lazy" className="size-full object-cover transition duration-500 group-hover:scale-[1.03] motion-reduce:transform-none motion-reduce:transition-none" />;
  }
  return (
    <div className="flex size-full flex-col bg-paper-deep px-5 pb-20 pt-12">
      <span aria-hidden className="font-display text-7xl leading-none text-celeste-deep/50">«</span>
      <p className="mt-2 line-clamp-5 font-display text-xl italic leading-snug text-ink-soft">{submissionExcerpt(c.submission)}</p>
    </div>
  );
}

// Cases without a generated card still show their current status.
function OutcomeStamp({ c }: { c: CaseRecord }) {
  const stamp = "inline-flex items-center gap-2 rounded-sm border border-ink/80 bg-paper/95 px-3 py-1.5 shadow-[3px_3px_0_0_var(--color-ink)]";
  if (c.status === "queued" || c.status === "in_session") {
    return (
      <span className={stamp + " text-xs font-semibold uppercase tracking-wider text-seal"}>
        <span className="session-light size-2 rounded-full bg-seal" /> En curso
      </span>
    );
  }
  return c.status === "failed" ? <span className={stamp + " text-xs uppercase tracking-wider text-ink-soft"}>Interrumpido</span> : null;
}

function ClaimLine({ c, claim, voted }: { c: CaseRecord; claim: ClaimView; voted: boolean }) {
  const j = claim.judgment;
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <Link href={caseHref(c.id) + "#" + claim.id} className="line-clamp-3 font-display text-lg leading-snug transition hover:text-celeste-deep">
        {claim.text}<CaseLinkStatus />
      </Link>
      {voted && (
        <div className="mt-2.5 flex items-center justify-between gap-3">
          <div className="flex gap-1.5" aria-label="Votos de los analistas">
            {COUNSEL.map((m) => {
              const vote = claim.votes[m];
              return vote ? (
                <Link key={m} href={caseHref(c.id) + "#" + voteId(claim.id, m)} aria-label={"Fundamento de " + MODEL_NAME[m] + ": " + VERDICT_LABEL[vote.verdict]} className="rounded-full transition hover:-translate-y-0.5 motion-reduce:transform-none motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-celeste-deep">
                  <VoteChip model={m} verdict={vote.verdict} /><CaseLinkStatus />
                </Link>
              ) : (
                <VoteChip key={m} model={m} />
              );
            })}
          </div>
          {j && (
            <Link href={caseHref(c.id) + "#" + claim.id} className="flex shrink-0 items-center gap-1.5 text-right hover:underline">
              {j.method === "judge" && (
                <span title={"Desempate del moderador (" + MODEL_NAME[JUDGE] + ")"} className="text-seal">
                  <GavelIcon className="size-4" />
                </span>
              )}
              <span className={"font-display text-xl leading-none " + VERDICT_TEXT[j.verdict]}>{VERDICT_LABEL[j.verdict]}</span><CaseLinkStatus />
            </Link>
          )}
        </div>
      )}
    </li>
  );
}

async function CaseCard({ c, cover, index }: { c: CaseRecord; cover?: string; index: number }) {
  const view = c.status === "queued" ? undefined : project(await getEvents(c.id));
  const voted = c.status === "resolved";
  const claims = view?.claims ?? [];
  const hidden = claims.length - MAX_CLAIMS;
  return (
    <li className="reveal" style={{ animationDelay: Math.min(index, 4) * 45 + "ms" }}>
      <article className="flex h-full flex-col overflow-hidden rounded-sm border border-rule bg-paper/70 shadow-[0_1px_0_0_var(--color-rule)]">
        <Link href={caseHref(c.id)} aria-label={"Ver el caso Nº " + c.id} className="group relative block aspect-square overflow-hidden border-b border-rule bg-paper-deep">
          <CoverImage c={c} cover={cover} />
          <CaseLinkStatus />
          {c.status !== "resolved" && (
            <>
              <span className="absolute left-3 top-3 rounded-sm bg-paper/90 px-2 py-1 font-mono text-[11px] text-ink-soft">Nº {c.id}</span>
              <span className="absolute bottom-3 left-3 right-3">
                <OutcomeStamp c={c} />
              </span>
            </>
          )}
        </Link>
        <div className="flex flex-1 flex-col p-4">
          <p className="font-mono text-[11px] uppercase tracking-widest text-ink-soft">
            {shortDate(c.createdAt)} · {claims.length ? claims.length + (claims.length === 1 ? " afirmación" : " afirmaciones") : "Material"}
          </p>
          <div className="mt-2 flex-1">
            {view?.dismissal ? (
              <p className="line-clamp-4 text-sm leading-relaxed text-ink-soft">{view.dismissal}</p>
            ) : claims.length ? (
              <ol className="divide-y divide-rule">
                {claims.slice(0, MAX_CLAIMS).map((claim) => <ClaimLine key={claim.id} c={c} claim={claim} voted={voted} />)}
              </ol>
            ) : (
              <p className="line-clamp-3 font-display text-lg italic leading-snug text-ink-soft">«{submissionExcerpt(c.submission)}»</p>
            )}
          </div>
          <Link href={caseHref(c.id)} className="mt-4 self-start text-sm text-celeste-deep hover:underline">
            {hidden > 0 ? "Ver " + hidden + (hidden === 1 ? " afirmación más" : " afirmaciones más") + " y el debate →" : "Ver fundamentos y debate →"}<CaseLinkStatus />
          </Link>
        </div>
      </article>
    </li>
  );
}

export default async function Home() {
  await connection();
  const [cases, session] = await Promise.all([listCases(24), auth0.getSession()]);
  const covers = await coverVersions(cases.map((c) => c.id));
  return (
    <>
      <section className="grid gap-10 pt-10 md:grid-cols-[1.1fr_1fr] md:items-start">
        <div className="reveal">
          <h1 className="font-display text-5xl leading-[1.02] sm:text-6xl">
            ¿Es cierto lo que leíste? <em className="text-celeste-deep">Que lo chequeen.</em>
          </h1>
          <p className="mt-5 max-w-md text-lg leading-relaxed text-ink-soft">
            Presentá un texto, un enlace o una imagen. Cuatro inteligencias artificiales lo investigan, lo debaten y votan. Nadie edita, nadie opina, todo queda en el registro público.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            {COUNSEL.map((c) => (
              <span key={c} title={MODEL_NAME[c]} className="grid size-11 place-items-center rounded-full border border-rule bg-paper/70">
                <ModelMark model={c} className="size-6" />
              </span>
            ))}
            <Link href="/metodo" className="ml-2 text-sm text-celeste-deep underline decoration-celeste/40 underline-offset-4 hover:decoration-celeste-deep">
              Cómo trabaja el panel →
            </Link>
          </div>
        </div>
        <div className="reveal [animation-delay:80ms]">
          {canRequestCase(session?.user) ? <RequestForm /> : <BetaNotice signedIn={!!session?.user.sub} />}
        </div>
      </section>

      <section className="mt-16">
        <div className="rule-double flex flex-wrap items-baseline justify-between gap-2 pt-4">
          <h2 className="font-display text-4xl">Casos recientes</h2>
          <p className="text-xs text-ink-soft">Tocá el voto de cada IA para leer su fundamento.</p>
        </div>
        {cases.length === 0 ? (
          <p className="mt-4 text-ink-soft">Todavía no hay casos. Pedí el primero.</p>
        ) : (
          <ul className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {cases.map((c, i) => (
              <CaseCard key={c.id} c={c} cover={covers.get(c.id)} index={i} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
