import Link from "next/link";
import { connection } from "next/server";
import { submissionExcerpt } from "@/domain/acta.ts";
import { COUNSEL, JUDGE, project, type CaseRecord } from "@/domain/court.ts";
import { JudgeSeal, ModelMark, VERDICT_TEXT, VerdictGlyph } from "@/components/marks.tsx";
import { RequestForm } from "@/components/request-form.tsx";
import { getEvents, listCases } from "@/store.ts";

const STEPS = [
  { n: "I", title: "Instrucción", body: "El juez fija las afirmaciones verificables. Grok, Gemini y Claude investigan por separado y presentan prueba con fuente." },
  { n: "II", title: "Debate", body: "Cada letrado alega, replica y puede objetar a sus colegas. El juez resuelve las objeciones y testa lo que no se sostiene." },
  { n: "III", title: "Fallo", body: "Votan verdadero, falso o no verificable. Si dos coinciden, hay mayoría. Si no, decide el juez con la prueba del acta." },
];

function CaseRow({ c }: { c: CaseRecord }) {
  const view = c.status === "resolved" ? project(getEvents(c.id)) : undefined;
  return (
    <li>
      <Link href={"/caso/" + c.id} className="group grid grid-cols-[auto_1fr_auto] items-center gap-4 border-b border-rule py-4 transition hover:bg-white/40">
        <span className="font-mono text-xs text-ink-soft">Nº {c.id}</span>
        <span className="line-clamp-2 font-display text-xl leading-snug group-hover:text-celeste-deep">{submissionExcerpt(c.submission)}</span>
        <span className="flex items-center gap-1.5">
          {view?.dismissal && <span className="text-xs uppercase tracking-wider text-ink-soft">Desestimada</span>}
          {view?.claims.map((claim) =>
            claim.judgment?.method === "judge" ? (
              <span key={claim.id} className="scale-75">
                <JudgeSeal verdict={claim.judgment.verdict} model={JUDGE} />
              </span>
            ) : claim.judgment ? (
              <span key={claim.id} title={claim.text} className={"grid size-7 place-items-center rounded-full border border-rule bg-white/70 " + VERDICT_TEXT[claim.judgment.verdict]}>
                <VerdictGlyph verdict={claim.judgment.verdict} className="size-3.5" />
              </span>
            ) : null
          )}
          {(c.status === "queued" || c.status === "in_session") && (
            <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-seal">
              <span className="session-light size-2 rounded-full bg-seal" /> En sesión
            </span>
          )}
          {c.status === "failed" && <span className="text-xs uppercase tracking-wider text-ink-soft">Suspendida</span>}
        </span>
      </Link>
    </li>
  );
}

export default async function Home() {
  await connection();
  const cases = listCases(20);
  return (
    <>
      <section className="grid gap-10 pt-10 md:grid-cols-[1.1fr_1fr] md:items-start">
        <div className="reveal">
          <h1 className="font-display text-5xl leading-[1.02] sm:text-6xl">
            ¿Es cierto lo que leíste? <em className="text-celeste-deep">Que lo juzguen.</em>
          </h1>
          <p className="mt-5 max-w-md text-lg leading-relaxed text-ink-soft">
            Presentá un texto, un enlace o una imagen. Tres inteligencias artificiales lo investigan como en un juicio: reúnen prueba, discuten en audiencia y votan. Nadie edita, nadie opina, todo queda en el acta.
          </p>
          <div className="mt-6 flex items-center gap-3">
            {COUNSEL.map((c) => (
              <span key={c} className="grid size-11 place-items-center rounded-full border border-rule bg-white/70">
                <ModelMark model={c} className="size-6" />
              </span>
            ))}
            <span className="ml-2 text-sm text-ink-soft">Letrados en sala</span>
          </div>
        </div>
        <div className="reveal [animation-delay:120ms]">
          <RequestForm />
        </div>
      </section>

      <section className="mt-16 grid gap-6 border-y border-rule py-8 sm:grid-cols-3">
        {STEPS.map((s, i) => (
          <div key={s.n} className="reveal" style={{ animationDelay: 200 + i * 90 + "ms" }}>
            <span className="font-display text-3xl italic text-celeste-deep">{s.n}.</span>
            <h3 className="mt-1 font-display text-2xl">{s.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">{s.body}</p>
          </div>
        ))}
      </section>

      <section className="mt-12">
        <h2 className="font-display text-3xl">Causas recientes</h2>
        {cases.length === 0 ? (
          <p className="mt-4 text-ink-soft">Todavía no hay causas. Presentá la primera.</p>
        ) : (
          <ul className="mt-2">
            {cases.map((c) => (
              <CaseRow key={c.id} c={c} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
