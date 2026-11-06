import { COUNSEL, MODEL_NAME, type Counsel, type RecordedEvent } from "../../src/domain/court.ts";
import type { RejectedProposal } from "../../src/instruction/collection.ts";
import { isXPost } from "../../src/instruction/criticism-index.ts";

// One native research call of one seat (gather in instruction, critique in criticism).
export type GatherRecord = {
  seat: Counsel; phase: "instruction" | "criticism"; modelId: string; tools: string[];
  elapsedMs: number; finishReason: string; searches: number; sources: number; costUsd: number | null; error?: string;
};
export type CaseResult = {
  id: string; references: readonly string[]; events: RecordedEvent[]; rejected: RejectedProposal[]; index: string;
  gathers: GatherRecord[];
  // Estimated from tokens and list prices, by seat, for the decision generations.
  decisionCostUsd: Partial<Record<Counsel, number>>;
  error?: string;
};

export const GATHER_BUDGET_MS = 285_000;
export const THRESHOLDS = { gatherP95Ms: 240_000, matchedShare: 0.8 };

const FETCH_REASONS = (reason: string) => reason !== "quote_not_found" && reason !== "passage_too_long";
const comparable = (url: string) => { try { const u = new URL(url); return (u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/+$/, "")).toLowerCase(); } catch { return url; } };

export type SeatMetrics = {
  proposals: number; uniqueUrls: number; fetchFailures: number; quoteChecked: number; matched: number; filed: number; duplicates: number;
  votes: number; sources: number; searches: number; costUsd: number;
};

export function seatMetrics(result: CaseResult, seat: Counsel): SeatMetrics {
  const proposals = result.events.flatMap((e) => e.type === "evidence_proposed" && e.by === seat ? [e.proposal] : []);
  const rejected = result.rejected.filter((proposal) => proposal.by === seat);
  const fetchFailures = rejected.filter((proposal) => FETCH_REASONS(proposal.reason)).length;
  const quoteChecked = proposals.length - fetchFailures;
  const matched = quoteChecked - rejected.filter((proposal) => !FETCH_REASONS(proposal.reason)).length;
  const filed = result.events.filter((e) => e.type === "evidence_filed" && e.evidence.by === seat).length;
  const sources = sourcesOf(result).length;
  const gathers = result.gathers.filter((gather) => gather.seat === seat);
  return {
    proposals: proposals.length, uniqueUrls: new Set(proposals.map((proposal) => comparable(proposal.url))).size, fetchFailures, quoteChecked, matched, filed, duplicates: matched - filed,
    votes: new Set(result.events.flatMap((e) => e.type === "source_review_vote" && e.by === seat ? [e.sourceId] : [])).size, sources,
    searches: gathers.reduce((sum, gather) => sum + gather.searches, 0),
    costUsd: gathers.reduce((sum, gather) => sum + (gather.costUsd ?? 0), 0) + (result.decisionCostUsd[seat] ?? 0),
  };
}

function sourcesOf(result: CaseResult) {
  return result.events.findLast((e) => e.type === "evidence_unified")?.sources ?? [];
}

export function caseMetrics(result: CaseResult) {
  const sources = sourcesOf(result);
  const proposed = new Set(result.events.flatMap((e) => e.type === "evidence_proposed" ? [comparable(e.proposal.url)] : []));
  const x = sources.filter((source) => isXPost(source.url));
  const embedded = x.filter((source) => new RegExp(`^${source.id} · [^\\n]*\\n(?:  [^\\n]*\\n)*?  Full post \\(fetched by the host\\)`, "m").test(result.index + "\n"));
  const votedByOthers = x.filter((source) => COUNSEL.filter((seat) => seat !== "grok").every((seat) => result.events.some((e) => e.type === "source_review_vote" && e.by === seat && e.sourceId === source.id)));
  return {
    uniqueUrls: proposed.size, sources: sources.length,
    referencesFound: result.references.filter((url) => proposed.has(comparable(url))).length,
    xSources: x.length, xEmbedded: embedded.length, xVotedByOthers: votedByOthers.length,
  };
}

