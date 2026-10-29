import type { SDKImage } from "@cursor/sdk";
import { z } from "zod";
import { describe, STAGE_LABEL } from "../domain/acta.ts";
import {
  COUNSEL,
  JUDGE,
  majority,
  MODEL_NAME,
  VERDICTS,
  type Claim,
  type Counsel,
  type CourtEvent,
  type RecordedEvent,
  type Stage,
  type Submission,
  type Verdict,
} from "../domain/court.ts";
import { Rejection, tool, type Seat, type Toolset } from "./seat.ts";

export interface Court {
  judge: Seat;
  counsel: Record<Counsel, Seat>;
  judgeModel: string;
  counselModels: Record<Counsel, string>;
}

export interface Docket {
  submission: Submission;
  images: SDKImage[];
  today: string;
  record(event: CourtEvent): RecordedEvent;
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

export async function holdSession(court: Court, docket: Docket): Promise<void> {
  const log: RecordedEvent[] = [];
  const seen = new Map<Seat, number>();
  const briefed = new Set<Seat>();
  const counter = { evidence: 0, statement: 0, objection: 0 };
  let claims: Claim[] = [];
  const votes: Partial<Record<Counsel, Map<string, Verdict>>> = {};

  const record = (e: CourtEvent) => {
    const recorded = docket.record(e);
    log.push(recorded);
    return recorded;
  };

  const seatBrief = (seat: Seat) =>
    seat === court.judge ? judgeBrief(docket.today) : counselBrief(COUNSEL.find((c) => court.counsel[c] === seat)!, docket.today);

  function briefing(seat: Seat): string {
    const from = seen.get(seat) ?? 0;
    const news = log.filter((e) => e.seq > from);
    seen.set(seat, log.at(-1)?.seq ?? 0);
    const parts: string[] = [];
    if (!briefed.has(seat)) {
      briefed.add(seat);
      parts.push(seatBrief(seat), submissionText(docket.submission));
    }
    if (news.length) parts.push("Novedades del registro:\n" + news.map(describe).join("\n"));
    return parts.join("\n\n") + "\n\n";
  }

  async function turn(seat: Seat, prompt: string, tools: Toolset, done: () => boolean, images?: SDKImage[]): Promise<boolean> {
    let attempt = 0;
    do {
      const reminder = attempt > 0 ? "No completaste lo pedido con las herramientas habilitadas. Volvé a intentarlo.\n" : "";
      try {
        await seat.send(briefing(seat) + reminder + prompt, tools, attempt === 0 ? images : undefined);
      } catch (err) {
        console.error("turn failed:", err instanceof Error ? err.message : err);
      }
    } while (++attempt < 2 && !done());
    return done();
  }

  const claimId = () => z.enum(claims.map((c) => c.id) as [string, ...string[]]);

  function evidenceTool(by: Counsel) {
    return tool(
      "Presenta una evidencia. Devuelve su identificador (P1, P2, ...) para citarla.",
      z.object({
        claimId: claimId().describe("Afirmación a la que se refiere la evidencia"),
        title: z.string().min(3).describe("Fuente y título del documento"),
        url: z.url().describe("URL que leíste"),
        excerpt: z.string().min(10).describe("Fragmento textual o dato concreto que confirma o refuta la afirmación"),
      }),
      (input) => {
        const id = "P" + ++counter.evidence;
        record({ type: "evidence_filed", evidence: { id, by, ...input } });
        return "Evidencia registrada como " + id + ".";
      }
    );
  }

  function statementTool(by: Counsel, stage: Stage, onRecorded: (id: string) => void) {
    let id: string | undefined;
    return tool(
      "Tu intervención en el debate (" + STAGE_LABEL[stage] + "). Solo una por turno.",
      z.object({
        text: z.string().min(20).describe("Tu intervención, en párrafos breves"),
        evidenceIds: z.array(z.string()).describe("Evidencias del registro que citás (P1, P2, ...)"),
      }),
      ({ text, evidenceIds }) => {
        if (id) throw new Rejection("Ya registraste tu intervención " + id + ".");
        const unknown = evidenceIds.filter((e) => !log.some((x) => x.type === "evidence_filed" && x.evidence.id === e));
        if (unknown.length) throw new Rejection("No están en el registro: " + unknown.join(", ") + ". Presentalas primero.");
        id = "I" + ++counter.statement;
        record({ type: "statement", id, by, stage, text, evidenceIds });
        onRecorded(id);
        return "Intervención registrada como " + id + ".";
      }
    );
  }

  async function objectionRound(speaker: Counsel, statementId: string) {
    const objections: { id: string; by: Counsel }[] = [];
    await Promise.all(
      COUNSEL.filter((c) => c !== speaker).map(async (c) => {
        let decided = false;
        const tools: Toolset = {
          object: tool(
            "Objeta la intervención " + statementId + ".",
            z.object({ grounds: z.string().min(10).describe("Fundamento concreto de la objeción") }),
            ({ grounds }) => {
              if (decided) throw new Rejection("Ya te pronunciaste en esta ronda.");
              decided = true;
              const id = "O" + ++counter.objection;
              record({ type: "objection", id, by: c, against: statementId, grounds });
              objections.push({ id, by: c });
              return "Objeción registrada como " + id + ".";
            }
          ),
          pass: tool("No objetás la intervención " + statementId + ".", z.object({}), () => {
            if (decided) throw new Rejection("Ya te pronunciaste en esta ronda.");
            decided = true;
            return "Sin objeciones.";
          }),
        };
        const prompt =
          "Ronda de objeciones sobre la intervención " + statementId + " de " + MODEL_NAME[speaker] + ". Objetá solo si hay un defecto real (" + OBJECTION_GROUNDS + "). Si no, usá pass. Llamá exactamente una de las dos herramientas.";
        if (!(await turn(court.counsel[c], prompt, tools, () => decided))) record({ type: "absence", by: c, stage: "objection" });
      })
    );

    for (const objection of objections) {
      let replied = false;
      const replyTools: Toolset = {
        reply_objection: tool("Respondé la objeción " + objection.id + ".", z.object({ text: z.string().min(10) }), ({ text }) => {
          if (replied) throw new Rejection("Ya respondiste.");
          replied = true;
          record({ type: "objection_reply", objectionId: objection.id, by: speaker, text });
          return "Respuesta registrada.";
        }),
      };
      if (!(await turn(court.counsel[speaker], "Respondé la objeción " + objection.id + " de " + MODEL_NAME[objection.by] + " con reply_objection.", replyTools, () => replied)))
        record({ type: "absence", by: speaker, stage: "objection" });

      let ruled = false;
      const ruleTools: Toolset = {
        rule: tool(
          "Resolvé la objeción " + objection.id + ".",
          z.object({
            sustained: z.boolean().describe("true: se acepta la objeción y se anula la intervención objetada. false: se rechaza la objeción."),
            reason: z.string().min(10).describe("Fundamento breve"),
          }),
          ({ sustained, reason }) => {
            if (ruled) throw new Rejection("Ya resolviste esta objeción.");
            ruled = true;
            record({ type: "ruling", objectionId: objection.id, sustained, reason });
            return "Resolución registrada.";
          }
        ),
      };
      if (!(await turn(court.judge, "Resolvé la objeción " + objection.id + " con la herramienta rule.", ruleTools, () => ruled)))
        throw new Error("El moderador no resolvió la objeción " + objection.id + ".");
    }
  }

  record({ type: "session_opened", judgeModel: court.judgeModel, counselModels: court.counselModels });

  let dismissed = false;
  const intakeTools: Toolset = {
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
        if (claims.length || dismissed) throw new Rejection("Las afirmaciones ya están fijadas.");
        claims = input.claims.map((c, i) => ({ id: "A" + (i + 1), ...c }));
        record({ type: "claims_entered", claims });
        return "Afirmaciones fijadas: " + claims.map((c) => c.id).join(", ") + ".";
      }
    ),
    dismiss_case: tool(
      "Descarta el caso cuando el material no contiene ninguna afirmación fáctica verificable (por ejemplo, solo opiniones).",
      z.object({ reason: z.string().min(10) }),
      ({ reason }) => {
        if (claims.length || dismissed) throw new Rejection("Ya te pronunciaste.");
        dismissed = true;
        record({ type: "dismissed", reason });
        return "Caso descartado.";
      }
    ),
  };
  const intakePrompt =
    "Fijá las afirmaciones a examinar. " +
    (docket.submission.kind === "link" ? "Leé el enlace con WebFetch. " : "") +
    "Extraé entre 1 y 5 afirmaciones fácticas verificables (no opiniones ni predicciones), priorizando las más relevantes. Llamá a enter_claims. Si no hay ninguna afirmación verificable, llamá a dismiss_case.";
  if (!(await turn(court.judge, intakePrompt, intakeTools, () => claims.length > 0 || dismissed, docket.images)))
    throw new Error("El moderador no fijó las afirmaciones.");
  if (dismissed) {
    record({ type: "session_closed" });
    return;
  }

  await Promise.all(
    COUNSEL.map(async (c) => {
      const filed = () => log.some((e) => e.type === "evidence_filed" && e.evidence.by === c);
      const prompt =
        "Etapa de investigación. Investigá cada afirmación y presentá la evidencia relevante con file_evidence, una llamada por evidencia. Incluí la evidencia que contradiga tu intuición inicial. Todavía no argumentes.";
      if (!(await turn(court.counsel[c], prompt, { file_evidence: evidenceTool(c) }, filed, docket.images)))
        record({ type: "absence", by: c, stage: "discovery" });
    })
  );

  for (const stage of ["opening", "rebuttal"] as const) {
    for (const c of COUNSEL) {
      record({ type: "floor_granted", to: c, stage });
      let statementId: string | undefined;
      const prompt =
        stage === "opening"
          ? "Tenés la palabra para tu exposición inicial: tu evaluación de cada afirmación, citando evidencia del registro. Podés presentar evidencia nueva antes con file_evidence. Terminá con make_statement."
          : "Tenés la palabra para tu réplica: respondé a lo que sostuvieron tus colegas, señalá errores o coincidencias y corregí tu postura si la evidencia lo amerita. Terminá con make_statement.";
      const tools: Toolset = {
        file_evidence: evidenceTool(c),
        make_statement: statementTool(c, stage, (id) => (statementId = id)),
      };
      if (!(await turn(court.counsel[c], prompt, tools, () => statementId !== undefined))) {
        record({ type: "absence", by: c, stage });
        continue;
      }
      await objectionRound(c, statementId!);
    }
  }

  for (const c of COUNSEL) {
    record({ type: "floor_granted", to: c, stage: "closing" });
    let statementId: string | undefined;
    const tools: Toolset = {
      make_statement: statementTool(c, "closing", (id) => (statementId = id)),
      cast_votes: tool(
        "Tu voto final sobre cada afirmación: verdadero, falso o no_verificable (cuando la evidencia disponible no alcanza).",
        z.object({
          votes: z.array(z.object({ claimId: claimId(), verdict: z.enum(VERDICTS), rationale: z.string().min(10) })),
        }),
        (input) => {
          if (votes[c]) throw new Rejection("Ya registraste tu voto.");
          const ids = input.votes.map((v) => v.claimId);
          const missing = claims.filter((cl) => !ids.includes(cl.id)).map((cl) => cl.id);
          if (missing.length || new Set(ids).size !== ids.length)
            throw new Rejection("Votá exactamente una vez por cada afirmación. Faltan: " + (missing.join(", ") || "ninguna, pero hay repetidas") + ".");
          votes[c] = new Map(input.votes.map((v) => [v.claimId, v.verdict]));
          for (const v of input.votes) record({ type: "vote", by: c, ...v });
          return "Votos registrados.";
        }
      ),
    };
    const prompt =
      "Tenés la palabra para tu conclusión. Resumí tu evaluación con make_statement y emití tu voto sobre cada afirmación con cast_votes. Llamá a las dos herramientas.";
    if (!(await turn(court.counsel[c], prompt, tools, () => statementId !== undefined && votes[c] !== undefined)) && !votes[c])
      record({ type: "absence", by: c, stage: "closing" });
  }

  const undecided: Claim[] = [];
  for (const claim of claims) {
    const verdict = majority(COUNSEL.flatMap((c) => votes[c]?.get(claim.id) ?? []));
    if (verdict) record({ type: "judgment", claimId: claim.id, verdict, method: "consensus", reasoning: "" });
    else undecided.push(claim);
  }

  if (undecided.length) {
    let decided = false;
    const ids = undecided.map((c) => c.id);
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
          for (const d of decisions) record({ type: "judgment", method: "judge", ...d });
          return "Decisión registrada.";
        }
      ),
    };
    const prompt =
      "Los analistas no alcanzaron mayoría sobre " + ids.join(", ") + ". Decidí cada una con la herramienta decide, considerando solo la evidencia y las intervenciones no anuladas del registro.";
    if (!(await turn(court.judge, prompt, tools, () => decided))) throw new Error("El moderador no desempató.");
  }

  record({ type: "session_closed" });
}
