import type { CaseView, RecordedEvent } from "@/domain/court.ts";

export function evidenceHref(caseId: string, citation: string): string {
  const [path, anchor] = citation.slice("/evidence/".length).split("#", 2);
  const encodedPath = path!.split("/").map(encodeURIComponent).join("/");
  return `/c/${encodeURIComponent(caseId)}/evidence/${encodedPath}${anchor ? `#${encodeURIComponent(anchor)}` : ""}`;
}

// What free text of the case can point to: the unified sources (E, or S in historical records), contributions (P),
// interventions (I) and objections (O) of the record, and the OKF evidence pages.
export interface Citations {
  caseId: string;
  refs: ReadonlyMap<string, string>;
}

export function citationRefs(events: readonly RecordedEvent[], view: CaseView): Map<string, string> {
  const refs = new Map<string, string>();
  for (const e of events) {
    if (e.type === "statement" || e.type === "objection") refs.set(e.id, "#" + e.id);
    if (e.type === "evidence_filed") refs.set(e.evidence.id, "#" + e.evidence.id);
  }
  for (const id of view.sources.keys()) refs.set(id, "#" + id);
  return refs;
}

const MENTION = /\/evidence\/[^\s)\]},;]+|\b[A-Z]\d{1,3}\b/g;

export function citationHref(token: string, ctx: Citations): string | undefined {
  return token.startsWith("/evidence/") ? evidenceHref(ctx.caseId, token) : ctx.refs.get(token);
}

export function mentions(text: string, ctx: Citations): { token: string; index: number; href: string }[] {
  return [...text.matchAll(MENTION)].flatMap((m) => {
    const token = m[0].replace(/[.:]+$/, "");
    const href = citationHref(token, ctx);
    return href ? [{ token, index: m.index, href }] : [];
  });
}

export function CitationLink({ id, href }: { id: string; href: string }) {
  return <a href={href} className="font-mono text-[0.8em] text-celeste-deep underline decoration-celeste/40 underline-offset-2 hover:decoration-celeste-deep">{id}</a>;
}

// Free text with each mentioned citation linked where it is mentioned.
export function Cited({ text, ctx }: { text: string; ctx: Citations }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const { token, index, href } of mentions(text, ctx)) {
    parts.push(text.slice(last, index), <CitationLink key={index} id={token} href={href} />);
    last = index + token.length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}
