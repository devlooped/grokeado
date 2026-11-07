// Offline study of quote matching: rereads the proposals of saved research
// evals, downloads and extracts their pages again (free), and compares the
// exact matcher with a title match, a lexical window match and embedding
// matches. Embeddings go through the AI Gateway and cost a few cents: the run
// stops before it would spend more than --max-usd.
//
//   node --import tsx scripts/eval-quote-match.ts <case.json>... [--models a,b] [--max-usd 0.5] [--out dir]
import nextEnv from "@next/env";
import { embedMany, gateway } from "ai";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { RecordedEvent } from "../src/domain/court.ts";
import { MemoryArtifactStore } from "../src/evidence/artifacts.ts";
import { downloadUrl } from "../src/evidence/download.ts";
import { proposalsOf } from "../src/instruction/collection.ts";
import { matchQuote, normalizeQuoteText } from "../src/instruction/quote-match.ts";
import { MemoryOperationRepository } from "../src/instruction/source-store.ts";
import { extractSource, mapLimit, normalizeSourceUrl, SourceService, type SourceBlock } from "../src/instruction/sources.ts";

nextEnv.loadEnvConfig(process.cwd(), true);
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  models: { type: "string", default: "openai/text-embedding-3-small,voyage/voyage-4-lite,alibaba/qwen3-embedding-0.6b,google/gemini-embedding-001" },
  "max-usd": { type: "string", default: "0.5" },
  out: { type: "string", default: "test-results/quote-match/" + new Date().toISOString().slice(0, 10) },
} });
const models = values.models!.split(",").map((id) => id.trim()).filter(Boolean);
const maxUsd = Number(values["max-usd"]);

type Page = { url: string; finalUrl: string; title: string; blocks: SourceBlock[]; windows: string[] };
type Row = { caseId: string; by: string; url: string; finalUrl?: string; quote: string; error?: string; exact: boolean; title: boolean;
  lexical?: { coverage: number; window: string }; embedding: Record<string, { cos: number; coverage: number; window: string; otherCos: number }> };

