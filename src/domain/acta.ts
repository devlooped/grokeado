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

const ABSENCE_LABEL = { ...STAGE_LABEL, discovery: "investigación", objection: "ronda de objeciones" };

export function describe(e: CourtEvent): string {
  switch (e.type) {
    case "session_opened":
      return "Empieza el debate. Modera " + MODEL_NAME[JUDGE] + ". Participan " + Object.keys(e.counselModels).map((c) => MODEL_NAME[c as keyof typeof MODEL_NAME]).join(", ") + ".";
    case "claims_entered":
      return "El moderador fija las afirmaciones a examinar:\n" + e.claims.map((c) => "[" + c.id + "] " + c.text).join("\n");
    case "dismissed":
      return "El moderador descarta el caso: " + e.reason;
    case "evidence_filed":
      return "[" + e.evidence.id + "] " + MODEL_NAME[e.evidence.by] + " presenta evidencia sobre " + e.evidence.claimId + ": " + e.evidence.title + " (" + e.evidence.url + "). " + e.evidence.excerpt;
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
