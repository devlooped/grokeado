import { unify, validateRouting, type Contribution, type Evidence, type Routing, type Tier } from "./core.ts";
import type { Dossier, Effort } from "./workflow.ts";

// Entirely fictitious documents: these measure dossier sufficiency without web
// retrieval or memorized real-world answers. References stay outside prompts.
function contribution(path: string, quote: string, retrieval: Contribution["retrieval"] = "full_document"): Contribution {
  return { by: "grok", url: "https://statistics.example.test/" + path, title: "Documento primario ficticio",
    quote, relevance: "Datos del municipio ficticio Puerto Claro", stance: "context", grounded: true, retrieval };
}
function dossier(claim: string, contributions: Contribution[]): Dossier {
  return { claim, asOf: "2026-10-30", contributions, sources: unify(contributions), researchChecks: [] };
}
export interface SufficiencyCase {
  id: string; dossier: Dossier; expectedTier: Tier;
  expectedStatuses: Evidence["status"][]; missingChecks: (keyof Evidence["checks"])[];
}
const population = "Tabla definitiva del censo ficticio 2022: Puerto Claro, población residente total: 3.121.707 habitantes.";
const factClaim = "La población residente de Puerto Claro superó tres millones según su censo definitivo ficticio 2022.";
const comparisonClaim = "En Puerto Claro, las exportaciones PyME crecieron más en dólares corrientes en el año calendario 2024 que el total de bienes, frente a 2023.";
const sme = contribution("sme-2024", "Informe definitivo ficticio: exportaciones PyME, año calendario 2024 frente a 2023: crecimiento del valor en dólares corrientes 17,3%.");
const total = contribution("total-2024", "Informe definitivo ficticio: exportaciones totales de bienes, año calendario 2024 frente a 2023: crecimiento del valor en dólares corrientes 19,4%.");

export const SUFFICIENCY_CASES: SufficiencyCase[] = [
  { id: "complete-fact", dossier: dossier(factClaim, [contribution("census-2022", population)]),
    expectedTier: "fact", expectedStatuses: ["sufficient"], missingChecks: [] },
  { id: "missing-primary", dossier: { ...dossier(factClaim, [contribution("announcement", "Se publicaron resultados definitivos del censo ficticio 2022; la tabla de población se encuentra en un PDF no accesible.", "search_excerpt")]),
    researchChecks: [{ by: "grok", round: 0, passed: true, filed: 1, grounded: 1, observedPages: 1, fetches: 0, gaps: ["Falta la tabla de población."],
      retrievalIssues: [{ url: "https://statistics.example.test/census.pdf", tool: "web_fetch", reason: "No se pudo abrir el PDF." }] }] },
    expectedTier: "fact", expectedStatuses: ["insufficient", "uncertain"], missingChecks: ["coverage", "access"] },
  { id: "period-mismatch", dossier: dossier(comparisonClaim, [sme, contribution("total-2023", "Informe definitivo ficticio: exportaciones totales de bienes, año calendario 2023 frente a 2022: crecimiento del valor en dólares corrientes 19,4%.")]),
    expectedTier: "comparison", expectedStatuses: ["insufficient", "uncertain"], missingChecks: ["fit"] },
  { id: "unit-mismatch", dossier: dossier(comparisonClaim, [contribution("sme-volume", "Informe definitivo ficticio: exportaciones PyME, año calendario 2024 frente a 2023: crecimiento del volumen en toneladas 25,1%. No informa valores en dólares."), total]),
    expectedTier: "comparison", expectedStatuses: ["insufficient", "uncertain"], missingChecks: ["fit"] },
  { id: "unresolved-conflict", dossier: dossier(factClaim, [contribution("census-a", population),
    contribution("census-b", "Tabla definitiva del censo ficticio 2022: Puerto Claro, población residente total: 2.921.707 habitantes. Misma fecha y metodología; no consta cuál tabla es una corrección.")]),
    expectedTier: "fact", expectedStatuses: ["insufficient", "uncertain"], missingChecks: ["contradictions"] },
  { id: "complete-comparison", dossier: dossier(comparisonClaim, [sme, total]),
    expectedTier: "comparison", expectedStatuses: ["sufficient"], missingChecks: [] },
  { id: "empty-dossier", dossier: dossier("La reforma tributaria ficticia de Puerto Claro causó la caída de sus exportaciones en 2024.", []),
    expectedTier: "assessment", expectedStatuses: ["insufficient", "uncertain"], missingChecks: ["coverage", "support"] },
];

export interface SufficiencyReport {
  id: string; claim: string; turns: { effort: Effort; route: Routing }[];
  tierCorrect: boolean; statusCorrect: boolean; gapsDetected: boolean; passed: boolean;
}

export async function evaluateSufficiency(entry: SufficiencyCase, moderate: (dossier: Dossier, effort: Effort) => Promise<Routing>): Promise<SufficiencyReport> {
  const turns: SufficiencyReport["turns"] = [];
  for (const effort of ["medium", "high"] as const) {
    const route = validateRouting(await moderate(entry.dossier, effort), entry.dossier.sources);
    turns.push({ effort, route });
    if (route.action !== "escalate") break;
  }
  const route = turns[turns.length - 1].route;
  const tierCorrect = route.tier === entry.expectedTier;
  const statusCorrect = entry.expectedStatuses.includes(route.evidence.status);
  const gapsDetected = entry.missingChecks.every((key) => route.evidence.checks[key].status !== "satisfied");
  return { id: entry.id, claim: entry.dossier.claim, turns, tierCorrect, statusCorrect, gapsDetected,
    passed: tierCorrect && statusCorrect && gapsDetected && route.action !== "escalate" };
}
