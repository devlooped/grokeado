// Notifications deliberately contain only fixed messages, never raw provider errors,
// submission text, credentials, or arbitrary URLs.
export function caseFailureMessage(error?: string): string {
  if (error?.includes("Instruction sandbox bridge requires trusted team/project identities and a harness snapshot")) {
    return "No se pudo abrir la instrucción: falta la identidad del proyecto o el snapshot del sandbox. Revisá la configuración en Vercel.";
  }
  if (error?.includes("Durable storage and the authenticated sandbox bridge are required before research")) {
    return "No se pudo abrir la instrucción: faltan almacenamiento o credenciales del sandbox. Revisá la configuración en Vercel.";
  }
  return "La ejecución no pudo completarse. Consultá los registros de Vercel para ver el error.";
}

export type SnapshotHealth = { state: string; title?: string; message?: string };
type SnapshotInfo = { status: string; expiresAt?: Date };

export async function snapshotHealth(
  env: Readonly<Record<string, string | undefined>>,
  get: (id: string) => Promise<SnapshotInfo>,
  now = Date.now(),
): Promise<SnapshotHealth> {
  if (env.COURT_PIPELINE_VERSION === "1" || env.COURT_AI_MODE === "mock") return { state: "disabled" };
  const id = env.INSTRUCTION_SANDBOX_SNAPSHOT_ID || env.EVIDENCE_SANDBOX_SNAPSHOT_ID;
  if (!id) return { state: "missing", title: "Falta el snapshot del sandbox", message: "Configurá EVIDENCE_SANDBOX_SNAPSHOT_ID para habilitar la instrucción." };
  let snapshot: SnapshotInfo;
  try { snapshot = await get(id); }
  catch { return { state: `unavailable:${id}`, title: "No se pudo verificar el snapshot", message: "Revisá el snapshot y las credenciales de Vercel antes de procesar casos." }; }
  if (snapshot.status !== "created") return { state: `invalid:${id}:${snapshot.status}`, title: "Snapshot del sandbox no disponible", message: "El snapshot configurado no está disponible. Revisalo en Vercel." };
  const expires = snapshot.expiresAt?.getTime();
  if (expires !== undefined && Number.isFinite(expires)) {
    const date = snapshot.expiresAt!.toISOString().slice(0, 10);
    if (expires <= now) return { state: `expired:${id}:${expires}`, title: "Snapshot del sandbox vencido", message: `El snapshot venció el ${date} UTC. Generá y configurá uno nuevo.` };
    if (expires - now <= 7 * 24 * 60 * 60 * 1000) return { state: `expiring:${id}:${expires}`, title: "El snapshot del sandbox está por vencer", message: `El snapshot vence el ${date} UTC. Generá y configurá uno nuevo antes de esa fecha.` };
  }
  return { state: `ok:${id}` };
}