export function percentile(values: readonly number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

export function summarize(results: readonly CaseResult[]) {
  const gathers = results.flatMap((result) => result.gathers.filter((gather) => gather.phase === "instruction" && !gather.error));
  const p95 = percentile(gathers.map((gather) => gather.elapsedMs), 0.95);
  const timeouts = results.flatMap((result) => result.gathers).filter((gather) => gather.finishReason === "timeout").length;
  const bySeat = Object.fromEntries(COUNSEL.map((seat) => {
    const metrics = results.map((result) => seatMetrics(result, seat));
    const checked = metrics.reduce((sum, m) => sum + m.quoteChecked, 0), matched = metrics.reduce((sum, m) => sum + m.matched, 0);
    return [seat, { matchedShare: checked ? matched / checked : undefined, fullVotes: metrics.every((m) => m.votes === m.sources) }];
  })) as Record<Counsel, { matchedShare?: number; fullVotes: boolean }>;
  const cases = results.map(caseMetrics);
  const xSources = cases.reduce((sum, c) => sum + c.xSources, 0);
  const xComplete = cases.every((c) => c.xEmbedded === c.xSources && c.xVotedByOthers === c.xSources);
  const toolErrors = results.flatMap((result) => result.gathers.flatMap((gather) => gather.error ? [`${result.id} · ${gather.seat} · ${gather.phase} · ${gather.modelId} [${gather.tools.join(", ")}]: ${gather.error}`] : []));
  const caseErrors = results.flatMap((result) => result.error ? [`${result.id}: ${result.error}`] : []);
  const errors = [...caseErrors, ...toolErrors];
  const checks = {
    latency: p95 !== undefined && p95 < THRESHOLDS.gatherP95Ms && timeouts === 0,
    quotes: COUNSEL.every((seat) => (bySeat[seat].matchedShare ?? 0) >= THRESHOLDS.matchedShare),
    votes: COUNSEL.every((seat) => bySeat[seat].fullVotes),
    x: xComplete,
    tools: toolErrors.length === 0,
    cases: caseErrors.length === 0,
  };
  return { p95, timeouts, bySeat, xSources, checks, errors, toolErrors, caseErrors, passed: Object.values(checks).every(Boolean) };
}

const seconds = (ms: number | undefined) => ms === undefined ? "—" : (ms / 1000).toFixed(0) + " s";
const percent = (value: number | undefined) => value === undefined ? "—" : Math.round(value * 100) + " %";
const usd = (value: number) => "USD " + value.toFixed(3);
const yes = (value: boolean) => value ? "sí" : "**no**";

export function renderResearchReport(results: readonly CaseResult[], run: { started: string; finished: string; spentUsd: number | null; maxUsd: number }): string {
  const summary = summarize(results);
  const lines = [
    "# Investigación nativa (pipeline 3) - " + run.started.slice(0, 10),
    "",
    `Corrida del ${run.started} al ${run.finished}, por AI Gateway real. Gasto medido en créditos: ${run.spentUsd === null ? "—" : usd(run.spentUsd)} (límite ${usd(run.maxUsd)}).`,
    "",
    "## Umbrales para cambiar el pipeline por defecto",
    "",
    "| Métrica | Resultado | Cumple |",
    "| --- | --- | --- |",
    `| Latencia de investigación (p95 < 240 s, sin timeouts; presupuesto ${seconds(GATHER_BUDGET_MS)}) | p95 ${seconds(summary.p95)}, ${summary.timeouts} timeouts | ${yes(summary.checks.latency)} |`,
    `| Citas encontradas en los bloques (≥ 80 % por analista) | ${COUNSEL.map((seat) => MODEL_NAME[seat] + " " + percent(summary.bySeat[seat].matchedShare)).join(", ")} | ${yes(summary.checks.quotes)} |`,
    `| Votos sobre cada fuente E (100 % por analista) | ${COUNSEL.filter((seat) => !summary.bySeat[seat].fullVotes).map((seat) => MODEL_NAME[seat]).join(", ") || "todos completos"} | ${yes(summary.checks.votes)} |`,
    `| Posts de X con texto completo y votados por los demás (100 %) | ${summary.xSources} fuentes de X | ${yes(summary.checks.x)} |`,
    `| Herramientas nativas aceptadas por el Gateway | ${summary.toolErrors.length} errores de herramientas | ${yes(summary.checks.tools)} |`,
    `| Casos completos hasta la revisión de fuentes | ${results.length - summary.caseErrors.length} de ${results.length} | ${yes(summary.checks.cases)} |`,
    "",
    summary.passed ? "**Cumple todos los umbrales.**" : "**No cumple todos los umbrales: el pipeline por defecto no cambia.**",
  ];
  if (summary.errors.length) lines.push("", "## Errores", "", ...summary.errors.map((error) => "- " + error.replaceAll("\n", " ")));
  for (const result of results) {
    const c = caseMetrics(result);
    lines.push("", "## " + result.id, "",
      `URLs propuestas únicas: ${c.uniqueUrls}. Fuentes E: ${c.sources}. Referencias del caso encontradas: ${c.referencesFound} de ${result.references.length}. Posts de X: ${c.xSources} (texto completo ${c.xEmbedded}, votados por los demás ${c.xVotedByOthers}).`,
      "",
      "| Analista | Modelo | Investigación | Búsquedas | Propuestas | URLs | Fallas de descarga | Citas encontradas | Aportes | Duplicados | Votos | Costo estimado |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const seat of COUNSEL) {
      const m = seatMetrics(result, seat);
      const gather = result.gathers.find((g) => g.seat === seat && g.phase === "instruction");
      lines.push(`| ${MODEL_NAME[seat]} | ${gather?.modelId ?? "—"} | ${gather ? seconds(gather.elapsedMs) + " · " + (gather.error ? "error" : gather.finishReason) : "—"} | ${m.searches} | ${m.proposals} | ${m.uniqueUrls} | ${m.fetchFailures} | ${m.matched}/${m.quoteChecked} | ${m.filed} | ${m.duplicates} | ${m.votes}/${m.sources} | ${usd(m.costUsd)} |`);
    }
    if (result.error) lines.push("", "Error del caso: " + result.error.replaceAll("\n", " "));
  }
  return lines.join("\n") + "\n";
}
