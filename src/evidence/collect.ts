import { getImage } from "../store.ts";
import { IMAGE_DESCRIPTION_TOOL, type Submission, type SubmissionContext } from "../domain/court.ts";
import { blobConfigured, readEvidenceTree, writeEvidenceTree } from "./blob.ts";
import { downloadUrl, sniffExtension, type DownloadResult } from "./download.ts";
import { defaultRecognize, extractEntities, extractHtml, extractPdf, extractTimeline, renderMarkedPages, type Recognize } from "./extract.ts";
import { baseExcerptFor, createEvidenceIndex, parseEvidenceDocument, serializeEvidenceDocument } from "./okf.ts";
import type { EvidenceDocument } from "./schema.ts";
import { sha256, validateEvidenceTree } from "./validate.ts";

export type { SubmissionContext };

const MAX_CONTEXT_CHARS = 16_000;
const tokens = (value: string) => value.trim().split(/\s+/).filter(Boolean).length;

export function rawPathFor(files: Map<string, Uint8Array | string>, bytes: Uint8Array, extension: string): string {
  const digest = sha256(bytes);
  for (const [path, content] of files) {
    if (path.startsWith("evidence/base/raw/") && sha256(content) === digest) return path;
  }
  const safeExtension = /^[a-z0-9]{1,8}$/.test(extension) ? extension : "bin";
  const path = `evidence/base/raw/${digest}.${safeExtension}`;
  files.set(path, bytes);
  return path;
}

function card(input: {
  title: string;
  description: string;
  sources: string[];
  now: string;
  pages: number[];
  tool: string;
  confidence: number;
  tokenCount: number;
}): EvidenceDocument {
  return {
    type: "evidence",
    title: input.title,
    description: input.description,
    sources: input.sources,
    generated: { by: "base", at: input.now },
    pages: input.pages,
    extraction: { tool: input.tool, confidence: input.confidence },
    tokens: input.tokenCount,
  };
}

const DOWNLOAD_ERROR_LABEL: Record<string, string> = {
  "URL is not valid": "El enlace no es válido.",
  "Only http and https URLs can be downloaded": "Solo se pueden descargar enlaces http o https.",
  "URLs with credentials are rejected": "No se admiten enlaces con credenciales.",
  "URL resolves to a non-public address": "El enlace apunta a una dirección no pública.",
  "Could not resolve host": "No se pudo resolver el dominio del enlace.",
  "Downloaded file is empty": "El archivo descargado está vacío.",
  "Response exceeds the size limit": "La respuesta supera el límite de tamaño.",
  "Download failed": "Falló la descarga del enlace.",
  "Download timed out": "Se agotó el tiempo de espera al descargar el enlace.",
  "Redirect is missing a location": "La redirección no indicó destino.",
  "Too many redirects": "Demasiadas redirecciones.",
  "Browserbase is not configured": "El navegador remoto no está configurado.",
};

function describeDownloadError(error?: string): string {
  if (!error) return "No se descargó el contenido enlazado.";
  return DOWNLOAD_ERROR_LABEL[error] ?? error;
}

function finish(files: Map<string, Uint8Array | string>, observed: string, entry: { path: string; document: EvidenceDocument }): void {
  files.set("evidence/base/timeline.md", extractTimeline(observed));
  files.set("evidence/base/entities.md", extractEntities(observed));
  const index = createEvidenceIndex([entry]).trimEnd();
  files.set("evidence/base/index.md", `${index}\n- [Cronología](/evidence/base/timeline.md)\n- [Entidades](/evidence/base/entities.md)\n`);
}

function note(value?: string): string {
  return value ? `\n\nComentario: ${value}` : "";
}

