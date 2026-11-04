import { ABSENCE_LABEL, EVIDENCE_STANCE_LABEL, STAGE_LABEL, VERDICT_LABEL } from "@/domain/acta.ts";
import { COUNSEL, MODEL_NAME, seatModels, type CaseView, type Counsel, type RecordedEvent, type SeatModels, type SourceView, type Stage } from "@/domain/court.ts";
import { FoldButtons, FoldNavigation } from "./acta-folding.tsx";
import { CitationLink, Cited, citationHref, citationRefs, mentions, type Citations } from "./citations.tsx";
import { GavelIcon, JudgeSeal, ModelMark, VERDICT_TEXT, VerdictGlyph } from "./marks.tsx";

const time = (at: string) =>
  new Date(at).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "America/Argentina/Buenos_Aires" });

interface Context extends Citations {
  view: CaseView;
  sourceAliases: ReadonlyMap<string, string>;
  models: SeatModels;
}

function Speaker({ by, small }: { by: Counsel; small?: boolean }) {
  return (
    <span className="flex w-9 shrink-0 justify-center">
      <span className={"grid shrink-0 place-items-center rounded-full border border-rule bg-paper " + (small ? "size-5" : "size-9")}>
        <ModelMark model={by} className={small ? "size-3" : "size-5"} />
      </span>
    </span>
  );
}

