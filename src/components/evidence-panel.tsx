import { MODEL_NAME, type Counsel } from "@/domain/court.ts";
import { baseExcerptFor, parseEvidenceDocument } from "@/evidence/okf.ts";
import { isEvidenceCatalog } from "@/evidence/validate.ts";

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const TYPE_LABEL = { evidence: "evidence", fragment: "fragment", argument: "argument", catalog: "catálogo" } as const;

export interface EvidencePanelItem {
  path: string;
  title: string;
  description: string;
  by: Counsel | "base";
  type: keyof typeof TYPE_LABEL;
  sources: string[];
  page?: number;
  reprocessOf?: string;
  baseExcerpt?: string;
  body: string;
}

export function toEvidencePanelItems(files: ReadonlyMap<string, Uint8Array | string>): EvidencePanelItem[] {
  return [...files].flatMap(([path, content]): EvidencePanelItem[] => {
    if (!path.startsWith("evidence/") || !path.endsWith(".md") || path.endsWith("/index.md")) return [];
    const source = typeof content === "string" ? content : new TextDecoder().decode(content);
    if (isEvidenceCatalog(path)) {
      const title = path.endsWith("/timeline.md") ? "Cronología extraída" : path.endsWith("/entities.md") ? "Entidades extraídas" : "Catálogo";
      return [{
        path,
        title,
        description: "Derivado neutral del texto extraído. No valora la prueba.",
        by: "base",
        type: "catalog",
        sources: [],
        body: source.trim(),
      } satisfies EvidencePanelItem];
    }
    const document = parseEvidenceDocument(source);
    const body = source.replace(FRONTMATTER, "").trim();
    const reprocessOf = document.type === "fragment" ? document.reprocess_of : undefined;
    return [{
      path,
      title: document.title,
      description: document.description,
      by: document.generated.by,
      type: document.type,
      sources: document.sources,
      ...(document.type === "fragment" ? { page: document.page, reprocessOf, baseExcerpt: reprocessOf ? baseExcerptFor(files, reprocessOf) : undefined } : {}),
      body,
    } satisfies EvidencePanelItem];
  });
}

function documentHref(caseId: string, evidencePath: string): string {
  const [path, anchor] = evidencePath.replace(/^\/+/, "").split("#", 2);
  const relativePath = path!.replace(/^evidence\//, "").split("/").map(encodeURIComponent).join("/");
  return `/caso/${encodeURIComponent(caseId)}/evidencia/${relativePath}${anchor ? `#${encodeURIComponent(anchor)}` : ""}`;
}

function sourceHref(caseId: string, source: string): string {
  return /^https?:\/\//i.test(source) ? source : documentHref(caseId, source);
}

export function EvidencePanel({ caseId, items }: { caseId: string; items: EvidencePanelItem[] }) {
  if (!items.length) return null;
  return (
    <section className="mt-10">
      <div className="rule-double pt-4">
        <h2 className="font-display text-4xl">Expediente de evidencia</h2>
        <p className="mt-1 text-sm text-ink-soft">Extracciones neutrales, fragments y borradores. El raw permanece disponible para contrastar.</p>
      </div>
      <div className="mt-5 space-y-3">
        {items.map((item) => (
          <details key={item.path} id={item.path} className="rounded-sm border border-rule bg-paper/60 px-4 py-3">
            <summary className="cursor-pointer">
              <span className="font-display text-lg">{item.title}</span>
              <span className="ml-2 text-xs text-ink-soft">
                {item.by === "base" ? "Colector" : MODEL_NAME[item.by]} · {TYPE_LABEL[item.type]}{item.page ? ` · p. ${item.page}` : ""}
              </span>
            </summary>
            <p className="mt-2 text-sm text-ink-soft">{item.description}</p>
            {item.reprocessOf && (
              <p className="mt-2 text-sm">
                Reproceso de{" "}
                <a className="text-celeste-deep underline" href={sourceHref(caseId, item.reprocessOf)}>{item.reprocessOf}</a>
              </p>
            )}
            {item.sources.length > 0 && (
              <p className="mt-2 text-xs text-ink-soft">
                Fuentes:{" "}
                {item.sources.map((source, index) => (
                  <span key={source}>
                    {index > 0 && ", "}
                    <a className="text-celeste-deep underline" href={sourceHref(caseId, source)} target={/^https?:\/\//i.test(source) ? "_blank" : undefined} rel={/^https?:\/\//i.test(source) ? "noreferrer noopener" : undefined}>{source}</a>
                  </span>
                ))}
              </p>
            )}
            {item.reprocessOf ? (
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div>
                  <p className="text-xs font-medium uppercase tracking-widest text-ink-soft">Extracción base</p>
                  <pre className="mt-1 whitespace-pre-wrap break-words border-l-2 border-rule pl-3 font-sans text-sm leading-relaxed">{item.baseExcerpt || "La página citada no tiene texto en la extracción base."}</pre>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-widest text-ink-soft">Reproceso</p>
                  <pre className="mt-1 whitespace-pre-wrap break-words border-l-2 border-rule pl-3 font-sans text-sm leading-relaxed">{item.body}</pre>
                </div>
              </div>
            ) : (
              <pre className="mt-3 whitespace-pre-wrap break-words border-l-2 border-rule pl-3 font-sans text-sm leading-relaxed">{item.body}</pre>
            )}
            <a className="mt-3 inline-block text-xs text-celeste-deep underline" href={documentHref(caseId, item.path)}>Abrir archivo</a>
          </details>
        ))}
      </div>
    </section>
  );
}
