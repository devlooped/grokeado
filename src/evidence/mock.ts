import { parseEvidenceDocument, serializeEvidenceDocument } from "./okf.ts";
import type { EvidenceSeat, EvidenceStage, EvidenceDocument } from "./schema.ts";
import type { EvidenceFiles } from "./validate.ts";
import { sha256 } from "./validate.ts";

export function createMockEvidencePromotion(
  original: EvidenceFiles,
  seat: EvidenceSeat,
  stage: EvidenceStage
): Map<string, string> {
  const sourcePath = "evidence/base/docs/submission.md";
  const source = original.get(sourcePath);
  if (!source) throw new Error("The mock evidence harness requires base/docs/submission.md.");
  const sourceDocument = parseEvidenceDocument(typeof source === "string" ? source : new TextDecoder().decode(source));
  const rawSource = sourceDocument.sources[0];
  if (!rawSource) throw new Error("The mock evidence source has no raw source.");
  const generated = { by: seat, at: sourceDocument.generated.at };
  const fragmentPath = `evidence/${seat}/mock-${stage}-fragment.md`;
  const fragment: EvidenceDocument = {
    type: "fragment",
    title: "Mock source passage",
    description: "Deterministic fixture fragment produced without starting a sandbox.",
    sources: [rawSource],
    generated,
    page: 1,
    reprocess_of: `/evidence/base/docs/submission.md#p1`,
  };
  const argument: EvidenceDocument = {
    type: "argument",
    title: `Mock ${stage} draft`,
    description: "Deterministic fixture argument; not a model conclusion.",
    sources: [rawSource],
    generated,
    stage,
    supports: [`/${fragmentPath}#p1`],
    refutes: [],
  };
  const files = new Map<string, string>([
    [fragmentPath, serializeEvidenceDocument(fragment, `[p.1] Fixture source hash: ${sha256(typeof source === "string" ? source : new Uint8Array(source))}.`)],
    [`evidence/${seat}/mock-${stage}-argument.md`, serializeEvidenceDocument(argument, "This draft is only for workflow tests.")],
  ]);
  return files;
}
