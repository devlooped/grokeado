import { randomUUID } from "node:crypto";
import type { CourtEvent } from "../domain/court.ts";
import { writeEvidenceTree } from "./blob.ts";
import { downloadUrl, sniffExtension, type DownloadResult } from "./download.ts";
import { defaultRecognize, extractHtml, extractPdf, renderMarkedPages } from "./extract.ts";
import { translateSourceText } from "./translate.ts";
import { sha256 } from "./validate.ts";

type Dependencies = {
  download: typeof downloadUrl;
  translate: typeof translateSourceText;
  write: typeof writeEvidenceTree;
};

async function extract(download: Extract<DownloadResult, { ok: true }>, extension: string): Promise<string | undefined> {
  if (extension === "html" || extension === "htm") return (await extractHtml(new TextDecoder().decode(download.bytes), download.finalUrl)).markdown;
  if (extension === "pdf") {
    const pdf = await extractPdf(download.bytes);
    if (!pdf.ok) throw new Error(pdf.error);
    return pdf.pages.some((page) => page.text.trim()) ? renderMarkedPages(pdf.pages) : undefined;
  }
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(extension)) {
    const mime = extension === "png" ? "image/png" : extension === "gif" ? "image/gif" : extension === "webp" ? "image/webp" : "image/jpeg";
    return (await defaultRecognize(download.bytes, mime)).text;
  }
  if (["txt", "csv", "md"].includes(extension)) return new TextDecoder().decode(download.bytes);
}

// Capture the URLs filed by each analyst. Original bytes and extracted text are
// retained; the translation is a separate, explicitly labelled derivative.
export async function saveContributedSources(caseId: string, events: readonly CourtEvent[], language: string, deps: Dependencies = { download: downloadUrl, translate: translateSourceText, write: writeEvidenceTree }): Promise<void> {
  const seen = new Set<string>();
  const runId = randomUUID();
  for (const event of events) {
    if (event.type !== "evidence_filed") continue;
    const { by, url } = event.evidence;
    const key = `${by}:${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const root = `evidence/${by}/downloads/${runId}/${sha256(url)}`;
    const downloaded = await deps.download(url);
    const files = new Map<string, Uint8Array | string>();
    if (!downloaded.ok) {
      files.set(`${root}/source.json`, JSON.stringify({ url, status: "download_failed", error: downloaded.error }));
    } else {
      const extension = sniffExtension(downloaded.bytes, downloaded.contentType, new URL(downloaded.finalUrl).pathname);
      // Raw source files must not be mistaken for promoted OKF Markdown.
      const rawPath = `${root}/original.bin`;
      files.set(rawPath, downloaded.bytes);
      let originalText: string | undefined;
      let extractionError: string | undefined;
      try {
        originalText = await extract(downloaded, extension);
      } catch (error) {
        extractionError = error instanceof Error ? error.message : String(error);
      }
      const result = originalText?.trim() ? await deps.translate(originalText, language) : undefined;
      const textPath = `${root}/extracted.txt`;
      const translatedPath = `${root}/translated.txt`;
      if (originalText) files.set(textPath, originalText);
      if (result?.changed) files.set(translatedPath, result.text);
      files.set(`${root}/source.json`, JSON.stringify({
        url, finalUrl: downloaded.finalUrl, original: rawPath, originalExtension: extension, language,
        status: result ? (result.changed ? "translated" : "already_in_language") : "extraction_unavailable",
        ...(extractionError ? { error: extractionError } : {}),
        ...(originalText ? { extracted: textPath } : {}),
        ...(result?.changed ? { translation: translatedPath } : {}),
      }));
    }
    await deps.write(caseId, files);
  }
}
