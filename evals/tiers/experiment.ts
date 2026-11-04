// Bump when orchestration changes, even if prompts and schemas stay identical.
// 4: tier evaluator role, several evaluators and repetitions per controlled case.
export const EXPERIMENT_VERSION = 4;

// What else a run must keep to resume: the tier evaluators compared and the repetitions.
export interface RunSetup { moderators?: string[]; repeat?: number }

export function validateResume(existing: { version?: number; maxResearchRounds?: number; maxUsd?: number; suite?: string; setup?: RunSetup }, maxResearchRounds: number, maxUsd: number, suite = "claims", setup: RunSetup = {}) {
  if (existing.version !== EXPERIMENT_VERSION) {
    throw new Error("La corrida pertenece a otra versión del experimento. Conservá el piloto histórico y usá un directorio nuevo.");
  }
  if (existing.maxResearchRounds !== maxResearchRounds || existing.maxUsd !== maxUsd) {
    throw new Error("Para reanudar, conservá los límites originales de investigación y gasto.");
  }
  if ((existing.suite ?? "claims") !== suite) throw new Error("Para reanudar, conservá la suite original del experimento.");
  if (JSON.stringify(existing.setup ?? {}) !== JSON.stringify(setup)) throw new Error("Para reanudar, conservá los mismos evaluadores de nivel y repeticiones.");
}