export async function buildBaseBundle(input: {
  submission: Submission;
  now?: string;
  asset?: Uint8Array;
  assetMimeType?: string;
  download?: DownloadResult;
  recognize?: Recognize;
  // Describes a submitted image with a vision model; falls back to recognize when it fails.
  describe?: Recognize;
}): Promise<Map<string, Uint8Array | string>> {
  const now = input.now ?? new Date().toISOString();
  const recognize = input.recognize ?? defaultRecognize;
  const files = new Map<string, Uint8Array | string>();
  const path = "evidence/base/docs/submission.md";
  const submission = input.submission;

  if (submission.kind === "text") {
    const raw = new TextEncoder().encode(submission.text);
    const rawPath = rawPathFor(files, raw, "txt");
    const body = `[p.1]\n\n${submission.text}\n`;
    const document = card({
      title: "Texto enviado",
      description: "Texto original enviado; conservado sin interpretación.",
      sources: [rawPath],
      now,
      pages: [1],
      tool: "original-text",
      confidence: 1,
      tokenCount: tokens(submission.text),
    });
    files.set(path, serializeEvidenceDocument(document, body));
    finish(files, submission.text, { path, document });
    return files;
  }

  if (submission.kind === "image") {
    if (!input.asset) throw new Error("La evidencia de imagen requiere los bytes originales.");
    const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[input.assetMimeType ?? ""] ?? "bin";
    const rawPath = rawPathFor(files, input.asset, extension);
    const mimeType = input.assetMimeType ?? "application/octet-stream";
    const described = input.describe && await input.describe(input.asset, mimeType).catch((err: unknown) => {
      console.warn("Image description failed; falling back to OCR:", err instanceof Error ? err.message : err);
      return undefined;
    });
    const transcript = described?.text.trim() ? described : await recognize(input.asset, mimeType);
    const text = transcript.text.trim();
    const body = (text ? `[p.1]\n\n${text}` : `[p.1] Imagen original: ${rawPath}`) + note(submission.note) + "\n";
    const document = card({
      title: "Imagen enviada",
      description: !text
        ? "Imagen original conservada; no se obtuvo transcripción."
        : transcript.tool.startsWith(IMAGE_DESCRIPTION_TOOL)
          ? "Imagen original conservada. Un modelo de visión la describió y transcribió su texto visible; la descripción no reemplaza la imagen."
          : "Imagen original conservada. La transcripción recoge el texto visible y no reemplaza la imagen.",
      sources: [rawPath],
      now,
      pages: [1],
      tool: transcript.tool,
      confidence: text ? Math.min(1, Math.max(0, transcript.confidence)) : 0,
      tokenCount: tokens(text),
    });
    files.set(path, serializeEvidenceDocument(document, body));
    finish(files, `${text}${note(submission.note)}`, { path, document });
    return files;
  }

  const download = input.download;
  if (!download?.ok) {
    const raw = new TextEncoder().encode(submission.url);
    const rawPath = rawPathFor(files, raw, "url");
    const reason = describeDownloadError(download && !download.ok ? download.error : undefined);
    const body = `[p.1] ${submission.url}\n\n${reason}${note(submission.note)}`;
    const document = card({
      title: "Enlace enviado",
      description: "Enlace original conservado. No se guardó el contenido enlazado.",
      sources: [rawPath],
      now,
      pages: [1],
      tool: download ? "download-failed" : "link-pointer",
      confidence: 0,
      tokenCount: 0,
    });
    files.set(path, serializeEvidenceDocument(document, body));
    finish(files, `${submission.url}${note(submission.note)}`, { path, document });
    return files;
  }

  const url = new URL(download.finalUrl);
  const extension = sniffExtension(download.bytes, download.contentType, url.pathname);
  const rawPath = rawPathFor(files, download.bytes, extension);
  const observed: string[] = [];
  let title = "Archivo descargado";
  let description = "Archivo original conservado. No se extrajo texto.";
  let body = `Archivo original: ${rawPath}${note(submission.note)}`;
  let pages: number[] = [];
  let tool = "unrecognized-file";
  let confidence = 0;
  let tokenCount = 0;
  const sources = [rawPath];

  if (extension === "pdf") {
    const extracted = await extractPdf(download.bytes, recognize);
    title = "PDF descargado";
    if (!extracted.ok) {
      description = "PDF original conservado. No se extrajo texto.";
      body = `Se conservó el archivo original sin interpretarlo como documento.\n\n${extracted.error}${note(submission.note)}`;
      tool = "pdf-rejected";
    } else {
      description = "Extracción neutral de texto del PDF descargado. El archivo original permanece sin cambios.";
      body = renderMarkedPages(extracted.pages);
      for (const page of extracted.pages) {
        if (!page.csv) continue;
        const csvPath = `evidence/base/tables/${sha256(page.csv)}-p${page.page}.csv`;
        files.set(csvPath, page.csv);
        sources.push(csvPath);
      }
      if (sources.length > 1) body += `\nTablas:\n${sources.slice(1).map((item) => `- ${item}`).join("\n")}\n`;
      body += note(submission.note);
      pages = extracted.pages.map((page) => page.page);
      tool = extracted.tool;
      confidence = extracted.confidence;
      tokenCount = tokens(extracted.pages.map((page) => page.text).join(" "));
      observed.push(extracted.pages.map((page) => page.text).join("\n"));
    }
  } else if (extension === "html" || extension === "htm") {
    const extracted = await extractHtml(new TextDecoder().decode(download.bytes), download.finalUrl);
    if (download.screenshot?.byteLength) {
      sources.push(rawPathFor(files, download.screenshot, "png"));
    }
    const tables: string[] = [];
    if (extracted.csv) {
      const csvPath = `evidence/base/tables/${sha256(extracted.csv)}-p1.csv`;
      files.set(csvPath, extracted.csv);
      sources.push(csvPath);
      tables.push(csvPath);
    }
    const meta = [
      extracted.site ? `Sitio: ${extracted.site}` : "",
      extracted.author ? `Autor: ${extracted.author}` : "",
      extracted.published ? `Publicado: ${extracted.published}` : "",
    ].filter(Boolean);
    const header = meta.length ? `${meta.join("\n")}\n\n` : "";
    const tableFooter = tables.length ? `\n\nTablas:\n${tables.map((item) => `- ${item}`).join("\n")}` : "";
    title = extracted.title ? extracted.title.slice(0, 300) : "Página descargada";
    description = download.via === "browserbase"
      ? "Extracción neutral en Markdown del HTML renderizado en navegador. Se omitieron los scripts; el HTML renderizado y la captura se conservan en raw/."
      : "Extracción neutral en Markdown del HTML descargado. Se omitieron los scripts; el archivo original permanece sin cambios.";
    body = `[p.1]\n\n${header}${extracted.markdown}${tableFooter}${note(submission.note)}`;
    pages = [1];
    tool = download.via && download.via !== "fetch" ? `${extracted.tool}+${download.via}` : extracted.tool;
    confidence = extracted.markdown
      ? Math.min(1, extracted.confidence + (download.via === "browserbase" ? 0.05 : 0))
      : 0;
    tokenCount = tokens(extracted.markdown);
    observed.push([meta.join("\n"), extracted.markdown].filter(Boolean).join("\n"));
  } else if (extension === "png" || extension === "jpg" || extension === "jpeg" || extension === "gif" || extension === "webp") {
    const mime = extension === "png" ? "image/png" : extension === "gif" ? "image/gif" : extension === "webp" ? "image/webp" : "image/jpeg";
    const transcript = await recognize(download.bytes, mime);
    const text = transcript.text.trim();
    title = "Imagen descargada";
    description = text
      ? "Imagen original conservada. La transcripción recoge el texto visible y no reemplaza la imagen."
      : "Imagen original conservada; no se obtuvo transcripción.";
    body = text ? `[p.1]\n\n${text}${note(submission.note)}` : `[p.1] Imagen original: ${rawPath}${note(submission.note)}`;
    pages = [1];
    tool = transcript.tool;
    confidence = text ? Math.min(1, Math.max(0, transcript.confidence)) : 0;
    tokenCount = tokens(text);
    observed.push(text);
  } else if (extension === "txt" || extension === "csv") {
    const text = new TextDecoder().decode(download.bytes);
    title = extension === "csv" ? "Tabla descargada" : "Texto descargado";
    description = "Texto descargado original conservado sin interpretación.";
    body = `[p.1]\n\n${text}${note(submission.note)}`;
    pages = [1];
    tool = extension === "csv" ? "csv-text" : "original-text";
    confidence = 1;
    tokenCount = tokens(text);
    observed.push(text);
  }

  if (submission.note) observed.push(submission.note);
  const document = card({ title, description, sources, now, pages, tool, confidence, tokenCount });
  files.set(path, serializeEvidenceDocument(document, body.endsWith("\n") ? body : body + "\n"));
  finish(files, observed.join("\n"), { path, document });
  return files;
}

