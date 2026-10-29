import { z } from "zod";
import { describe, STAGE_LABEL } from "../domain/acta.ts";
import { COUNSEL, JUDGE, MODEL_NAME, VERDICTS, type Claim, type Counsel, type CourtEvent, type Stage, type Submission } from "../domain/court.ts";
import { Rejection, tool, type Toolset } from "./toolset.ts";

export type SeatId = "judge" | Counsel;

export type TurnSpec =
  | { kind: "intake" }
  | { kind: "discovery"; counsel: Counsel }
  | { kind: "statement"; counsel: Counsel; stage: "opening" | "rebuttal" }
  | { kind: "objection"; counsel: Counsel; speaker: Counsel; statementId: string }
  | { kind: "reply"; speaker: Counsel; objector: Counsel; objectionId: string }
  | { kind: "ruling"; objectionId: string }
  | { kind: "closing"; counsel: Counsel }
  | { kind: "tiebreak" };

export type StampedEvent = CourtEvent & { at: string };

export interface TurnOutcome {
  events: StampedEvent[];
  done: boolean;
}

export interface TurnPlan {
  seat: SeatId;
  instruction: string;
  tools: Toolset;
  produced: StampedEvent[];
  done(): boolean;
}

export interface Docket {
  submission: Submission;
  today: string;
}

const OBJECTION_GROUNDS =
  "afirmación sin evidencia, evidencia inexistente, mal citada o tergiversada, fuente no confiable, o argumento ajeno a las afirmaciones en examen";

function counselBrief(c: Counsel, today: string): string {
  const colleagues = COUNSEL.filter((x) => x !== c).map((x) => MODEL_NAME[x]);
  return [
    "Sos " + MODEL_NAME[c] + ", uno de los tres analistas de Grokeado, un panel de chequeo de datos sin humanos para el público argentino. Tus colegas son " + colleagues.join(" y ") + ". El moderador es " + MODEL_NAME[JUDGE] + ". Hoy es " + today + ".",
    "No defendés ninguna postura de antemano. Tu deber es con la verdad: investigá, presentá evidencia y argumentá tu propia evaluación, aunque contradiga a tus colegas.",
    "Investigá con búsqueda web y lectura de páginas. Preferí fuentes primarias (organismos oficiales, INDEC, Boletín Oficial, documentos originales) y medios con trayectoria. Nunca inventes URLs, cifras ni citas: solo presentá evidencia que hayas leído.",
    "Si tenés herramientas x_*, usalas para lo que se publicó en X (posts, cuentas, noticias) y citá la URL de x.com que devuelven. Un post prueba que alguien lo publicó, no que sea cierto.",
    "Actuás exclusivamente con las herramientas del servidor MCP custom-user-tools habilitadas en cada turno. Lo que escribas fuera de ellas no queda en el registro.",
    "Escribí en español rioplatense, claro, sobrio y conciso.",
  ].join("\n");
}

function judgeBrief(today: string): string {
  return [
    "Sos el moderador de Grokeado, un panel de chequeo de datos sin humanos para el público argentino. Hoy es " + today + ".",
    "Participan tres analistas: " + COUNSEL.map((c) => MODEL_NAME[c]).join(", ") + ". Dirigís el debate: fijás las afirmaciones a examinar, resolvés objeciones y, si los analistas no alcanzan una mayoría sobre una afirmación, la desempatás vos.",
    "Sos imparcial. Resolvé solo con lo que está en el registro. No investigues por tu cuenta, salvo para leer el material enviado al fijar las afirmaciones.",
    "Actuás exclusivamente con las herramientas del servidor MCP custom-user-tools habilitadas en cada turno.",
    "Escribí en español rioplatense, claro y sobrio.",
  ].join("\n");
}

function submissionText(s: Submission): string {
  switch (s.kind) {
    case "text":
      return "Texto enviado:\n«" + s.text + "»";
    case "link":
      return "Enlace enviado: " + s.url + (s.note ? "\nComentario de quien lo envió: " + s.note : "");
    case "image":
      return "Imagen enviada (adjunta)." + (s.note ? "\nComentario de quien la envió: " + s.note : "");
  }
}

