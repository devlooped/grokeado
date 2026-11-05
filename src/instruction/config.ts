import { trustedInstructionOrigin } from "../evidence/broker.ts";

export function instructionBridgeConfig(env: Readonly<Record<string, string | undefined>> = process.env) {
  let teamId = env.INSTRUCTION_SANDBOX_TEAM_ID;
  let projectId = env.INSTRUCTION_SANDBOX_PROJECT_ID;
  if (!teamId || !projectId) {
    // This is the host's deployment credential, not an incoming request token.
    // Match the Sandbox SDK's owner_id/project_id identity resolution. Incoming
    // sandbox requests still require the SDK's signature/audience verification.
    try {
      const payload = JSON.parse(Buffer.from(env.VERCEL_OIDC_TOKEN!.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
      teamId ||= typeof payload.owner_id === "string" ? payload.owner_id : undefined;
      projectId ||= typeof payload.project_id === "string" ? payload.project_id : undefined;
    } catch { /* Missing deployment identity is rejected below. */ }
  }
  const snapshotId = env.INSTRUCTION_SANDBOX_SNAPSHOT_ID || env.EVIDENCE_SANDBOX_SNAPSHOT_ID;
  if (!teamId || !projectId || !snapshotId) throw new Error("Instruction sandbox bridge requires trusted team/project identities and a harness snapshot");
  const rawOrigin = env.INSTRUCTION_TOOL_ORIGIN ?? env.APP_BASE_URL ?? (env.VERCEL_URL ? `https://${env.VERCEL_URL}` : undefined);
  if (!rawOrigin) throw new Error("Instruction sandbox bridge requires a trusted HTTPS application origin");
  const origin = trustedInstructionOrigin(rawOrigin);
  return { origin, teamId, projectId, snapshotId };
}
