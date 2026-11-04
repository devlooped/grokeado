import { parseEvidenceDocument, serializeEvidenceDocument } from "./okf.ts";
import type { EvidenceSeat, EvidenceStage, EvidenceDocument } from "./schema.ts";
import type { EvidenceFiles } from "./validate.ts";
import { sha256 } from "./validate.ts";
import { MOCK_MODEL_ID } from "../court/models.ts";

const STAGE_LABEL: Record<EvidenceStage, string> = {
  exposicion: "exposición",
  objecion: "objeción",
  conclusion: "conclusión",
};

export function createMockEvidencePromotion(
  original: EvidenceFiles,
  seat: EvidenceSeat,
  stage: EvidenceStage
): Map<string, string> {
  const sourcePath = "evidence/base/docs/submission.md";
  const source = original.get(sourcePath);
  if (!source) throw new Error("El entorno ficticio de evidencia requiere base/docs/submission.md.");
  const sourceDocument = parseEvidenceDocument(typeof source === "string" ? source : new TextDecoder().decode(source));
  const rawSource = sourceDocument.sources[0];
  if (!rawSource) throw new Error("La fuente base ficticia no tiene archivo original.");
  const generated = { by: seat, at: sourceDocument.generated.at, modelId: MOCK_MODEL_ID, effort: null };
  const fragmentPath = `evidence/${seat}/mock-${stage}-fragment.md`;
  const fragment: EvidenceDocument = {
    type: "fragment",
    title: "Pasaje ficticio de fuente",
    description: "Fragmento ficticio determinístico generado sin iniciar un entorno aislado.",
    sources: [rawSource],
    generated,
    page: 1,
    reprocess_of: `/evidence/base/docs/submission.md#p1`,
  };
  const argument: EvidenceDocument = {
    type: "argument",
    title: `Borrador ficticio de ${STAGE_LABEL[stage]}`,
    description: "Borrador ficticio determinístico; no es una conclusión real del modelo.",
    sources: [rawSource],
    generated,
    stage,
    supports: [`/${fragmentPath}#p1`],
    refutes: [],
  };
  const files = new Map<string, string>([
    [fragmentPath, serializeEvidenceDocument(fragment, `[p.1] Hash de la fuente de prueba: ${sha256(typeof source === "string" ? source : new Uint8Array(source))}.`)],
    [`evidence/${seat}/mock-${stage}-argument.md`, serializeEvidenceDocument(argument, "Este borrador es solo para pruebas del flujo.")],
  ]);
  // Retried simulations may have promoted a document before metadata was added.
  for (const [path] of files) {
    const existing = original.get(path);
    if (existing !== undefined) files.set(path, typeof existing === "string" ? existing : new TextDecoder("utf-8", { fatal: true }).decode(existing));
  }
  return files;
}