// Markdown links, images and emphasis are not part of the quoted text.
function clean(text: string): string {
  return text.replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[#>*_|`]+/g, " ").replace(/\s+/g, " ").trim();
}

// Runs of one to three sentences, across paragraphs, and the title: the
// passages a quote can be matched to.
function windowsOf(title: string, blocks: readonly SourceBlock[]): string[] {
  const sentences = blocks.flatMap((block) => clean(block.text).split(/(?<=[.!?…»”"])\s+(?=[\p{Lu}¿¡«“"(\d])/u)).filter((sentence) => sentence.length >= 3);
  const windows = new Set<string>(title.trim() ? [clean(title)] : []);
  for (let start = 0; start < sentences.length; start++) {
    for (let size = 1; size <= 3 && start + size <= sentences.length; size++) {
      const window = sentences.slice(start, start + size).join(" ");
      if (size > 1 && window.length > 1500) break;
      windows.add(window.slice(0, 2000));
    }
  }
  return [...windows];
}

function tokens(text: string): string[] {
  return normalizeQuoteText(text).split(" ").filter(Boolean);
}

// The share of the quote's words that the passage contains.
function coverage(quote: string, window: string): number {
  const words = tokens(quote), present = new Set(tokens(window));
  return words.length ? words.filter((word) => present.has(word)).length / words.length : 0;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return dot / Math.sqrt(na * nb);
}

const quoteText = (quote: string) => quote.replace(/\[\s*(?:…|\.{3})\s*\]|…|\.{3,}/gu, " ").replace(/\s+/g, " ").trim();

// Price per input token, from the Gateway's public model list.
const catalogue = (await (await fetch("https://ai-gateway.vercel.sh/v1/models")).json()) as { data: Array<{ id: string; pricing?: { input?: string } }> };
const price = new Map(catalogue.data.map((model) => [model.id, Number(model.pricing?.input ?? NaN)]));
for (const model of models) if (!Number.isFinite(price.get(model))) throw new Error(`No price for ${model}`);

const rows: Row[] = [];
const cost: Record<string, { tokens: number; usd: number; ms: number; texts: number; cases: Record<string, { tokens: number; usd: number; ms: number }> }> = {};
for (const model of models) cost[model] = { tokens: 0, usd: 0, ms: 0, texts: 0, cases: {} };
let spent = 0;

for (const file of positionals) {
  const record = JSON.parse(await readFile(file, "utf8")) as { id: string; events: RecordedEvent[] };
  const caseId = record.id, proposals = proposalsOf(record.events).filter((proposal) => proposal.quote);
  const reader = new SourceService(caseId, "es", { operations: new MemoryOperationRepository(), artifacts: new MemoryArtifactStore(), download: downloadUrl, extract: extractSource,
    translate: async () => { throw new Error("no translation in this study"); }, verifyLanguage: async () => { throw new Error("no translation in this study"); }, translatorModelId: "none", translatorFingerprint: "none" });
  const urls = [...new Set(proposals.flatMap((proposal) => { try { return [normalizeSourceUrl(proposal.url)]; } catch { return []; } }))];
  const pages = new Map<string, Page | { error: string }>();
  await mapLimit(urls, 6, async (url) => {
    if (/^https:\/\/(www\.)?(x|twitter)\.com\//.test(url)) { pages.set(url, { error: "x_post_skipped" }); return; }
    try {
      const { acquisition, document, blocks } = await reader.inspect(url);
      pages.set(url, { url, finalUrl: acquisition.finalUrl, title: document.title, blocks, windows: windowsOf(document.title, blocks) });
    } catch (error) { pages.set(url, { error: error instanceof Error ? error.message.slice(0, 80) : String(error) }); }
  });
  const ready = [...pages.values()].filter((page): page is Page => "windows" in page);
  // A redirect and its target are one page.
  const byFinal = new Map(ready.map((page) => [page.finalUrl, page]));

  const caseRows: Row[] = proposals.map((proposal) => {
    let url = proposal.url;
    try { url = normalizeSourceUrl(proposal.url); } catch { /* kept as proposed */ }
    const page = pages.get(url);
    if (!page || "error" in page) return { caseId, by: proposal.by, url: proposal.url, quote: proposal.quote, error: page?.error ?? "invalid_url", exact: false, title: false, embedding: {} };
    const exact = Boolean(matchQuote(page.blocks, proposal.quote));
    const title = !exact && Boolean(matchQuote([{ id: "title", page: 0, text: page.title }], proposal.quote));
    const best = page.windows.reduce((top, window) => { const value = coverage(quoteText(proposal.quote), window); return value > top.coverage ? { coverage: value, window } : top; }, { coverage: 0, window: "" });
    return { caseId, by: proposal.by, url: proposal.url, finalUrl: page.finalUrl, quote: proposal.quote, exact, title, lexical: best, embedding: {} };
  });
  rows.push(...caseRows);
  const matchable = caseRows.filter((row) => row.finalUrl);
  const texts = [...new Set([...matchable.map((row) => quoteText(row.quote)), ...[...byFinal.values()].flatMap((page) => page.windows)])];

  for (const model of models) {
    const estimate = texts.reduce((sum, text) => sum + text.length, 0) / 3 * price.get(model)!;
    if (spent + estimate > maxUsd) { console.warn(`skip ${model} on ${caseId}: estimate ${estimate.toFixed(4)} USD over the cap`); continue; }
    const started = Date.now();
    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += 96) batches.push(texts.slice(i, i + 96));
    const results = await mapLimit(batches, 4, (batch) => embedMany({ model: gateway.embeddingModel(model), values: batch, maxRetries: 3 }));
    const ms = Date.now() - started;
    const vectors = new Map<string, Float32Array>();
    let used = 0;
    results.forEach((result, index) => { used += result.usage.tokens; batches[index]!.forEach((text, i) => vectors.set(text, Float32Array.from(result.embeddings[i]!))); });
    const usd = used * price.get(model)!;
    spent += usd;
    Object.assign(cost[model]!, { tokens: cost[model]!.tokens + used, usd: cost[model]!.usd + usd, ms: cost[model]!.ms + ms, texts: cost[model]!.texts + texts.length });
    cost[model]!.cases[caseId] = { tokens: used, usd, ms };
    for (const row of matchable) {
      const page = byFinal.get(row.finalUrl!)!, query = vectors.get(quoteText(row.quote))!;
      let cos = -1, window = "";
      for (const candidate of page.windows) { const value = cosine(query, vectors.get(candidate)!); if (value > cos) { cos = value; window = candidate; } }
      // The best passage on the other pages of the case, where the quote is not: how high an unrelated passage scores.
      let otherCos = -1;
      for (const other of byFinal.values()) {
        if (other === page || matchQuote(other.blocks, row.quote)) continue;
        for (const candidate of other.windows) otherCos = Math.max(otherCos, cosine(query, vectors.get(candidate)!));
      }
      row.embedding[model] = { cos, coverage: coverage(quoteText(row.quote), window), window, otherCos };
    }
    console.log(`${caseId} ${model}: ${texts.length} texts, ${used} tokens, ${usd.toFixed(5)} USD, ${ms} ms`);
  }
}

// Report.
const pct = (n: number, d: number) => d ? `${n}/${d} (${Math.round(100 * n / d)} %)` : "0/0";
const fetchedRows = rows.filter((row) => row.finalUrl);
const lines = [`# Quote matching study`, "", `Cases: ${positionals.join(", ")}`, "", `Proposals: ${rows.length}; on a page that was read: ${fetchedRows.length}; spent: ${spent.toFixed(4)} USD.`, ""];
lines.push("## Found, by rule (proposals on a page that was read)", "", "| Rule | Found |", "| --- | --- |");
const exact = fetchedRows.filter((row) => row.exact).length, withTitle = fetchedRows.filter((row) => row.exact || row.title).length;
lines.push(`| exact | ${pct(exact, fetchedRows.length)} |`, `| exact or title | ${pct(withTitle, fetchedRows.length)} |`);
for (const threshold of [0.8, 0.9]) lines.push(`| exact, title or lexical coverage ≥ ${threshold} | ${pct(fetchedRows.filter((row) => row.exact || row.title || (row.lexical?.coverage ?? 0) >= threshold).length, fetchedRows.length)} |`);
const positives = fetchedRows.filter((row) => row.exact);
for (const model of models) {
  const scored = fetchedRows.filter((row) => row.embedding[model]);
  if (!scored.length) continue;
  const sorted = positives.flatMap((row) => row.embedding[model] ? [row.embedding[model].cos] : []).sort((a, b) => a - b);
  const p5 = sorted[Math.floor(sorted.length * 0.05)] ?? 1;
  for (const threshold of [p5, 0.8, 0.85, 0.9]) {
    const accept = (row: Row) => row.exact || row.title || (row.embedding[model]!.cos >= threshold && row.embedding[model]!.coverage >= 0.6);
    const falsePositive = positives.filter((row) => row.embedding[model] && row.embedding[model].otherCos >= threshold).length;
    lines.push(`| ${model} cos ≥ ${threshold.toFixed(3)}${threshold === p5 ? " (p5 of exact)" : ""} and coverage ≥ 0.6 | ${pct(scored.filter(accept).length, scored.length)}; another page also passes the cosine for ${pct(falsePositive, positives.length)} of exact quotes |`);
  }
}
lines.push("", "## Cost and latency", "", "| Model | USD per 1M tokens | Tokens | USD | Embedding time | Per case |", "| --- | --- | --- | --- | --- | --- |");
for (const model of models) {
  const entry = cost[model]!;
  lines.push(`| ${model} | ${(price.get(model)! * 1e6).toFixed(3)} | ${entry.tokens} | ${entry.usd.toFixed(5)} | ${(entry.ms / 1000).toFixed(1)} s | ${Object.entries(entry.cases).map(([id, c]) => `${id}: ${c.tokens} tok, ${c.usd.toFixed(5)} USD, ${(c.ms / 1000).toFixed(1)} s`).join("; ")} |`);
}
lines.push("", "## Misses of the exact matcher", "");
for (const row of rows.filter((row) => !row.exact)) {
  lines.push(`### ${row.caseId} · ${row.by} · ${row.error ?? (row.title ? "title match" : "not found")}`, "", `- URL: ${row.url}${row.finalUrl && row.finalUrl !== row.url ? ` → ${row.finalUrl}` : ""}`, `- Quote: «${row.quote}»`);
  if (row.lexical) lines.push(`- Lexical best (${row.lexical.coverage.toFixed(2)}): «${row.lexical.window.slice(0, 400)}»`);
  for (const [model, match] of Object.entries(row.embedding)) lines.push(`- ${model}: cos ${match.cos.toFixed(3)}, coverage ${match.coverage.toFixed(2)}, other pages ${match.otherCos.toFixed(3)}: «${match.window.slice(0, 400)}»`);
  lines.push("");
}
await mkdir(values.out!, { recursive: true });
await writeFile(`${values.out}/report.md`, lines.join("\n"));
await writeFile(`${values.out}/rows.json`, JSON.stringify({ cost, rows }, null, 2));
console.log(`report: ${values.out}/report.md; spent ${spent.toFixed(4)} USD`);
