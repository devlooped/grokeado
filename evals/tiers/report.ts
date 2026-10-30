import type { z } from "zod";
import { CHECKS, type assessmentSchema, type Tier } from "./core.ts";
import { actionLabels, checkLabels, checkStatusLabels, effortLabels, evidenceLabels, stopLabels, tierLabels, verdictLabels } from "./presentation.ts";
import type { Adjudication, ResearchCheck, ResearchOutcome, RoutingTurn, resolveAssessment } from "./workflow.ts";
import type { SufficiencyReport } from "./sufficiency-cases.ts";

export interface AssessmentReport extends ReturnType<typeof resolveAssessment> {
  candidate: string; by: string; tier: Tier; result: z.infer<typeof assessmentSchema>;
  verdictCorrect: boolean | null;
  // Present when the moderator's gap ruling led this evaluator to re-assess.
  initialVerdict?: z.infer<typeof assessmentSchema>["verdict"]; initialEvidenceStatus?: z.infer<typeof assessmentSchema>["evidence"]["status"];
}
export interface CaseReport {
  claim: string; expectedTier: Tier; expectedVerdict: z.infer<typeof assessmentSchema>["verdict"] | null;
  sources: number; researchChecks: ResearchCheck[];
  routing: (RoutingTurn & { tierCorrect: boolean })[];
  stopReason: ResearchOutcome["stopReason"]; researchRounds: number;
  finalRoute: ResearchOutcome["route"];
  assessments: AssessmentReport[];
  grades: { candidate: string; groundedFacts: boolean; comparableOrApplicableCriteria: boolean;
    correctReasoning: boolean; calibratedConclusion: boolean; explanation: string }[];
  evaluationBudgetExhausted: boolean;
  adjudication?: Adjudication;
}

