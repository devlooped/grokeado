import type { z } from "zod";
import type { verdictSchema, Routing, Tier, Evidence } from "./core.ts";
import type { Effort, StopReason } from "./workflow.ts";

export const tierLabels: Record<Tier, string> = { fact: "Dato", comparison: "Comparación", assessment: "Evaluación" };
export const verdictLabels: Record<z.infer<typeof verdictSchema>, string> = { true: "Verdadero", false: "Falso", unverifiable: "No verificable" };
export const evidenceLabels: Record<Evidence["status"], string> = { sufficient: "Suficiente", insufficient: "Insuficiente", uncertain: "Incierta" };
export const actionLabels: Record<Routing["action"], string> = { verify: "Verificar", research_more: "Investigar más", escalate: "Escalar razonamiento" };
export const effortLabels: Record<Effort, string> = { medium: "Medio", high: "Alto" };
export const checkLabels: Record<keyof Evidence["checks"], string> = { coverage: "Cobertura", fit: "Comparabilidad y alcance", support: "Respaldo", authority: "Autoridad", contradictions: "Contradicciones", access: "Acceso documental" };
export const checkStatusLabels = { satisfied: "Satisfecho", missing: "Faltante", uncertain: "Incierto" };
export const stopLabels: Record<StopReason, string> = { sufficient: "Evidencia suficiente", iteration_limit: "Límite de investigaciones", budget_exhausted: "Límite de gasto", unresolved_judgment: "Juicio sustantivo pendiente" };
