// Bump when orchestration changes, even if prompts and schemas stay identical.
export const EXPERIMENT_VERSION = 2;

export function validateResume(existing: { version?: number; maxResearchRounds?: number; maxUsd?: number; suite?: string }, maxResearchRounds: number, maxUsd: number, suite = "claims") {
  if (existing.version !== EXPERIMENT_VERSION) {
    throw new Error("La corrida pertenece a otra versión del experimento. Conservá el piloto histórico y usá un directorio nuevo.");
  }
  if (existing.maxResearchRounds !== maxResearchRounds || existing.maxUsd !== maxUsd) {
    throw new Error("Para reanudar, conservá los límites originales de investigación y gasto.");
  }
  if ((existing.suite ?? "claims") !== suite) throw new Error("Para reanudar, conservá la suite original del experimento.");
}
