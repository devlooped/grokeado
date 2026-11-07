// Shared by the Expert turns and the Quick check. Kept apart from turns.ts so
// the workflow bundle, which runs Quick orchestration, does not import its tools.
export const VERDICT_INSTRUCTIONS =
  "Choose verdadero if the evidence supports the claim; falso if it contradicts it; no_verificable (Insostenible) if it is not enough to support or refute it; or enganoso (Engañoso) if it presents partial or out-of-context data that leads to a wrong conclusion.";
