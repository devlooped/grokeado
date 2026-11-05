import { MemoryArtifactStore } from "../evidence/artifacts.ts";
import { MemoryOperationRepository } from "./source-store.ts";
import { extractSource, type SourceDependencies } from "./sources.ts";
import type { researchWorker } from "./research.ts";

export const mockInstructionArtifacts = new MemoryArtifactStore();
export const mockInstructionSources: SourceDependencies = {
  operations: new MemoryOperationRepository(), artifacts: mockInstructionArtifacts, extract: extractSource,
  translatorModelId: "court-fixture", translatorFingerprint: "mock-v1",
  translate: async (input) => ({ ...input, changed: false }),
  verifyLanguage: async () => ({ matches: true }),
  download: async (url) => ({ ok: true, finalUrl: url, redirects: 0, contentType: "text/plain", bytes: new TextEncoder().encode("SIMULACIÓN LOCAL: Documento ficticio con datos 42, sin valor probatorio. " + url) }),
};
export const mockResearchWorker: typeof researchWorker = async (_kind, query, model) => ({
  text: "SIMULACIÓN LOCAL: Resultados ficticios, no son pruebas. " + query,
  sources: [], usage: {} as Awaited<ReturnType<typeof researchWorker>>["usage"], modelId: model.id,
});
