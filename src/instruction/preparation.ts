import { Sandbox } from "@vercel/sandbox";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ModelMessage } from "ai";
import { FatalError } from "workflow";
import type { PhaseSession } from "../court/phase-session.ts";
import { instructionSandboxLaunch } from "../evidence/broker.ts";
import { saveSandboxBinding } from "../store.ts";
import { SourceToolSchemas, sourceToolsFor } from "./tools.ts";
import { ComputeSchema } from "../../sandbox/harness/compute.ts";
import { instructionBridgeConfig } from "./config.ts";

export function preparationDefinitions(phase: PhaseSession["state"]["phase"]) {
  return [
    ...sourceToolsFor(phase).map((name) => ({ type: "function" as const, name, description: name, inputSchema: z.toJSONSchema(SourceToolSchemas[name], { target: "draft-7" }) })),
    { type: "function" as const, name: "compute", description: "compute", inputSchema: z.toJSONSchema(ComputeSchema, { target: "draft-7" }) },
  ];
}

export async function prepareInSandbox(session: PhaseSession, deps = { sandbox: Sandbox, bind: saveSandboxBinding }): Promise<string> {
  const { origin, snapshotId } = await instructionBridgeConfig();
  const turn = session.state.activeTurn!;
  const launch = instructionSandboxLaunch(session.caseId, origin);
  const definitions = preparationDefinitions(session.state.phase);
  const resuming = Boolean(session.state.sandboxId);
  const sandbox = session.state.sandboxId
    ? await deps.sandbox.get({ name: session.state.sandboxId, resume: true })
    : await deps.sandbox.create({ source: { type: "snapshot", snapshotId }, timeout: 300_000, persistent: true, networkPolicy: launch.networkPolicy, env: launch.env, tags: { case: session.caseId.slice(0, 32), phase: session.state.phase, seat: session.state.seat } });
  if (!session.state.sandboxId) { session.state.sandboxId = sandbox.name; await session.save(); }
  await deps.bind(session.caseId, sandbox.name, {
    phase: session.state.phase, seat: session.state.seat, sessionKey: session.key, phaseSessionId: session.state.id,
    expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(), revoked: false, model: session.state.model, gatewayTools: definitions,
    activeTurn: { id: turn.id, expiresAt: turn.expiresAt, remainingRequests: 60 },
  });
  try {
    // Reuse the installed runtime/dependencies in the existing evidence snapshot,
    // but ship this deployment's harness. A code push needs no snapshot rebuild.
    if (!resuming) {
      const files = await Promise.all(["instruction-agent.ts", "compute.ts"].map(async (name) => ({
        path: `/opt/evidence-harness/${name}`, content: await readFile(path.join(process.cwd(), "sandbox/harness", name), "utf8"),
      })));
      await sandbox.writeFiles(files);
    }
    await sandbox.runCommand({ cmd: "mkdir", args: ["-p", "/workspace/scratch"], timeoutMs: 5000 });
    while (!turn.done && turn.steps < 8 && Date.now() < Date.parse(turn.expiresAt)) {
      const callId = `${turn.id}:${turn.steps}`;
      const resultPath = `/workspace/result-${callId.replaceAll(":", "-")}.json`;
      const remainingMs = Math.max(1, Date.parse(turn.expiresAt) - Date.now());
      // Reserve the last step for a real final response, and stop requesting
      // tools when less than a minute remains in this turn.
      const toolChoice = turn.preparationToolChoice ?? (turn.steps === 7 || remainingMs <= 60_000 ? "none" : "auto");
      // The broker deduplicates by call ID and request hash. A replay must not
      // change that request just because less time remains after interruption.
      turn.preparationToolChoice = toolChoice;
      await session.save();
      const commandTimeoutMs = Math.min(165_000, remainingMs);
      const timeoutMs = Math.max(1, Math.min(150_000, commandTimeoutMs - 5000));
      await sandbox.writeFiles([{ path: "/workspace/task.json", content: JSON.stringify({ caseId: session.caseId, callId, model: session.state.model, system: session.state.system, messages: session.state.messages, tools: definitions, toolChoice, timeoutMs, resultPath }) }]);
      const command = await sandbox.runCommand({ cmd: "node", args: ["--import", "/opt/evidence-harness/node_modules/tsx/dist/loader.mjs", "/opt/evidence-harness/instruction-agent.ts", "/workspace/task.json"], cwd: "/workspace", timeoutMs: commandTimeoutMs, signal: AbortSignal.timeout(commandTimeoutMs + 5000) });
      if (command.exitCode !== 0) throw new Error(`Brokered preparation failed (exit ${command.exitCode}); refusing independent processing fallback`);
      const bytes = await sandbox.readFileToBuffer({ path: resultPath });
      if (!bytes || bytes.byteLength > 2_000_000) throw new Error("Preparation checkpoint unavailable");
      const result = JSON.parse(bytes.toString("utf8")) as { messages: ModelMessage[]; text: string; finishReason: string };
      if (!Array.isArray(result.messages) || result.messages.some((message) => message.role !== "assistant" && message.role !== "tool")) throw new Error("Invalid preparation messages");
      turn.draft = result.text;
      turn.done = result.finishReason === "stop" && Boolean(result.text.trim());
      delete turn.preparationToolChoice;
      await session.append(result.messages);
      if (result.finishReason !== "tool-calls" && !turn.done) throw new FatalError("Preparation ended without a complete final response; explicit recovery required");
    }
    if (!turn.done) throw new FatalError(`Preparation budget exhausted without a final response (${session.state.phase}/${session.state.seat}, ${turn.steps}/8 steps); explicit recovery required`);
    await session.finish();
    return turn.draft!;
  } finally {
    // Dropping the active-turn checkpoint suspends grants before the VM stops.
    // The persistent VM may resume next turn, but its grant cannot.
    if (session.state.activeTurn) { delete session.state.activeTurn; await session.save(); }
    await sandbox.stop({ signal: AbortSignal.timeout(10_000) });
  }
}
