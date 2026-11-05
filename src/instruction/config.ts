import { getVercelOidcToken } from "@vercel/oidc";
import { trustedInstructionOrigin } from "../evidence/broker.ts";

export async function instructionBridgeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  getToken: () => Promise<string> = getVercelOidcToken,
) {
  let teamId = env.INSTRUCTION_SANDBOX_TEAM_ID;
  let projectId = env.INSTRUCTION_SANDBOX_PROJECT_ID;
  const snapshotId = env.INSTRUCTION_SANDBOX_SNAPSHOT_ID || env.EVIDENCE_SANDBOX_SNAPSHOT_ID;
  if (!snapshotId) throw new Error("Instruction sandbox bridge requires trusted team/project identities and a harness snapshot");
  if (!teamId || !projectId) {
    // Retrieve the host deployment credential the same way as the Sandbox SDK:
    // in production it is supplied through Vercel's request context. This is
    // not the incoming sandbox token, which the proxy verifies separately.
    try {
      const payload = JSON.parse(Buffer.from((await getToken()).split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
      teamId ||= typeof payload.owner_id === "string" ? payload.owner_id : undefined;
      projectId ||= typeof payload.project_id === "string" ? payload.project_id : undefined;
    } catch { /* Missing deployment identity is rejected below. */ }
  }
  if (!teamId || !projectId) throw new Error("Instruction sandbox bridge requires trusted team/project identities and a harness snapshot");
  const rawOrigin = env.INSTRUCTION_TOOL_ORIGIN ?? env.APP_BASE_URL ?? (env.VERCEL_URL ? `https://${env.VERCEL_URL}` : undefined);
  if (!rawOrigin) throw new Error("Instruction sandbox bridge requires a trusted HTTPS application origin");
  const origin = trustedInstructionOrigin(rawOrigin);
  return { origin, teamId, projectId, snapshotId };
}