export function renderReport(cases: Record<string, CaseReport>, metadata: { asOf: string; started: string; deltaUsd: number; failures: string[] }) {
  const lines = ["# Piloto de suficiencia de evidencia", "", `Corte: ${metadata.asOf}. Inicio: ${metadata.started}.`, "",
    `${Object.keys(cases).length} casos, una repetición por configuración. No es un benchmark estadístico ni un fallo jurídico.`, "",
    "| Afirmación | Complejidad esperada | Suficiencia final | Cierre | Rondas adicionales | Fuentes |", "|---|---|---|---|---|---|"];
  const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");
  for (const c of Object.values(cases)) {
    lines.push(`| ${cell(c.claim)} | ${tierLabels[c.expectedTier]} | ${c.finalRoute ? evidenceLabels[c.finalRoute.evidence.status] : "Sin evaluar"} | ${stopLabels[c.stopReason]} | ${c.researchRounds} | ${c.sources} |`);
  }
  for (const c of Object.values(cases)) {
    lines.push("", "## " + c.claim);
    for (const turn of c.routing) {
      lines.push("", `- Ronda ${turn.round}, esfuerzo ${effortLabels[turn.effort]}: ${tierLabels[turn.route.tier]}; ${evidenceLabels[turn.route.evidence.status]}; ${actionLabels[turn.route.action]}; complejidad de referencia ${turn.tierCorrect ? "correcta" : "distinta"}.`,
        "  " + turn.route.reason);
    }
    if (c.finalRoute) {
      const evidence = c.finalRoute.evidence;
      lines.push("", "### Suficiencia", "", ...evidence.covered.map((aspect) => "- Cubierto: " + aspect));
      for (const key of CHECKS) {
        const check = evidence.checks[key];
        lines.push(`- ${checkLabels[key]}: ${checkStatusLabels[check.status]}. ${check.reason}${check.sourceIds.length ? " (" + check.sourceIds.join(", ") + ")" : ""}`);
      }
      for (const gap of evidence.gaps) lines.push(`- Vacío: ${gap.aspect}. ${gap.whyItMatters} Investigación pendiente: ${gap.researchAction}`);
    }
    for (const check of c.researchChecks) {
      for (const issue of check.retrievalIssues) lines.push(`- Acceso fallido: ${issue.url}. ${issue.reason}`);
      if (check.error) lines.push("- Error de investigación: " + check.error);
      if (check.filed > check.grounded) lines.push(`- Citas rechazadas: ${check.filed - check.grounded} de ${check.filed}, ${check.by}, ronda ${check.round}.`);
    }
    lines.push("", "### Evaluaciones");
    if (c.adjudication) {
      lines.push("", `Resolución del moderador sobre vacíos cuestionados${c.adjudication.researched ? " (con una ronda de investigación adicional)" : ""}:`);
      c.adjudication.gaps.forEach((gap, i) => {
        const ruling = c.adjudication!.rulings.find((r) => r.gap === i);
        lines.push(`- ${gap.by}: ${gap.aspect} → ${ruling?.material ? "material" : "no material"}. ${ruling?.reason ?? ""}`);
      });
    }
    if (c.evaluationBudgetExhausted) lines.push("", "Evaluación o rúbrica incompleta por el límite de gasto.");
    for (const a of c.assessments) {
      const grade = c.grades.find((g) => g.candidate === a.candidate);
      lines.push("", `- ${a.by} · ${tierLabels[a.tier]}: **${verdictLabels[a.effectiveVerdict]}**; respuesta original: ${verdictLabels[a.result.verdict]}; citas ${a.validCitations ? "válidas" : "INVÁLIDAS"}; rúbrica LLM ${grade ? [grade.groundedFacts, grade.comparableOrApplicableCriteria, grade.correctReasoning, grade.calibratedConclusion].filter(Boolean).length + "/4" : "sin calificar"}.`,
        "  " + a.result.rationale);
      if (a.abstentionRequired) lines.push("  Se requiere abstención: expediente no habilitado, suficiencia cuestionada o citas inválidas.");
      if (a.sufficiencyChallenged) lines.push("  El evaluador cuestionó la suficiencia aceptada por el moderador.");
      if (a.initialVerdict) lines.push(`  Reevaluó tras la resolución del moderador; respuesta inicial: ${verdictLabels[a.initialVerdict]}.`);
      for (const gap of a.result.evidence.gaps) lines.push(`  Vacío señalado: ${gap.aspect}. ${gap.whyItMatters} Investigación pendiente: ${gap.researchAction}`);
      for (const limitation of a.result.limitations) lines.push("  Limitación: " + limitation);
    }
  }
  lines.push("", `Delta de gasto de la cuenta Gateway: USD ${metadata.deltaUsd.toFixed(4)}. Incluye posible actividad concurrente; no es costo atribuido exacto.`, "",
    "Las trazas JSON conservan identificadores en inglés; este informe presenta los estados en español. Los controles mecánicos comprueban procedencia y referencias, no suficiencia semántica.", "",
    "La rúbrica automática usa GPT-6.1 Sol high, sin nombres de modelos ni tiers. Puede tener sesgos y requiere revisión humana.", "",
    "Los vacíos pendientes se conservan al alcanzar los límites. Sin suficiencia, el resultado efectivo es No verificable; la respuesta original queda en auditoría.");
  if (metadata.failures.length) lines.push("", "## Fallos de ejecución", ...metadata.failures.map((f) => "- " + f));
  return lines.join("\n") + "\n";
}

export function renderSufficiencyReport(cases: Record<string, SufficiencyReport>, failures: string[]) {
  const lines = ["# Evaluación de suficiencia con expedientes controlados", "",
    "Documentos y municipio ficticios. No se consultó la web; las referencias esperadas se ocultaron al moderador. Una muestra por caso no valida una política universal."];
  for (const c of Object.values(cases)) {
    lines.push("", "## " + c.claim, "", `Resultado: ${c.passed ? "Correcto" : "Desvío"}. Complejidad: ${c.tierCorrect ? "correcta" : "distinta"}; suficiencia: ${c.statusCorrect ? "correcta" : "distinta"}; vacíos esperados: ${c.gapsDetected ? "detectados" : "omitidos"}.`);
    for (const turn of c.turns) {
      lines.push("", `Esfuerzo ${effortLabels[turn.effort]}: ${tierLabels[turn.route.tier]}, ${evidenceLabels[turn.route.evidence.status]}, ${actionLabels[turn.route.action]}.`, turn.route.reason);
      for (const key of CHECKS) {
        const check = turn.route.evidence.checks[key];
        lines.push(`- ${checkLabels[key]}: ${checkStatusLabels[check.status]}. ${check.reason}`);
      }
      for (const gap of turn.route.evidence.gaps) lines.push(`- Vacío: ${gap.aspect}. ${gap.whyItMatters} Investigación pendiente: ${gap.researchAction}`);
    }
  }
  if (failures.length) lines.push("", "## Fallos de ejecución", ...failures.map((f) => "- " + f));
  return lines.join("\n") + "\n";
}
