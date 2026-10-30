import { getImage } from "../store.ts";
import type { Submission } from "../domain/court.ts";
import { readEvidenceTree, writeEvidenceTree } from "./blob.ts";
import { downloadUrl, sniffExtension, type DownloadResult } from "./download.ts";
import { defaultRecognize, extractEntities, extractPdf, extractTimeline, htmlToText, renderMarkedPages, type Recognize } from "./extract.ts";
import { createEvidenceIndex, serializeEvidenceDocument } from "./okf.ts";
import type { EvidenceDocument } from "./schema.ts";
import { sha256, validateEvidenceTree } from "./validate.ts";

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

function finish(files: Map<string, Uint8Array | string>, observed: string, entry: { path: string; document: EvidenceDocument }): void {
  files.set("evidence/base/timeline.md", extractTimeline(observed));
  files.set("evidence/base/entities.md", extractEntities(observed));
  const index = createEvidenceIndex([entry]).trimEnd();
  files.set("evidence/base/index.md", `${index}\n- [Timeline](/evidence/base/timeline.md)\n- [Entities](/evidence/base/entities.md)\n`);
}

function note(value?: string): string {
  return value ? `\n\nUser note: ${value}` : "";
}

export async function buildBaseBundle(input: {
  submission: Submission;
  now?: string;
  asset?: Uint8Array;
  assetMimeType?: string;
  download?: DownloadResult;
  recognize?: Recognize;
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
      title: "Submitted text",
      description: "Original text submitted by the user; preserved without interpretation.",
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
    if (!input.asset) throw new Error("Image evidence requires the original bytes.");
    const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[input.assetMimeType ?? ""] ?? "bin";
    const rawPath = rawPathFor(files, input.asset, extension);
    const transcript = await recognize(input.asset, input.assetMimeType ?? "application/octet-stream");
    const text = transcript.text.trim();
    const body = (text ? `[p.1]\n\n${text}` : `[p.1] Original image: ${rawPath}`) + note(submission.note) + "\n";
    const document = card({
      title: "Submitted image",
      description: text
        ? "Original image preserved. The transcription reads visible text and does not replace the image."
        : "Original image preserved; no transcription was produced.",
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
    const reason = download && !download.ok ? download.error : "The linked content has not been downloaded.";
    const body = `[p.1] ${submission.url}\n\n${reason}${note(submission.note)}`;
    const document = card({
      title: "Submitted link",
      description: "Original URL preserved. The linked content was not stored.",
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
  let title = "Downloaded file";
  let description = "Original downloaded bytes preserved. No text extraction was produced.";
  let body = `Original file: ${rawPath}${note(submission.note)}`;
  let pages: number[] = [];
  let tool = "unrecognized-file";
  let confidence = 0;
  let tokenCount = 0;
  const sources = [rawPath];

  if (extension === "pdf") {
    const extracted = await extractPdf(download.bytes, recognize);
    title = "Downloaded PDF";
    if (!extracted.ok) {
      description = "Original PDF bytes preserved. No text extraction was produced.";
      body = `The original file was preserved and was not interpreted as a document.\n\n${extracted.error}${note(submission.note)}`;
      tool = "pdf-rejected";
    } else {
      description = "Neutral text extraction of the downloaded PDF. The original bytes remain unchanged.";
      body = renderMarkedPages(extracted.pages);
      for (const page of extracted.pages) {
        if (!page.csv) continue;
        const csvPath = `evidence/base/tables/${sha256(page.csv)}-p${page.page}.csv`;
        files.set(csvPath, page.csv);
        sources.push(csvPath);
      }
      if (sources.length > 1) body += `\nTables:\n${sources.slice(1).map((item) => `- ${item}`).join("\n")}\n`;
      body += note(submission.note);
      pages = extracted.pages.map((page) => page.page);
      tool = extracted.tool;
      confidence = extracted.confidence;
      tokenCount = tokens(extracted.pages.map((page) => page.text).join(" "));
      observed.push(extracted.pages.map((page) => page.text).join("\n"));
    }
  } else if (extension === "html" || extension === "htm") {
    const text = htmlToText(new TextDecoder().decode(download.bytes));
    title = "Downloaded HTML";
    description = "Neutral text extraction of the downloaded HTML. Scripts were omitted from the extraction; the original bytes remain unchanged.";
    body = `[p.1]\n\n${text}${note(submission.note)}`;
    pages = [1];
    tool = "html-text";
    confidence = text ? 0.7 : 0;
    tokenCount = tokens(text);
    observed.push(text);
  } else if (extension === "png" || extension === "jpg" || extension === "jpeg" || extension === "gif" || extension === "webp") {
    const mime = extension === "png" ? "image/png" : extension === "gif" ? "image/gif" : extension === "webp" ? "image/webp" : "image/jpeg";
    const transcript = await recognize(download.bytes, mime);
    const text = transcript.text.trim();
    title = "Downloaded image";
    description = text ? "Original image preserved. The transcription reads visible text and does not replace the image." : "Original image preserved; no transcription was produced.";
    body = text ? `[p.1]\n\n${text}${note(submission.note)}` : `[p.1] Original image: ${rawPath}${note(submission.note)}`;
    pages = [1];
    tool = transcript.tool;
    confidence = text ? Math.min(1, Math.max(0, transcript.confidence)) : 0;
    tokenCount = tokens(text);
    observed.push(text);
  } else if (extension === "txt" || extension === "csv") {
    const text = new TextDecoder().decode(download.bytes);
    title = extension === "csv" ? "Downloaded table" : "Downloaded text";
    description = "Original downloaded text preserved without interpretation.";
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

export async function collectEvidenceBase(caseId: string, submission: Submission): Promise<void> {
  "use step";
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.warn("Evidence collection skipped: BLOB_READ_WRITE_TOKEN is not configured.");
    return;
  }

  const existing = await readEvidenceTree(caseId);
  if (existing.has("evidence/base/index.md")) return;

  let asset: Uint8Array | undefined;
  let assetMimeType: string | undefined;
  let download: DownloadResult | undefined;
  if (submission.kind === "image") {
    const image = await getImage(caseId);
    if (!image) throw new Error(`No original image found for evidence collection in case ${caseId}.`);
    asset = new Uint8Array(image.bytes);
    assetMimeType = image.mimeType;
  } else if (submission.kind === "link") {
    download = await downloadUrl(submission.url);
  }

  const files = await buildBaseBundle({ submission, asset, assetMimeType, download });
  const errors = validateEvidenceTree(files);
  if (errors.length) throw new Error("Collected evidence bundle is invalid: " + errors.join("; "));
  await writeEvidenceTree(caseId, files);
}
