import type { CourtEvent } from "../src/domain/court.ts";
import { appendEvent, createCase, finishCase } from "../src/store.ts";

if (!process.env.GROKEADO_DATA?.includes("fixture")) throw new Error("set GROKEADO_DATA to a fixture folder; this never writes to the real database");

const id = "fixture1";
createCase(id, { kind: "text", text: "[Fixture visual] El dulce de leche se inventó en la Argentina y la birome es un invento argentino." });
const events: CourtEvent[] = [
  { type: "session_opened", judgeModel: "grok-4.7", counselModels: { grok: "grok-4.7", gemini: "gemini-4-argon", claude: "claude-opus-5-5" } },
  { type: "claims_entered", claims: [
    { id: "A1", quote: "El dulce de leche se inventó en la Argentina", text: "El dulce de leche se inventó en la Argentina." },
    { id: "A2", quote: "la birome es un invento argentino", text: "La birome es un invento argentino." },
  ] },
  { type: "evidence_filed", evidence: { id: "P1", by: "claude", claimId: "A1", title: "Fixture: fuente de ejemplo", url: "https://example.org/", excerpt: "Texto de ejemplo para la prueba visual." } },
  { type: "floor_granted", to: "grok", stage: "opening" },
  { type: "statement", id: "S1", by: "grok", stage: "opening", text: "Intervención de ejemplo que luego es testada.", evidenceIds: ["P1"] },
  { type: "objection", id: "O1", by: "claude", against: "S1", grounds: "La prueba citada no dice eso." },
  { type: "objection_reply", objectionId: "O1", by: "grok", text: "Respuesta de ejemplo." },
  { type: "ruling", objectionId: "O1", sustained: true, reason: "La prueba no sostiene la afirmación." },
  { type: "vote", by: "grok", claimId: "A1", verdict: "verdadero", rationale: "Ejemplo." },
  { type: "vote", by: "gemini", claimId: "A1", verdict: "falso", rationale: "Ejemplo." },
  { type: "vote", by: "claude", claimId: "A1", verdict: "no_verificable", rationale: "Ejemplo." },
  { type: "vote", by: "grok", claimId: "A2", verdict: "verdadero", rationale: "Ejemplo." },
  { type: "vote", by: "gemini", claimId: "A2", verdict: "verdadero", rationale: "Ejemplo." },
  { type: "vote", by: "claude", claimId: "A2", verdict: "falso", rationale: "Ejemplo." },
  { type: "judgment", claimId: "A1", verdict: "no_verificable", method: "judge", reasoning: "Fundamento de ejemplo del juez." },
  { type: "judgment", claimId: "A2", verdict: "verdadero", method: "consensus", reasoning: "" },
  { type: "session_closed" },
];
for (const e of events) appendEvent(id, e);
finishCase(id, "resolved");
console.log(id);
