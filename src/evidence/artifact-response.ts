import type { RecordedEvent } from "../domain/court.ts";
import type { ArtifactStore } from "./artifacts.ts";
import { renderEvidenceMarkdown } from "./markdown.ts";
import { loadSettledCorpus } from "./settled.ts";

export async function artifactResponse(caseId: string, namespace: "instruction" | "evidence" | "discussion", parts: string[], events: readonly RecordedEvent[], store: ArtifactStore): Promise<Response> {
  if (!parts.length || parts.some((part) => !part || part === "." || part === ".." || /[\\:\x00-\x1f]/.test(part))) return new Response("No encontrada", { status: 404 });
  const path = `${namespace}/${parts.join("/")}`;
  let title = parts.at(-1)!;
  let language = "es";
  let body: string | undefined;
  let pages: number[] = [];
  if (namespace === "evidence") {
    const corpus = await loadSettledCorpus(caseId, events, store);
    language = corpus.manifest.language;
    const document = corpus.manifest.documents.find((document) => document.path === path);
    if (document) {
      const source = corpus.documents.get(document.id)!;
      title = source.metadata.title; body = source.body; pages = source.metadata.pages;
    } else if (path === "evidence/index.md") { body = corpus.index; }
    else if (path !== "evidence/manifest.json" && path !== "evidence/question.json") return new Response("No encontrada", { status: 404 });
  }
  const files = await store.read(caseId);
  const bytes = files.get(path);
  if (!bytes) return new Response("No encontrada", { status: 404 });
  const markdown = path.endsWith(".md");
  const text = /\.(?:txt|json|jsonl|csv)$/.test(path);
  return new Response(markdown ? renderEvidenceMarkdown({ title, body: body ?? new TextDecoder().decode(bytes), pages, language }) : Buffer.from(bytes), { headers: {
    "content-type": markdown ? "text/html; charset=utf-8" : text ? "text/plain; charset=utf-8" : "application/octet-stream",
    "cache-control": "public, max-age=60", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox",
    ...(!markdown && !text ? { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(title)}` } : {}),
  } });
}
