import { JUDGE, MODEL_NAME, type CourtEvent, type Stage, type Submission, type Verdict } from "./court.ts";

export function submissionExcerpt(s: Submission): string {
  if (s.kind === "text") return s.text;
  if (s.kind === "link") return s.note ? s.note + " · " + s.url : s.url;
  return s.note ?? "Imagen";
}

export const STAGE_LABEL: Record<Stage, string> = {
  opening: "exposición inicial",
  rebuttal: "réplica",
  closing: "conclusión",
};

export const VERDICT_LABEL: Record<Verdict, string> = {
  verdadero: "Verdadero",
  falso: "Falso",
  no_verificable: "No verificable",
};

export const ABSENCE_LABEL = { ...STAGE_LABEL, discovery: "investigación", instruction: "instrucción", source_review: "crítica de fuentes", objection: "ronda de objeciones" };
export const EVIDENCE_STANCE_LABEL = { supports: "a favor", opposes: "en contra", context: "contexto" };

export function describe(e: CourtEvent): string {
  switch (e.type) {
    case "session_opened":
      return (e.simulated ? "SIMULACIÓN LOCAL: respuestas y fuentes ficticias. " : "") + "Empieza el debate. Modera " + MODEL_NAME[JUDGE] + ". Participan " + Object.keys(e.counselModels).map((c) => MODEL_NAME[c as keyof typeof MODEL_NAME]).join(", ") + ".";
    case "claims_entered":
      return "El moderador fija las afirmaciones a examinar:\n" + e.claims.map((c) => "[" + c.id + "] " + c.text).join("\n");
    case "dismissed":
      return "El moderador descarta el caso: " + e.reason;
    case "instruction_opened":
      return "Empieza la instrucción: aporte de pruebas a favor y en contra de cada afirmación, sin argumentaciones.";
    case "evidence_filed":
      return "[" + e.evidence.id + "] " + MODEL_NAME[e.evidence.by] + " presenta evidencia sobre " + e.evidence.claimId + (e.evidence.stance ? " (" + EVIDENCE_STANCE_LABEL[e.evidence.stance] + ")" : "") + ": " + e.evidence.title + " (" + e.evidence.url + "). " + e.evidence.excerpt;
    case "instruction_completed":
      return MODEL_NAME[e.by] + " cierra sus aportes de instrucción:\n" + e.searches.map((s) => s.claimId + " — búsqueda a favor: " + s.supporting + "; búsqueda en contra: " + s.opposing).join("\n");
    case "evidence_unified":
      return "El moderador unifica las pruebas para la crítica de fuentes:\n" + (e.sources.map((s) =>
        "[" + s.id + "] " + s.title + " (" + s.url + "). Aportes: " + s.contributions.map((c) => c.id + " de " + MODEL_NAME[c.by] + " sobre " + c.claimId + ": " + c.excerpt).join("; ")
      ).join("\n") || "Sin pruebas aportadas.");
    case "source_review_vote":
      return MODEL_NAME[e.by] + " vota " + (e.veto ? "vetar" : "no vetar") + " la fuente " + e.sourceId + ": " + e.reason;
    case "source_decided":
      return "Fuente " + e.sourceId + ": " + (e.excluded ? "ANULADA por mayoría absoluta (al menos 3 de 4 votos); no puede usarse como prueba." : "admitida; no hubo mayoría absoluta para anularla.");
    case "instruction_closed":
      return "Termina la instrucción. El expediente común queda cerrado antes de las exposiciones; solo pueden citarse fuentes admitidas.";
    case "floor_granted":
      return "El moderador da la palabra a " + MODEL_NAME[e.to] + " para su " + STAGE_LABEL[e.stage] + ".";
    case "statement":
      return "[" + e.id + "] " + MODEL_NAME[e.by] + " (" + STAGE_LABEL[e.stage] + "): " + e.text + (e.evidenceIds.length ? " [cita " + e.evidenceIds.join(", ") + "]" : "");
    case "objection":
      return "[" + e.id + "] " + MODEL_NAME[e.by] + " objeta " + e.against + ": " + e.grounds;
    case "objection_reply":
      return MODEL_NAME[e.by] + " responde a la objeción " + e.objectionId + ": " + e.text;
    case "ruling":
      return "El moderador resuelve la objeción " + e.objectionId + ": " + (e.sustained ? "aceptada, se anula la intervención objetada. " : "rechazada. ") + e.reason;
    case "vote":
      return MODEL_NAME[e.by] + " vota " + VERDICT_LABEL[e.verdict] + " sobre " + e.claimId + ": " + e.rationale;
    case "judgment":
      return "Resultado de " + e.claimId + ": " + VERDICT_LABEL[e.verdict] + (e.method === "consensus" ? " (por mayoría)." : " (desempate del moderador). " + e.reasoning);
    case "absence":
      return MODEL_NAME[e.by] + " no se pronunció en la " + ABSENCE_LABEL[e.stage] + ".";
    case "session_closed":
      return "Termina el debate.";
  }
}
