import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspended } from "@/components/suspended.tsx";
import { Acta } from "@/components/acta.tsx";
import { EvidencePanel, toEvidencePanelItems, type EvidencePanelItem } from "@/components/evidence-panel.tsx";
import { AutoRefresh } from "@/components/auto-refresh.tsx";
import { GavelIcon } from "@/components/marks.tsx";
import { CaseResult } from "@/components/case-result.tsx";
import { caseShareMetadata, submissionExcerpt } from "@/domain/acta.ts";
import { COUNSEL_NAMES, type CaseRecord } from "@/domain/court.ts";
import { project } from "@/domain/court.ts";
import { blobConfigured, readEvidenceTree } from "@/evidence/blob.ts";
import { auth0 } from "@/lib/auth0.ts";
import { getCase, getEvents } from "@/store.ts";

export async function generateMetadata(props: PageProps<"/caso/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  const c = await getCase(id);
  if (!c) return { title: "Grokeado" };
  const events = c.status === "resolved" ? await getEvents(id) : [];
  const { title, description } = caseShareMetadata(c, events);
  return {
    title,
    description,
    openGraph: { title, description, type: "article" },
    twitter: { card: "summary", title, description },
  };
}

const date = (at: string) => new Date(at).toLocaleString("es-AR", { dateStyle: "long", timeStyle: "short", timeZone: "America/Argentina/Buenos_Aires" });

function InSession({ c }: { c: CaseRecord }) {
  return (
    <section className="mx-auto max-w-2xl py-16 text-center">
      <AutoRefresh everyMs={5000} />
      <div className="inline-flex items-center gap-2 rounded-full border border-seal/40 px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.25em] text-seal">
        <span className="session-light size-2.5 rounded-full bg-seal" /> En curso
      </div>
      <div className="mx-auto mt-8 grid size-28 place-items-center rounded-full border-2 border-ink bg-paper/60">
        <GavelIcon className="gavel size-14 text-ink" />
      </div>
      <h1 className="mt-8 font-display text-5xl sm:text-6xl">El panel está analizando</h1>
      <p className="mx-auto mt-4 max-w-md text-ink-soft">
        {COUNSEL_NAMES} están investigando y debatiendo tu consulta. Cuando terminen vas a ver el resultado y el registro completo. Esta página se actualiza sola.
      </p>
      <p className="mx-auto mt-8 line-clamp-3 max-w-lg font-display text-lg italic text-ink-soft">«{submissionExcerpt(c.submission)}»</p>
      <p className="mt-6 font-mono text-xs text-ink-soft">Caso Nº {c.id}</p>
    </section>
  );
}

export default async function CasePage(props: PageProps<"/caso/[id]">) {
  await connection();
  const { id } = await props.params;
  const c = await getCase(id);
  if (!c) notFound();
  if (c.status === "queued" || c.status === "in_session") return <InSession c={c} />;
  if (c.status === "failed") {
    const session = await auth0.getSession();
    return <Suspended c={c} user={session?.user} />;
  }

  const events = await getEvents(id);
  let evidenceItems: EvidencePanelItem[] = [];
  if (blobConfigured()) {
    evidenceItems = toEvidencePanelItems(await readEvidenceTree(id));
  }
  const simulated = events.some((e) => e.type === "session_opened" && e.simulated);
  const view = project(events);
  const byJudge = view.claims.filter((cl) => cl.judgment?.method === "judge").length;

  return (
    <>
      <header className="reveal flex flex-wrap items-end justify-between gap-4 pt-8">
        <div>
          <p className="font-mono text-xs uppercase tracking-widest text-ink-soft">Caso Nº {c.id} · {date(c.createdAt)}</p>
          <h1 className="mt-2 font-display text-5xl">{view.dismissal ? "Caso descartado" : "Resultado"}</h1>
        </div>
        {!view.dismissal && (
          <p className="max-w-xs text-right text-sm text-ink-soft">
            {view.claims.length} {view.claims.length === 1 ? "afirmación examinada" : "afirmaciones examinadas"}
            {byJudge > 0 ? ", " + byJudge + " " + (byJudge === 1 ? "desempatada" : "desempatadas") + " por el moderador" : ", todas por mayoría"}.
          </p>
        )}
      </header>

      {simulated && <p role="status" className="mt-4 rounded-sm border border-seal/40 bg-seal/5 p-4 text-sm text-seal">Simulación local: las fuentes, respuestas y el resultado son ficticios y solo sirven para probar el flujo.</p>}

      <CaseResult c={c} view={view} />

      <section className="mt-16">
        <div className="rule-double pt-4">
          <h2 className="font-display text-4xl">Registro del debate</h2>
          <p className="mt-1 text-sm text-ink-soft">Todo lo que pasó en el debate, completo y en orden.</p>
        </div>
        <div className="mt-8">
          <Acta events={events} view={view} caseId={id} />
        </div>
      </section>

      <EvidencePanel caseId={id} items={evidenceItems} />
    </>
  );
}
