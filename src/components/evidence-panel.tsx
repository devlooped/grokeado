import { MODEL_NAME, type Counsel } from "@/domain/court.ts";
import { baseExcerptFor, parseEvidenceDocument } from "@/evidence/okf.ts";
import { isEvidenceCatalog } from "@/evidence/validate.ts";

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const TYPE_LABEL = { evidence: "evidencia", fragment: "fragmento", argument: "argumento", catalog: "catálogo" } as const;

const LEGACY_BASE_TITLES: Record<string, string> = {
  "Submitted text": "Texto enviado",
  "Submitted image": "Imagen enviada",
  "Submitted link": "Enlace enviado",
  "Downloaded file": "Archivo descargado",
  "Downloaded PDF": "PDF descargado",
  "Downloaded HTML": "Página descargada",
  "Downloaded image": "Imagen descargada",
  "Downloaded table": "Tabla descargada",
  "Downloaded text": "Texto descargado",
};

const LEGACY_BASE_DESCRIPTIONS: Record<string, string> = {
  "Original text submitted by the user; preserved without interpretation.":
    "Texto original enviado; conservado sin interpretación.",
  "Original image preserved. The transcription reads visible text and does not replace the image.":
    "Imagen original conservada. La transcripción recoge el texto visible y no reemplaza la imagen.",
  "Original image preserved; no transcription was produced.":
    "Imagen original conservada; no se obtuvo transcripción.",
  "Original URL preserved. The linked content was not stored.":
    "Enlace original conservado. No se guardó el contenido enlazado.",
  "Original downloaded bytes preserved. No text extraction was produced.":
    "Archivo original conservado. No se extrajo texto.",
  "Original PDF bytes preserved. No text extraction was produced.":
    "PDF original conservado. No se extrajo texto.",
  "Neutral text extraction of the downloaded PDF. The original bytes remain unchanged.":
    "Extracción neutral de texto del PDF descargado. El archivo original permanece sin cambios.",
  "Neutral Markdown extraction of the browser-rendered HTML. Scripts were omitted from the extraction; the rendered HTML and screenshot remain in raw/.":
    "Extracción neutral en Markdown del HTML renderizado en navegador. Se omitieron los scripts; el HTML renderizado y la captura se conservan en raw/.",
  "Neutral Markdown extraction of the downloaded HTML. Scripts were omitted from the extraction; the original bytes remain unchanged.":
    "Extracción neutral en Markdown del HTML descargado. Se omitieron los scripts; el archivo original permanece sin cambios.",
  "Original downloaded text preserved without interpretation.":
    "Texto descargado original conservado sin interpretación.",
};

const LEGACY_MOCK_TITLES: Record<string, string> = {
  "Mock source passage": "Pasaje ficticio de fuente",
  "Mock exposicion draft": "Borrador ficticio de exposición",
  "Mock objecion draft": "Borrador ficticio de objeción",
  "Mock conclusion draft": "Borrador ficticio de conclusión",
};

const LEGACY_MOCK_DESCRIPTIONS: Record<string, string> = {
  "Deterministic fixture fragment produced without starting a sandbox.":
    "Fragmento ficticio determinístico generado sin iniciar un entorno aislado.",
  "Deterministic fixture argument; not a model conclusion.":
    "Borrador ficticio determinístico; no es una conclusión real del modelo.",
};

function normalizeCatalogBody(body: string): string {
  return body
    .replace(/^# Timeline\b/, "# Cronología")
    .replace(/^# Entities\b/, "# Entidades")
    .replace("No dates have been extracted from the submission.", "No se extrajeron fechas del material enviado.")
    .replace("No entities have been extracted from the submission.", "No se extrajeron entidades del material enviado.");
}

function normalizeLegacyBaseBody(body: string): string {
  return body
    .replace(/^\[p\.1\] Original image: /, "[p.1] Imagen original: ")
    .replace(/^Original file: /, "Archivo original: ")
    .replace("\n\nThe linked content has not been downloaded.", "\n\nNo se descargó el contenido enlazado.")
    .replace("The original file was preserved and was not interpreted as a document.", "Se conservó el archivo original sin interpretarlo como documento.")
    .replace(/\n\nMalformed PDF(?:: [^\n]+)?/, "\n\nPDF inválido o dañado.")
    .replace(/^(\[p\.1\]\n\n)((?:(?:Site|Author|Published): [^\n]+\n)+)/, (_match, prefix: string, meta: string) =>
      prefix +
      meta
        .replace(/^Site: /gm, "Sitio: ")
        .replace(/^Author: /gm, "Autor: ")
        .replace(/^Published: /gm, "Publicado: ")
    )
    .replace(/\nTables:\n/g, "\nTablas:\n")
    .replace(/\n\nUser note: /g, "\n\nComentario: ");
}

function normalizeLegacyMockBody(body: string): string {
  return body
    .replace(/^\[p\.1\] Fixture source hash: /, "[p.1] Hash de la fuente de prueba: ")
    .replace(/^This draft is only for workflow tests\.$/, "Este borrador es solo para pruebas del flujo.");
}

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
        body: normalizeCatalogBody(source.trim()),
      } satisfies EvidencePanelItem];
    }
    const document = parseEvidenceDocument(source);
    const rawBody = source.replace(FRONTMATTER, "").trim();
    const isLegacyBase = document.generated.by === "base" && document.description in LEGACY_BASE_DESCRIPTIONS;
    const isLegacyMock = path.includes("/mock-") && document.description in LEGACY_MOCK_DESCRIPTIONS;
    const title = document.generated.by === "base"
      ? (LEGACY_BASE_TITLES[document.title] ?? document.title)
      : isLegacyMock
        ? (LEGACY_MOCK_TITLES[document.title] ?? document.title)
        : document.title;
    const description = document.generated.by === "base"
      ? (LEGACY_BASE_DESCRIPTIONS[document.description] ?? document.description)
      : isLegacyMock
        ? (LEGACY_MOCK_DESCRIPTIONS[document.description] ?? document.description)
        : document.description;
    const body = isLegacyBase && document.title !== "Submitted text"
      ? normalizeLegacyBaseBody(rawBody)
      : isLegacyMock
        ? normalizeLegacyMockBody(rawBody)
        : rawBody;
    const reprocessOf = document.type === "fragment" ? document.reprocess_of : undefined;
    return [{
      path,
      title,
      description,
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
        <p className="mt-1 text-sm text-ink-soft">Extracciones neutrales, fragmentos y borradores. Los archivos originales quedan disponibles para contrastar.</p>
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
