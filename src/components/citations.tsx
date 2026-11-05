import type { CaseView, RecordedEvent } from "@/domain/court.ts";

export function evidenceHref(caseId: string, citation: string): string {
  const [path, anchor] = citation.slice("/evidence/".length).split("#", 2);
  const encodedPath = path!.split("/").map(encodeURIComponent).join("/");
  return `/c/${encodeURIComponent(caseId)}/evidence/${encodedPath}${anchor ? `#${encodeURIComponent(anchor)}` : ""}`;
}

// What free text of the case can point to: claims (A), unified sources (E, or S in historical records),
// contributions (P), interventions (I), objections (O), and the OKF evidence pages.
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
  for (const claim of view.claims) refs.set(claim.id, "#" + claim.id);
  for (const [id, source] of view.sources) refs.set(id, source.sourceId && source.excluded === false ? `/evidence/${id}.md` : "#" + id);
  return refs;
}

// Treat external URLs as whole tokens so an ID in a URL is not mistaken for a case reference.
const MENTION = /https?:\/\/[^\s<>"']+|\/evidence\/[^\s)\]},;]+|\bE\d+(?:#p\d+(?::b\d+)?)\b|\b[A-Z]\d{1,3}\b/g;

export function citationHref(token: string, ctx: Citations): string | undefined {
  if (token.startsWith("/evidence/")) return evidenceHref(ctx.caseId, token);
  const section = /^(E\d+)(#p\d+(?::b\d+)?)$/.exec(token);
  const reference = ctx.refs.get(section?.[1] ?? token);
  return reference?.startsWith("/evidence/") ? evidenceHref(ctx.caseId, reference + (section?.[2] ?? "")) : section ? undefined : reference;
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