function Chevron() {
  return (
    <svg className="fold-chevron size-3.5 shrink-0 text-ink-soft transition-transform" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function Clerk({ children }: { children: React.ReactNode }) {
  return <p className="py-1 text-center font-mono text-[11px] uppercase tracking-[0.18em] text-ink-soft">{children}</p>;
}

function Source({ source, ctx }: { source: SourceView; ctx: Context }) {
  const contributors = COUNSEL.filter((c) => source.contributions.some((e) => e.by === c));
  const vetoes = COUNSEL.filter((c) => source.votes[c]?.veto).length;
  return (
    <details open id={source.id} className="fold scroll-mt-24 rounded-sm border border-rule bg-paper/60 px-4 py-3 target:ring-2 target:ring-celeste">
      <summary className="fold-summary flex cursor-pointer items-start gap-2">
        {ctx.sourceAliases.has(source.id) && <span id={ctx.sourceAliases.get(source.id)} className="scroll-mt-24" />}
        <span className="mt-0.5"><Chevron /></span>
        <span className="min-w-0">
          <span className="block text-xs text-ink-soft">
            <span className="font-mono font-medium text-ink">{source.id}</span>{" · "}
            <span className={source.excluded ? "font-semibold text-seal" : "font-semibold"}>
              {source.excluded ? "Anulada" : source.excluded === false ? "Admitida" : "Pendiente de crítica"}
            </span>
            {source.excluded !== undefined && " · " + vetoes + "/4 votos por anular"}
          </span>
          <a href={source.url} target="_blank" rel="noreferrer noopener" className="mt-1 block font-medium text-celeste-deep underline underline-offset-2">{source.title}</a>
        </span>
      </summary>
      <div className="pl-5.5">
        <p className="mt-1 text-xs text-ink-soft">Aportada por {contributors.map((c) => MODEL_NAME[c]).join(", ")}</p>
        <ul className="mt-2 space-y-2 text-sm">
          {source.contributions.map((e) => (
            <li key={e.id} className={source.excluded ? "struck text-ink-soft" : "text-ink-soft"}>
              <span className="font-semibold">{MODEL_NAME[e.by]} · {e.claimId} · {EVIDENCE_STANCE_LABEL[e.stance ?? "context"]}:</span> {e.excerpt}
            </li>
          ))}
        </ul>
        {source.excluded && <p className="mt-2 text-sm font-semibold text-seal">No puede usarse como prueba en las exposiciones ni en el resultado.</p>}
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-celeste-deep">Votos y fundamentos sobre la confiabilidad</summary>
          <ul className="mt-2 space-y-1">
            {COUNSEL.map((c) => (
              <li key={c}>
                <span className="font-semibold">{MODEL_NAME[c]}:</span>{" "}
                {source.votes[c] ? <>{source.votes[c].veto ? "Vetar" : "No vetar"}. <Cited text={source.votes[c].reason} ctx={ctx} /></> : "No votó."}
              </li>
            ))}
          </ul>
        </details>
      </div>
    </details>
  );
}

function Statement({ e, ctx }: { e: Extract<RecordedEvent, { type: "statement" }>; ctx: Context }) {
  const struck = ctx.view.struck.has(e.id);
  const mentioned = new Set(mentions(e.text, ctx).map((m) => m.token));
  // Citations the analyst declared without mentioning them in the text keep a discreet link.
  const unmentioned = e.evidenceIds.filter((id) => !mentioned.has(id));
  return (
    <div id={e.id} className="scroll-mt-24">
      <p className={"whitespace-pre-line font-display text-lg leading-snug " + (struck ? "struck" : "")}><Cited text={e.text} ctx={ctx} /></p>
      {unmentioned.length > 0 && (
        <p className="mt-1 text-xs text-ink-soft">
          También cita:{" "}
          {unmentioned.map((id, i) => (
            <span key={id}>
              {i > 0 && ", "}
              <CitationLink id={id} href={citationHref(id, ctx) ?? "#" + id} />
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

function Entry({ e, ctx }: { e: RecordedEvent; ctx: Context }) {
  const { view } = ctx;
  switch (e.type) {
    case "session_opened":
      return <Clerk>{e.simulated && "Simulación local · fuentes y respuestas ficticias · "}Empieza el debate · {time(e.at)}</Clerk>;
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
        <div id={e.evidence.id} className="scroll-mt-24 rounded-sm border border-rule bg-paper/60 px-4 py-3 target:ring-2 target:ring-celeste">
          <div className="flex items-center gap-2 text-xs text-ink-soft">
            <span className="font-mono font-medium text-ink">{e.evidence.id}</span>
            <ModelMark model={e.evidence.by} className="size-3.5" />
            <span>Aporte de {MODEL_NAME[e.evidence.by]} sobre {e.evidence.claimId}{e.evidence.stance && " · " + EVIDENCE_STANCE_LABEL[e.evidence.stance]}</span>
          </div>
          <a href={e.evidence.url} target="_blank" rel="noreferrer noopener" className="mt-1 block font-medium text-celeste-deep underline decoration-celeste/40 underline-offset-2 hover:decoration-celeste-deep">
            {e.evidence.title}
          </a>
          <p className="mt-1 text-sm text-ink-soft">{e.evidence.excerpt}</p>
        </div>
      );
    case "instruction_opened":
      return null;
    case "instruction_completed":
      return (
        <details className="text-sm text-ink-soft">
          <summary className="cursor-pointer">{MODEL_NAME[e.by]} cierra sus aportes · búsquedas en ambos sentidos</summary>
          <ul className="mt-2 space-y-2">
            {e.searches.map((s) => <li key={s.claimId}><span className="font-mono">{s.claimId}</span><p>A favor: {s.supporting}</p><p>En contra: {s.opposing}</p></li>)}
          </ul>
        </details>
      );
    case "evidence_unified":
      return (
        <div className="space-y-3">
          <p className="font-semibold">El moderador unifica las pruebas · expediente común</p>
          <p className="text-sm text-ink-soft">Cada fuente conserva los aportes de todos los analistas. A continuación se vota su confiabilidad.</p>
          {e.sources.map((s) => <Source key={s.id} source={view.sources.get(s.id)!} ctx={ctx} />)}
          {!e.sources.length && <p className="text-sm text-ink-soft">No se aportaron pruebas.</p>}
        </div>
      );
    case "source_review_vote":
      return <p className="text-sm"><span className="font-semibold">{MODEL_NAME[e.by]}</span> vota {e.veto ? "vetar" : "no vetar"} <a href={"#" + e.sourceId} className="font-mono text-celeste-deep hover:underline">{e.sourceId}</a>: <span className="text-ink-soft"><Cited text={e.reason} ctx={ctx} /></span></p>;
    case "source_decided":
      return <p className={"text-sm " + (e.excluded ? "text-seal" : "text-ink-soft")}><a href={"#" + e.sourceId} className="font-mono hover:underline">{e.sourceId}</a>: {e.excluded ? "anulada por mayoría (al menos 3 de 4 votos)." : "admitida; no hubo mayoría para anularla."}</p>;
    case "instruction_closed":
      return <Clerk>Termina la instrucción · fuentes fijadas para las exposiciones</Clerk>;
    case "floor_granted":
      return <Clerk>El moderador da la palabra a {MODEL_NAME[e.to]} · {STAGE_LABEL[e.stage]}</Clerk>;
    case "statement":
      return <Statement e={e} ctx={ctx} />;
    case "objection":
      return (
        <div id={e.id} className="scroll-mt-24 border-l-4 border-seal pl-4">
          <p className="font-display text-xl italic text-seal">Objeción <span className="font-mono text-xs not-italic text-ink-soft">{e.id}</span></p>
          <p className="text-sm">
            <span className="font-semibold">{MODEL_NAME[e.by]}</span> objeta <a href={"#" + e.against} className="font-mono text-celeste-deep hover:underline">{e.against}</a>: <Cited text={e.grounds} ctx={ctx} />
          </p>
        </div>
      );
    case "objection_reply":
      return (
        <div className="pl-5 text-sm">
          <span className="font-semibold">{MODEL_NAME[e.by]}</span> responde: <span className="text-ink-soft"><Cited text={e.text} ctx={ctx} /></span>
        </div>
      );
    case "ruling":
      return (
        <div className="flex items-start gap-2 pl-5 text-sm">
          <GavelIcon className="mt-0.5 size-4 shrink-0 text-seal" />
          <p>
            <span className={"font-bold uppercase tracking-wide " + (e.sustained ? "text-seal" : "text-ink")}>{e.sustained ? "Objeción aceptada" : "Objeción rechazada"}.</span>{" "}
            <span className="text-ink-soft"><Cited text={e.reason} ctx={ctx} /></span>
          </p>
        </div>
      );
    case "vote":
      return (
        <div className="flex items-start gap-2 text-sm">
          <ModelMark model={e.by} className="mt-0.5 size-4 shrink-0" />
          <p>
            <span className="font-semibold">{MODEL_NAME[e.by]}</span> vota <span className={"font-semibold " + VERDICT_TEXT[e.verdict]}>{VERDICT_LABEL[e.verdict]}</span> sobre {e.claimId}. <span className="text-ink-soft"><Cited text={e.rationale} ctx={ctx} /></span>
          </p>
        </div>
      );
    case "judgment":
      return e.method === "judge" ? (
        <div className="flex items-start gap-4 rounded-sm border border-seal/40 bg-seal/5 p-4">
          <JudgeSeal verdict={e.verdict} judge={ctx.models.judge} />
          <p className="text-sm">
            <span className="font-semibold">Desempate del moderador sobre {e.claimId}: </span>
            <span className={"font-semibold " + VERDICT_TEXT[e.verdict]}>{VERDICT_LABEL[e.verdict]}.</span> <span className="text-ink-soft"><Cited text={e.reasoning} ctx={ctx} /></span>
          </p>
        </div>
      ) : (
        <p className="flex items-center justify-center gap-2 text-sm">
          <span className={VERDICT_TEXT[e.verdict]}><VerdictGlyph verdict={e.verdict} className="size-4" /></span>
          Resultado de {e.claimId}: <span className={"font-semibold " + VERDICT_TEXT[e.verdict]}>{VERDICT_LABEL[e.verdict]}</span>, por mayoría.
        </p>
      );
    case "case_summary":
      return (
        <div className="text-sm">
          <p className="font-semibold">Resumen del moderador</p>
          <p className="mt-1 whitespace-pre-line text-ink-soft">{e.text}</p>
        </div>
      );
    case "absence":
      return <Clerk>{MODEL_NAME[e.by]} no se pronunció en la {ABSENCE_LABEL[e.stage]}</Clerk>;
    case "session_closed":
      return <Clerk>Termina el debate · {time(e.at)}</Clerk>;
  }
}

// Entries that hang from a speaker above them sit indented under the speakers' column.
const INDENTED = new Set<RecordedEvent["type"]>([
  "evidence_filed", "instruction_completed", "evidence_unified", "source_review_vote", "source_decided",
  "objection", "objection_reply", "ruling", "vote", "case_summary",
]);

type SectionKey = "apertura" | "instruccion" | "fuentes" | Stage | "resultado";

const SECTION_TITLE: Record<SectionKey, string> = {
  apertura: "Apertura",
  instruccion: "Instrucción",
  fuentes: "Crítica de fuentes",
  opening: "Exposiciones iniciales",
  rebuttal: "Réplicas",
  closing: "Conclusiones y votos",
  resultado: "Resultado",
};

// One analyst's run within a stage: the contributions of the instruction up to their
// closing, or a turn of the debate with its objections and votes.
interface Group {
  kind: "group";
  by: Counsel;
  seq: number;
  stage?: Stage;
  events: RecordedEvent[];
  closing?: Extract<RecordedEvent, { type: "instruction_completed" }>;
}
type Item = { kind: "event"; e: RecordedEvent } | Group;
interface Section {
  key: SectionKey;
  events: RecordedEvent[];
}

function sectionsOf(events: readonly RecordedEvent[]): Section[] {
  const sections: Section[] = [];
  let key: SectionKey = "apertura";
  for (const e of events) {
    if (e.type === "instruction_opened") key = "instruccion";
    else if ((e.type === "evidence_filed" || e.type === "instruction_completed") && key === "apertura") key = "instruccion";
    else if (e.type === "evidence_unified") key = "fuentes";
    else if (e.type === "floor_granted" || e.type === "statement") key = e.stage;
    else if (e.type === "judgment" || e.type === "session_closed") key = "resultado";
    const last = sections.at(-1);
    if (last?.key === key) last.events.push(e);
    else sections.push({ key, events: [e] });
  }
  return sections;
}

function itemsOf(section: Section): Item[] {
  const items: Item[] = [];
  let group: Group | undefined;
  const open = (by: Counsel, e: RecordedEvent, stage?: Stage): Group => {
    group = { kind: "group", by, seq: e.seq, stage, events: [] };
    items.push(group);
    return group;
  };
  for (const e of section.events) {
    if (e.type === "instruction_opened") continue;
    if (section.key === "instruccion") {
      const by = e.type === "evidence_filed" ? e.evidence.by : e.type === "instruction_completed" || e.type === "absence" ? e.by : undefined;
      if (!by) {
        group = undefined;
        items.push({ kind: "event", e });
        continue;
      }
      const current = group && group.by === by && !group.closing ? group : open(by, e);
      if (e.type === "instruction_completed") current.closing = e;
      else current.events.push(e);
    } else if (section.key === "opening" || section.key === "rebuttal" || section.key === "closing") {
      if (e.type === "floor_granted") {
        open(e.to, e, e.stage);
        continue;
      }
      const hasStatement = group?.events.some((x) => x.type === "statement");
      if (e.type === "statement" && (!group || group.by !== e.by || hasStatement)) open(e.by, e, e.stage);
      const thread = e.type === "objection" || e.type === "objection_reply" || e.type === "ruling" || (e.type === "absence" && e.stage === "objection");
      const own = (e.type === "statement" || e.type === "vote" || e.type === "absence" || e.type === "evidence_filed") && (e.type === "evidence_filed" ? e.evidence.by : e.by) === group?.by;
      if (group && (thread || own)) group.events.push(e);
      else {
        group = undefined;
        items.push({ kind: "event", e });
      }
    } else items.push({ kind: "event", e });
  }
  return items;
}

function summaryOf(section: Section, view: CaseView): string {
  const count = (type: RecordedEvent["type"]) => section.events.filter((e) => e.type === type).length;
  const plural = (n: number, one: string, many: string) => n + " " + (n === 1 ? one : many);
  switch (section.key) {
    case "apertura":
      return view.dismissal ? "Caso descartado" : plural(view.claims.length, "afirmación a examinar", "afirmaciones a examinar");
    case "instruccion": {
      const analysts = new Set(section.events.flatMap((e) => (e.type === "evidence_filed" ? [e.evidence.by] : [])));
      return "Pruebas a favor y en contra · " + plural(count("evidence_filed"), "prueba", "pruebas") + " de " + plural(analysts.size, "analista", "analistas");
    }
    case "fuentes": {
      const sources = [...view.sources.values()];
      return "Expediente común · " + plural(sources.length, "fuente", "fuentes") + " · " + plural(sources.filter((s) => s.excluded).length, "anulada", "anuladas");
    }
    case "resultado":
      return plural(count("judgment"), "resultado", "resultados");
    default: {
      const parts = [plural(count("statement"), "intervención", "intervenciones")];
      if (count("objection")) parts.push(plural(count("objection"), "objeción", "objeciones"));
      if (count("vote")) parts.push(plural(count("vote"), "voto", "votos"));
      return parts.join(" · ");
    }
  }
}

function groupTitle(group: Group, ctx: Context): React.ReactNode {
  const statement = group.events.find((e) => e.type === "statement");
  if (!group.stage) {
    const filed = group.events.filter((e) => e.type === "evidence_filed").length;
    return (
      <>
        <span className="font-semibold">{MODEL_NAME[group.by]}</span>
        <span className="text-ink-soft"> · aportes de pruebas · {filed} {filed === 1 ? "prueba" : "pruebas"}</span>
      </>
    );
  }
  return (
    <>
      <span className="font-semibold">{MODEL_NAME[group.by]}</span>
      <span className="text-ink-soft"> · {STAGE_LABEL[group.stage]}</span>
      {statement && <span className="font-mono text-xs text-ink-soft"> · {statement.id}</span>}
      {statement && ctx.view.struck.has(statement.id) && <span className="ml-2 rounded-sm bg-seal px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-paper">Anulado</span>}
    </>
  );
}

function GroupFold({ group, ctx }: { group: Group; ctx: Context }) {
  const statement = group.events.find((e) => e.type === "statement");
  return (
    <details open className="fold">
      <summary className="fold-summary flex cursor-pointer items-center gap-3">
        <Speaker by={group.by} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm">{groupTitle(group, ctx)}</span>
          {statement && <span className="fold-preview text-sm text-ink-soft">{statement.text}</span>}
        </span>
        <Chevron />
      </summary>
      {/* The rail runs from the analyst's mark down to the close of their run. */}
      <div className={"ml-[17px] space-y-3 border-l border-rule pt-2 pl-4 sm:pl-[30px] " + (group.closing ? "pb-3" : "fold-rail-end pb-1")}>
        {group.events.map((e) => <div key={e.seq}><Entry e={e} ctx={ctx} /></div>)}
      </div>
      {group.closing && (
        <div className="flex items-start gap-3">
          <Speaker by={group.by} small />
          <div className="min-w-0 flex-1 pt-0.5"><Entry e={group.closing} ctx={ctx} /></div>
        </div>
      )}
    </details>
  );
}

function SectionFold({ section, index, ctx }: { section: Section; index: number; ctx: Context }) {
  const title = SECTION_TITLE[section.key];
  const items = itemsOf(section);
  return (
    <div data-fold-scope="section" className="relative">
      <details id={"etapa-" + (index + 1)} className="fold scroll-mt-24">
        <summary className="fold-summary flex cursor-pointer items-center gap-3 border-b border-rule pb-2 pr-20">
          <Chevron />
          <span className="min-w-0">
            <h3 className="inline font-display text-2xl">{title}</h3>
            <span className="block text-xs text-ink-soft sm:ml-3 sm:inline">{summaryOf(section, ctx.view)}</span>
          </span>
        </summary>
        <ol className="mt-4 space-y-4">
          {items.map((item) => (
            item.kind === "group" ? (
              <li key={item.seq}><GroupFold group={item} ctx={ctx} /></li>
            ) : (
              <li key={item.e.seq} className={INDENTED.has(item.e.type) ? "ml-4 sm:ml-12" : undefined}><Entry e={item.e} ctx={ctx} /></li>
            )
          ))}
        </ol>
      </details>
      <div className="absolute right-0 top-1">
        <FoldButtons label={title} />
      </div>
    </div>
  );
}

export function Acta({ events, view, caseId, sourceAliases = new Map(), models = seatModels({}, events) }: { events: RecordedEvent[]; view: CaseView; caseId: string; sourceAliases?: ReadonlyMap<string, string>; models?: SeatModels }) {
  // La tarjeta ya muestra el resumen, los votos y la decisión proyectados; conservar solo
  // eventos que no estén representados allí (por ejemplo, registros incompletos).
  const visible = events.filter((e) => {
    if (e.type === "case_summary") return false;
    if (e.type === "source_review_vote") {
      const vote = view.sources.get(e.sourceId)?.votes[e.by];
      return !vote || vote.veto !== e.veto || vote.reason !== e.reason;
    }
    if (e.type === "source_decided") return view.sources.get(e.sourceId)?.excluded !== e.excluded;
    return true;
  });
  const sections = sectionsOf(visible);
  const ctx: Context = { view, caseId, refs: citationRefs(events, view), sourceAliases, models };
  return (
    <div data-acta data-fold-scope="acta">
      <FoldNavigation />
      <div className="mb-6 flex items-center justify-end gap-2 text-xs text-ink-soft">
        <span>Todas las etapas</span>
        <FoldButtons label="todas las etapas" />
      </div>
      <div className="space-y-10">
        {sections.map((section, i) => <SectionFold key={i} section={section} index={i} ctx={ctx} />)}
      </div>
    </div>
  );
}