export function submissionContextFromBundle(
  files: ReadonlyMap<string, Uint8Array | string>,
  submission: Submission,
  finalUrl?: string
): SubmissionContext | undefined {
  if (submission.kind === "text") return undefined;
  const rawDoc = files.get("evidence/base/docs/submission.md");
  if (!rawDoc) return undefined;
  const source = typeof rawDoc === "string" ? rawDoc : new TextDecoder().decode(rawDoc);
  const document = parseEvidenceDocument(source);
  if (document.type !== "evidence" || document.tokens === 0) return undefined;
  const body = baseExcerptFor(files, "evidence/base/docs/submission.md").trim();
  if (!body) return undefined;
  const excerpt = body.length > MAX_CONTEXT_CHARS
    ? `${body.slice(0, MAX_CONTEXT_CHARS)}\n[… contenido truncado a ${MAX_CONTEXT_CHARS} caracteres …]`
    : body;
  return {
    title: document.title,
    ...(finalUrl ? { finalUrl } : {}),
    tool: document.extraction.tool,
    excerpt,
  };
}

export async function collectEvidenceBase(
  caseId: string,
  submission: Submission,
  simulated = false,
  describe?: Recognize
): Promise<SubmissionContext | undefined> {
  const hasBlob = blobConfigured();

  if (hasBlob) {
    const existing = await readEvidenceTree(caseId);
    if (existing.has("evidence/base/index.md")) {
      return submissionContextFromBundle(existing, submission, submission.kind === "link" ? submission.url : undefined);
    }
  } else if (simulated || submission.kind === "text") {
    console.warn("Evidence collection skipped: blob credentials are not configured.");
    return undefined;
  }

  let asset: Uint8Array | undefined;
  let assetMimeType: string | undefined;
  let download: DownloadResult | undefined;
  if (submission.kind === "image") {
    const image = await getImage(caseId);
    if (!image) throw new Error(`No se encontró la imagen original del caso ${caseId}.`);
    asset = new Uint8Array(image.bytes);
    assetMimeType = image.mimeType;
  } else if (submission.kind === "link" && !simulated) {
    download = await downloadUrl(submission.url);
  }

  const files = await buildBaseBundle({ submission, asset, assetMimeType, download, describe });
  const errors = validateEvidenceTree(files);
  if (errors.length) throw new Error("El expediente de evidencia recolectado no es válido: " + errors.join("; "));
  if (hasBlob) {
    await writeEvidenceTree(caseId, files);
  } else {
    console.warn("Evidence bundle extracted in memory; blob credentials are not configured so raw artifacts were not persisted.");
  }
  return submissionContextFromBundle(files, submission, download?.ok ? download.finalUrl : undefined);
}
