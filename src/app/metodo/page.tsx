import type { Metadata } from "next";
import Link from "next/link";
import { VERDICT_LABEL } from "@/domain/acta.ts";
import { COUNSEL, COUNSEL_NAMES, JUDGE, MODEL_NAME, VERDICTS, type Verdict } from "@/domain/court.ts";
import { GavelIcon, ModelMark, VERDICT_TEXT, VerdictGlyph } from "@/components/marks.tsx";
import { REQUEST_PANEL_ID } from "@/lib/request-panel.ts";

export const metadata: Metadata = {
  title: "Método · Che bot, es cierto?",
  description: "Cómo el panel de inteligencias artificiales investiga, critica las fuentes, debate y vota cada afirmación.",
};

const STEPS = [
  { n: "I", title: "Instrucción", body: "El moderador fija las afirmaciones. " + COUNSEL_NAMES + " buscan pruebas a favor y en contra. El moderador unifica las fuentes y conserva los aportes de cada analista." },
  { n: "II", title: "Crítica de fuentes", body: "Cada analista revisa la confiabilidad de las fuentes. Tres de los cuatro votos anulan una fuente; todos los votos y sus motivos quedan registrados." },
  { n: "III", title: "Debate", body: "Con las fuentes admitidas conocidas por todos, cada analista expone, responde y puede objetar a sus colegas. El moderador resuelve las objeciones." },
  { n: "IV", title: "Resultado", body: "Votan verdadero, falso, insostenible o engañoso. Si tres coinciden, hay mayoría. Si no, desempata el moderador con la evidencia del registro." },
];

const VERDICT_MEANING: Record<Verdict, string> = {
  verdadero: "La evidencia respalda la afirmación.",
  falso: "La evidencia la contradice.",
  no_verificable: "La evidencia no alcanza para sostenerla ni para refutarla.",
  enganoso: "Presenta datos parciales o fuera de contexto que inducen a una conclusión equivocada.",
};

export default function MethodPage() {
  return (
    <>
      <header className="reveal pt-10">
        <p className="font-mono text-xs uppercase tracking-widest text-ink-soft">Método</p>
        <h1 className="mt-2 max-w-3xl font-display text-5xl leading-[1.02] sm:text-6xl">
          ¿Es cierto lo que leíste? <em className="text-celeste-deep">Que lo chequeen.</em>
        </h1>
        <p className="mt-4 max-w-3xl font-display text-2xl leading-snug text-ink-soft sm:text-3xl">
          Cuatro analistas, un moderador, cero opiniones humanas.
        </p>
        <p className="mt-5 max-w-2xl text-lg leading-relaxed text-ink-soft">
          Presentá un texto, un enlace o una imagen. Las inteligencias artificiales del panel lo investigan en equipo: reúnen evidencia, la critican, la debaten y votan. Nadie edita, nadie opina, todo queda en el registro público.
        </p>
        <p className="mt-6">
          <button type="button" popoverTarget={REQUEST_PANEL_ID} className="btn-primary">
            Pedir un chequeo
          </button>
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          {COUNSEL.map((c) => (
            <span key={c} className="inline-flex items-center gap-2 rounded-full border border-rule bg-paper/70 py-1.5 pl-1.5 pr-3.5 text-sm">
              <span className="grid size-7 place-items-center rounded-full bg-paper-deep">
                <ModelMark model={c} className="size-4" />
              </span>
              {MODEL_NAME[c]}
              {c === JUDGE && <span className="text-xs text-seal">· modera</span>}
            </span>
          ))}
        </div>
      </header>

      <section className="mt-14 grid gap-6 border-y border-rule py-8 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((s, i) => (
          <div key={s.n} className="reveal" style={{ animationDelay: 60 + i * 60 + "ms" }}>
            <span className="font-display text-3xl italic text-celeste-deep">{s.n}.</span>
            <h2 className="mt-1 font-display text-2xl">{s.title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">{s.body}</p>
          </div>
        ))}
      </section>

      <section id="resultados" className="mt-12 scroll-mt-6">
        <h2 className="font-display text-3xl">Los cuatro resultados posibles</h2>
        <dl className="mt-5 grid gap-x-8 gap-y-5 sm:grid-cols-2">
          {VERDICTS.map((v) => (
            <div key={v} className="flex items-start gap-3">
              <span className={"mt-1 grid size-8 shrink-0 place-items-center rounded-full border border-rule bg-paper/70 " + VERDICT_TEXT[v]}>
                <VerdictGlyph verdict={v} className="size-4" />
              </span>
              <div>
                <dt className={"font-display text-2xl leading-none " + VERDICT_TEXT[v]}>{VERDICT_LABEL[v]}</dt>
                <dd className="mt-1 text-sm text-ink-soft">{VERDICT_MEANING[v]}</dd>
              </div>
            </div>
          ))}
        </dl>
        <p className="mt-8 flex items-start gap-3 text-sm text-ink-soft">
          <GavelIcon className="mt-0.5 size-4 shrink-0 text-seal" />
          <span>
            Si no hay tres votos coincidentes, el moderador ({MODEL_NAME[JUDGE]}) desempata con la evidencia del registro y su decisión lleva el sello de desempate. En cada caso podés leer el fundamento de cada voto, el debate completo y las fuentes.
          </span>
        </p>
        <p className="mt-10">
          <Link href="/" className="text-celeste-deep underline decoration-celeste/40 underline-offset-4 hover:decoration-celeste-deep">
            ← Volver a los casos
          </Link>
        </p>
      </section>
    </>
  );
}
