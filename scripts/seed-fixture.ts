import type { RecordedEvent } from "../src/domain/court.ts";
import { createCase, finishCase, recordEvents } from "../src/store.ts";

if (!process.env.DATABASE_URL?.includes("fixture")) throw new Error("point DATABASE_URL at a throwaway database whose URL contains 'fixture'; this never writes to the real database");

const id = "fixture1";
await createCase(id, { kind: "text", text: "[Fixture visual] El dulce de leche se inventó en la Argentina y la birome es un invento argentino." });
const events = [
  { type: "session_opened", judgeModel: "grok-4.7", counselModels: { grok: "grok-4.7", gemini: "gemini-4-argon", claude: "claude-opus-5-5", openai: "gpt-5.5" } },
  { type: "claims_entered", claims: [
    { id: "A1", quote: "El dulce de leche se inventó en la Argentina", text: "El dulce de leche se inventó en la Argentina." },
    { id: "A2", quote: "la birome es un invento argentino", text: "La birome es un invento argentino." },
  ] },
  { type: "evidence_filed", evidence: { id: "P1", by: "claude", claimId: "A1", title: "Fixture: fuente de ejemplo", url: "https://example.org/", excerpt: "Texto de ejemplo para la prueba visual." } },
  { type: "evidence_filed", evidence: { id: "P2", by: "openai", claimId: "A2", title: "Fixture: antecedentes de la birome", url: "https://example.org/", excerpt: "Ejemplo ficticio: la historia del invento incluye a László Bíró y su trabajo en Argentina." } },
  { type: "floor_granted", to: "openai", stage: "opening" },
  { type: "statement", id: "I2", by: "openai", stage: "opening", text: "La trayectoria de Bíró conecta el invento con Argentina, aunque su origen requiere matices. Ejemplo ficticio.", evidenceIds: ["P2"] },
  { type: "floor_granted", to: "grok", stage: "opening" },
  { type: "statement", id: "I1", by: "grok", stage: "opening", text: "Intervención de ejemplo que luego es anulada.", evidenceIds: ["P1"] },
  { type: "objection", id: "O1", by: "claude", against: "I1", grounds: "La evidencia citada no dice eso." },
  { type: "objection_reply", objectionId: "O1", by: "grok", text: "Respuesta de ejemplo." },
  { type: "ruling", objectionId: "O1", sustained: true, reason: "La evidencia no sostiene la afirmación." },
  { type: "vote", by: "grok", claimId: "A1", verdict: "verdadero", rationale: "Ejemplo." },
  { type: "vote", by: "gemini", claimId: "A1", verdict: "falso", rationale: "Ejemplo." },
  { type: "vote", by: "claude", claimId: "A1", verdict: "no_verificable", rationale: "Ejemplo." },
  { type: "vote", by: "grok", claimId: "A2", verdict: "verdadero", rationale: "Ejemplo." },
  { type: "vote", by: "gemini", claimId: "A2", verdict: "verdadero", rationale: "Ejemplo." },
  { type: "vote", by: "claude", claimId: "A2", verdict: "falso", rationale: "Ejemplo." },
  { type: "vote", by: "openai", claimId: "A1", verdict: "no_verificable", rationale: "Ejemplo ficticio: el origen es disputado." },
  { type: "vote", by: "openai", claimId: "A2", verdict: "verdadero", rationale: "Ejemplo ficticio: Bíró desarrolló su invento en Argentina." },
  { type: "judgment", claimId: "A1", verdict: "no_verificable", method: "judge", reasoning: "Fundamento de ejemplo del moderador." },
  { type: "judgment", claimId: "A2", verdict: "verdadero", method: "consensus", reasoning: "" },
  { type: "session_closed" },
];
const at = new Date().toISOString();
await recordEvents(id, events.map((e, i): RecordedEvent => ({ ...e, seq: i + 1, at }) as RecordedEvent));
await finishCase(id, "resolved");
console.log(id);