// Seats keep no memory between turns: every prompt carries the role brief, the submission and the whole record.
export function composePrompt(input: { seat: SeatId; docket: Docket; record: readonly CourtEvent[]; instruction: string; attempt: number }): string {
  const { seat, docket, record, instruction, attempt } = input;
  const reminder = attempt > 0 ? "No completaste lo pedido con las herramientas habilitadas. Volvé a intentarlo.\n" : "";
  return [
    seat === "judge" ? judgeBrief(docket.today) : counselBrief(seat, docket.today),
    submissionText(docket.submission),
    "Registro del debate hasta ahora:\n" + (record.length ? record.map(describe).join("\n") : "(todavía vacío)"),
    reminder + instruction,
  ].join("\n\n");
}

export function seatOf(spec: TurnSpec): SeatId {
  switch (spec.kind) {
    case "intake":
    case "ruling":
    case "tiebreak":
      return "judge";
    case "reply":
      return spec.speaker;
    default:
      return spec.counsel;
  }
}

export function planTurn(spec: TurnSpec, record: readonly CourtEvent[], submission: Submission): TurnPlan {
  const produced: StampedEvent[] = [];
  const all = (): CourtEvent[] => [...record, ...produced];
  const emit = (e: CourtEvent) => void produced.push({ ...e, at: new Date().toISOString() });
  const count = (type: CourtEvent["type"]) => all().filter((e) => e.type === type).length;
  const claims = (): Claim[] => all().flatMap((e) => (e.type === "claims_entered" ? e.claims : []));
  const claimId = () => z.enum(claims().map((c) => c.id) as [string, ...string[]]);
  const plan = (instruction: string, tools: Toolset, done: () => boolean): TurnPlan => ({ seat: seatOf(spec), instruction, tools, produced, done });

  // Evidence and objections are numbered again when committed, because turns in the same round run in parallel.
  const evidenceTool = (by: Counsel, quiet: boolean) =>
    tool(
      "Presenta una evidencia." + (quiet ? "" : " Devuelve su identificador (P1, P2, ...) para citarla."),
      z.object({
        claimId: claimId().describe("Afirmación a la que se refiere la evidencia"),
        title: z.string().min(3).describe("Fuente y título del documento"),
        url: z.url().describe("URL que leíste"),
        excerpt: z.string().min(10).describe("Fragmento textual o dato concreto que confirma o refuta la afirmación"),
      }),
      (input) => {
        const id = "P" + (count("evidence_filed") + 1);
        emit({ type: "evidence_filed", evidence: { id, by, ...input } });
        return quiet ? "Evidencia registrada." : "Evidencia registrada como " + id + ".";
      }
    );

  const statementOf = (by: Counsel, stage: Stage) => all().find((e) => e.type === "statement" && e.by === by && e.stage === stage);

  const statementTool = (by: Counsel, stage: Stage) =>
    tool(
      "Tu intervención en el debate (" + STAGE_LABEL[stage] + "). Solo una por turno.",
      z.object({
        text: z.string().min(20).describe("Tu intervención, en párrafos breves"),
        evidenceIds: z.array(z.string()).describe("Evidencias del registro que citás (P1, P2, ...)"),
      }),
      ({ text, evidenceIds }) => {
        const existing = statementOf(by, stage);
        if (existing?.type === "statement") throw new Rejection("Ya registraste tu intervención " + existing.id + ".");
        const unknown = evidenceIds.filter((e) => !all().some((x) => x.type === "evidence_filed" && x.evidence.id === e));
        if (unknown.length) throw new Rejection("No están en el registro: " + unknown.join(", ") + ". Presentalas primero.");
        const id = "I" + (count("statement") + 1);
        emit({ type: "statement", id, by, stage, text, evidenceIds });
        return "Intervención registrada como " + id + ".";
      }
    );

  switch (spec.kind) {
    case "intake": {
      const settled = () => claims().length > 0 || all().some((e) => e.type === "dismissed");
      const tools: Toolset = {
        enter_claims: tool(
          "Fija las afirmaciones fácticas verificables (entre 1 y 5) que el panel va a examinar.",
          z.object({
            claims: z
              .array(
                z.object({
                  quote: z.string().describe("Fragmento textual exacto del material enviado, copiado literal. Vacío si el material no es texto."),
                  text: z.string().min(10).describe("La afirmación reformulada de forma autónoma y verificable"),
                })
              )
              .min(1)
              .max(5),
          }),
          (input) => {
            if (settled()) throw new Rejection("Las afirmaciones ya están fijadas.");
            const entered = input.claims.map((c, i) => ({ id: "A" + (i + 1), ...c }));
            emit({ type: "claims_entered", claims: entered });
            return "Afirmaciones fijadas: " + entered.map((c) => c.id).join(", ") + ".";
          }
        ),
        dismiss_case: tool(
          "Descarta el caso cuando el material no contiene ninguna afirmación fáctica verificable (por ejemplo, solo opiniones).",
          z.object({ reason: z.string().min(10) }),
          ({ reason }) => {
            if (settled()) throw new Rejection("Ya te pronunciaste.");
            emit({ type: "dismissed", reason });
            return "Caso descartado.";
          }
        ),
      };
      const instruction =
        "Fijá las afirmaciones a examinar. " +
        (submission.kind === "link" ? "Leé el enlace con WebFetch. " : "") +
        "Extraé entre 1 y 5 afirmaciones fácticas verificables (no opiniones ni predicciones), priorizando las más relevantes. Llamá a enter_claims. Si no hay ninguna afirmación verificable, llamá a dismiss_case.";
      return plan(instruction, tools, settled);
    }

    case "discovery": {
      const by = spec.counsel;
      const instruction =
        "Etapa de investigación. Investigá cada afirmación y presentá la evidencia relevante con file_evidence, una llamada por evidencia. Incluí la evidencia que contradiga tu intuición inicial. Todavía no argumentes.";
      return plan(instruction, { file_evidence: evidenceTool(by, true) }, () => all().some((e) => e.type === "evidence_filed" && e.evidence.by === by));
    }

    case "statement": {
      const { counsel: by, stage } = spec;
      const instruction =
        stage === "opening"
          ? "Tenés la palabra para tu exposición inicial: tu evaluación de cada afirmación, citando evidencia del registro. Podés presentar evidencia nueva antes con file_evidence. Terminá con make_statement."
          : "Tenés la palabra para tu réplica: respondé a lo que sostuvieron tus colegas, señalá errores o coincidencias y corregí tu postura si la evidencia lo amerita. Terminá con make_statement.";
      const tools: Toolset = { file_evidence: evidenceTool(by, false), make_statement: statementTool(by, stage) };
      return plan(instruction, tools, () => statementOf(by, stage) !== undefined);
    }

    case "objection": {
      const { counsel: by, speaker, statementId } = spec;
      let decided = false;
      const tools: Toolset = {
        object: tool(
          "Objeta la intervención " + statementId + ".",
          z.object({ grounds: z.string().min(10).describe("Fundamento concreto de la objeción") }),
          ({ grounds }) => {
            if (decided) throw new Rejection("Ya te pronunciaste en esta ronda.");
            decided = true;
            emit({ type: "objection", id: "O" + (count("objection") + 1), by, against: statementId, grounds });
            return "Objeción registrada.";
          }
        ),
        pass: tool("No objetás la intervención " + statementId + ".", z.object({}), () => {
          if (decided) throw new Rejection("Ya te pronunciaste en esta ronda.");
          decided = true;
          return "Sin objeciones.";
        }),
      };
      const instruction =
        "Ronda de objeciones sobre la intervención " + statementId + " de " + MODEL_NAME[speaker] + ". Objetá solo si hay un defecto real (" + OBJECTION_GROUNDS + "). Si no, usá pass. Llamá exactamente una de las dos herramientas.";
      return plan(instruction, tools, () => decided);
    }

    case "reply": {
      const { speaker, objector, objectionId } = spec;
      const replied = () => all().some((e) => e.type === "objection_reply" && e.objectionId === objectionId);
      const tools: Toolset = {
        reply_objection: tool("Respondé la objeción " + objectionId + ".", z.object({ text: z.string().min(10) }), ({ text }) => {
          if (replied()) throw new Rejection("Ya respondiste.");
          emit({ type: "objection_reply", objectionId, by: speaker, text });
          return "Respuesta registrada.";
        }),
      };
      return plan("Respondé la objeción " + objectionId + " de " + MODEL_NAME[objector] + " con reply_objection.", tools, replied);
    }

    case "ruling": {
      const { objectionId } = spec;
      const ruled = () => all().some((e) => e.type === "ruling" && e.objectionId === objectionId);
      const tools: Toolset = {
        rule: tool(
          "Resolvé la objeción " + objectionId + ".",
          z.object({
            sustained: z.boolean().describe("true: se acepta la objeción y se anula la intervención objetada. false: se rechaza la objeción."),
            reason: z.string().min(10).describe("Fundamento breve"),
          }),
          ({ sustained, reason }) => {
            if (ruled()) throw new Rejection("Ya resolviste esta objeción.");
            emit({ type: "ruling", objectionId, sustained, reason });
            return "Resolución registrada.";
          }
        ),
      };
      return plan("Resolvé la objeción " + objectionId + " con la herramienta rule.", tools, ruled);
    }

    case "closing": {
      const by = spec.counsel;
      const voted = () => all().some((e) => e.type === "vote" && e.by === by);
      const tools: Toolset = {
        make_statement: statementTool(by, "closing"),
        cast_votes: tool(
          "Tu voto final sobre cada afirmación: verdadero, falso o no_verificable (cuando la evidencia disponible no alcanza).",
          z.object({
            votes: z.array(z.object({ claimId: claimId(), verdict: z.enum(VERDICTS), rationale: z.string().min(10) })),
          }),
          (input) => {
            if (voted()) throw new Rejection("Ya registraste tu voto.");
            const ids = input.votes.map((v) => v.claimId);
            const missing = claims().filter((cl) => !ids.includes(cl.id)).map((cl) => cl.id);
            if (missing.length || new Set(ids).size !== ids.length)
              throw new Rejection("Votá exactamente una vez por cada afirmación. Faltan: " + (missing.join(", ") || "ninguna, pero hay repetidas") + ".");
            for (const v of input.votes) emit({ type: "vote", by, ...v });
            return "Votos registrados.";
          }
        ),
      };
      const instruction =
        "Tenés la palabra para tu conclusión. Resumí tu evaluación con make_statement y emití tu voto sobre cada afirmación con cast_votes. Llamá a las dos herramientas.";
      return plan(instruction, tools, () => statementOf(by, "closing") !== undefined && voted());
    }

    case "tiebreak": {
      const judged = new Set(all().flatMap((e) => (e.type === "judgment" ? [e.claimId] : [])));
      const ids = claims().filter((c) => !judged.has(c.id)).map((c) => c.id);
      let decided = false;
      const tools: Toolset = {
        decide: tool(
          "Tu decisión sobre las afirmaciones sin mayoría.",
          z.object({
            decisions: z.array(
              z.object({
                claimId: z.enum(ids as [string, ...string[]]),
                verdict: z.enum(VERDICTS),
                reasoning: z.string().min(20).describe("Fundamento, citando evidencias e intervenciones del registro"),
              })
            ),
          }),
          ({ decisions }) => {
            if (decided) throw new Rejection("Ya registraste tu decisión.");
            const got = decisions.map((d) => d.claimId);
            if (ids.some((id) => !got.includes(id)) || new Set(got).size !== got.length)
              throw new Rejection("Decidí exactamente una vez sobre cada una: " + ids.join(", ") + ".");
            decided = true;
            for (const d of decisions) emit({ type: "judgment", method: "judge", ...d });
            return "Decisión registrada.";
          }
        ),
      };
      const instruction =
        "Los analistas no alcanzaron mayoría sobre " + ids.join(", ") + ". Decidí cada una con la herramienta decide, considerando solo la evidencia y las intervenciones no anuladas del registro.";
      return plan(instruction, tools, () => decided);
    }
  }
}

export type Converse = (request: { seat: SeatId; prompt: string; tools: Toolset }) => Promise<void>;

// One attempt of one seat. A failed conversation is not fatal: the caller sees an unfinished turn and decides whether to try again.
export async function conductTurn(docket: Docket, spec: TurnSpec, record: readonly CourtEvent[], attempt: number, converse: Converse): Promise<TurnOutcome> {
  const plan = planTurn(spec, record, docket.submission);
  const prompt = composePrompt({ seat: plan.seat, docket, record, instruction: plan.instruction, attempt });
  try {
    await converse({ seat: plan.seat, prompt, tools: plan.tools });
  } catch (err) {
    console.error("turn failed:", err instanceof Error ? err.message : err);
  }
  return { events: plan.produced, done: plan.done() };
}
