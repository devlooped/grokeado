import { Sandbox } from "@vercel/sandbox";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ModelMessage } from "ai";
import { FatalError } from "workflow";
import type { PhaseSession } from "../court/phase-session.ts";
import { instructionSandboxLaunch } from "../evidence/broker.ts";
import { caseSandboxNames, saveSandboxBinding } from "../store.ts";
import { SourceToolSchemas, sourceToolsFor } from "./tools.ts";
import { ComputeSchema } from "../../sandbox/harness/compute.ts";
import { instructionBridgeConfig } from "./config.ts";

export function preparationDefinitions(phase: PhaseSession["state"]["phase"]) {
  return [
    ...sourceToolsFor(phase).map((name) => ({ type: "function" as const, name, description: name, inputSchema: z.toJSONSchema(SourceToolSchemas[name], { target: "draft-7" }) })),
    { type: "function" as const, name: "compute", description: "compute", inputSchema: z.toJSONSchema(ComputeSchema, { target: "draft-7" }) },
  ];
}

// A persistent VM snapshots its filesystem on every stop so the next turn of
// the phase can resume it. Only the latest snapshot is ever resumed: keep that
// one, briefly, and delete the VMs with their snapshots once the case ends.
export const PREPARATION_SNAPSHOTS = { snapshotExpiration: 24 * 60 * 60_000, keepLastSnapshots: { count: 1, deleteEvicted: true } };

// A preparation call runs detached in the VM. One workflow step waits for it at
// most this long, then a later step waits again: no step holds a function for
// the length of a model call plus its tools, whatever the hosting plan allows.
export const PREPARATION_WAIT_MS = 60_000;

type PreparationDependencies = { sandbox: typeof Sandbox; bind: typeof saveSandboxBinding };
type OpenedSandbox = { sandbox?: Sandbox };

async function openSandbox(session: PhaseSession, deps: PreparationDependencies, opened: OpenedSandbox): Promise<Sandbox> {
  if (opened.sandbox) return opened.sandbox;
  const { origin, snapshotId } = await instructionBridgeConfig();
  const launch = instructionSandboxLaunch(session.caseId, origin);
  const resuming = Boolean(session.state.sandboxId);
  const sandbox = session.state.sandboxId
    ? await deps.sandbox.get({ name: session.state.sandboxId, resume: true })
    : await deps.sandbox.create({ source: { type: "snapshot", snapshotId }, timeout: 300_000, persistent: true, ...PREPARATION_SNAPSHOTS, networkPolicy: launch.networkPolicy, env: launch.env, tags: { case: session.caseId.slice(0, 32), phase: session.state.phase, seat: session.state.seat } });
  opened.sandbox = sandbox;
  if (!session.state.sandboxId) { session.state.sandboxId = sandbox.name; await session.save(); }
  // Reuse the installed runtime/dependencies in the existing evidence snapshot,
  // but ship this deployment's harness. A code push needs no snapshot rebuild.
  if (!resuming) {
    const files = await Promise.all(["instruction-agent.ts", "compute.ts"].map(async (name) => ({
      path: `/opt/evidence-harness/${name}`, content: await readFile(path.join(process.cwd(), "sandbox/harness", name), "utf8"),
    })));
    await sandbox.writeFiles(files);
  }
  return sandbox;
}

// The VM keeps running between the calls of one turn. Stop it when the turn
// ends, even from a step that did not open it.
async function stopSandbox(session: PhaseSession, deps: PreparationDependencies, opened: OpenedSandbox): Promise<void> {
  if (opened.sandbox) { await opened.sandbox.stop({ signal: AbortSignal.timeout(10_000) }); return; }
  if (!session.state.sandboxId) return;
  try {
    const sandbox = await deps.sandbox.get({ name: session.state.sandboxId, signal: AbortSignal.timeout(10_000) });
    if (sandbox.status === "running") await sandbox.stop({ signal: AbortSignal.timeout(10_000) });
  } catch (error) { console.warn("Could not stop preparation sandbox:", error); }
}

function exhausted(session: PhaseSession, turn: NonNullable<PhaseSession["state"]["activeTurn"]>): FatalError {
  return new FatalError(`Preparation budget exhausted without a final response (${session.state.phase}/${session.state.seat}, ${turn.steps}/8 steps); explicit recovery required`);
}

// One bounded unit of preparation: start the next model call in the VM and wait
// for it a while, or wait a while more for the call in flight. Returns the draft
// once preparation is complete, undefined while it is under way. Every unit is
// checkpointed, so each runs in a workflow step of its own.
export async function advancePreparation(session: PhaseSession, deps: PreparationDependencies = { sandbox: Sandbox, bind: saveSandboxBinding }, opened: OpenedSandbox = {}, waitMs = PREPARATION_WAIT_MS): Promise<string | undefined> {
  const turn = session.state.activeTurn!;
  const complete = async () => {
    await session.finish();
    await stopSandbox(session, deps, opened);
    return turn.draft!;
  };
  try {
    if (turn.done && !turn.preparationCommand) return await complete();
    let command: Awaited<ReturnType<Sandbox["getCommand"]>>;
    if (turn.preparationCommand) {
      const sandbox = await openSandbox(session, deps, opened);
      try { command = await sandbox.getCommand(turn.preparationCommand.id); }
      catch (error) { return await restart(error); }
    } else {
      // A replay cannot replenish a spent checkpoint.
      if (turn.steps >= 8 || Date.now() >= Date.parse(turn.expiresAt)) throw exhausted(session, turn);
      const sandbox = await openSandbox(session, deps, opened);
      if (!turn.preparationBound) {
        await deps.bind(session.caseId, sandbox.name, {
          phase: session.state.phase, seat: session.state.seat, sessionKey: session.key, phaseSessionId: session.state.id,
          expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(), revoked: false, model: session.state.model, gatewayTools: preparationDefinitions(session.state.phase),
          activeTurn: { id: turn.id, expiresAt: turn.expiresAt, remainingRequests: 60 },
        });
        turn.preparationBound = true;
        await session.save();
      }
      await sandbox.runCommand({ cmd: "mkdir", args: ["-p", "/workspace/scratch"], timeoutMs: 5000 });
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
      await sandbox.writeFiles([{ path: "/workspace/task.json", content: JSON.stringify({ caseId: session.caseId, callId, model: session.state.model, system: session.state.system, messages: session.state.messages, tools: preparationDefinitions(session.state.phase), toolChoice, timeoutMs, resultPath }) }]);
      command = await sandbox.runCommand({ cmd: "node", args: ["--import", "/opt/evidence-harness/node_modules/tsx/dist/loader.mjs", "/opt/evidence-harness/instruction-agent.ts", "/workspace/task.json"], cwd: "/workspace", timeoutMs: commandTimeoutMs, detached: true });
      turn.preparationCommand = { id: command.cmdId, resultPath };
      await session.save();
    }
    const waiting = AbortSignal.timeout(waitMs);
    let exitCode: number;
    try { exitCode = (await command.wait({ signal: waiting })).exitCode; }
    catch (error) {
      if (waiting.aborted) return undefined;
      return await restart(error);
    }
    if (exitCode !== 0) throw new Error(`Brokered preparation failed (exit ${exitCode}); refusing independent processing fallback`);
    const bytes = await opened.sandbox!.readFileToBuffer({ path: turn.preparationCommand!.resultPath });
    if (!bytes || bytes.byteLength > 2_000_000) throw new Error("Preparation checkpoint unavailable");
    const result = JSON.parse(bytes.toString("utf8")) as { messages: ModelMessage[]; text: string; finishReason: string };
    if (!Array.isArray(result.messages) || result.messages.some((message) => message.role !== "assistant" && message.role !== "tool")) throw new Error("Invalid preparation messages");
    turn.draft = result.text;
    turn.done = result.finishReason === "stop" && Boolean(result.text.trim());
    delete turn.preparationToolChoice;
    delete turn.preparationCommand;
    await session.append(result.messages);
    if (result.finishReason !== "tool-calls" && !turn.done) throw new FatalError("Preparation ended without a complete final response; explicit recovery required");
    if (turn.done) return await complete();
    if (turn.steps >= 8 || Date.now() >= Date.parse(turn.expiresAt)) throw exhausted(session, turn);
    return undefined;
  } catch (error) {
    // Dropping the active-turn checkpoint suspends grants before the VM stops.
    // The persistent VM may resume next turn, but its grant cannot.
    if (session.state.activeTurn) { delete session.state.activeTurn; await session.save(); }
    await stopSandbox(session, deps, opened);
    throw error;
  }

  // The VM stopped or lost the call in flight: start the same call again. Its
  // call ID and tool choice are unchanged, so the broker reuses a paid generation.
  async function restart(error: unknown): Promise<undefined> {
    console.warn("Preparation call lost; starting it again:", error instanceof Error ? error.message : error);
    delete turn.preparationCommand;
    await session.save();
    return undefined;
  }
}

// Runs every unit of a preparation turn in this process (tests and scripts).
export async function prepareInSandbox(session: PhaseSession, deps: PreparationDependencies = { sandbox: Sandbox, bind: saveSandboxBinding }): Promise<string> {
  const opened: OpenedSandbox = {};
  for (;;) {
    const draft = await advancePreparation(session, deps, opened);
    if (draft !== undefined) return draft;
  }
}

// Delete every preparation VM of a finished case, with the snapshots only it
// uses. The configured harness snapshot is shared, so it is never deleted.
export async function deleteCaseSandboxes(caseId: string, deps = { sandbox: Sandbox, names: caseSandboxNames }): Promise<void> {
  const results = await Promise.allSettled((await deps.names(caseId)).map(async (name) => {
    const sandbox = await deps.sandbox.get({ name, signal: AbortSignal.timeout(10_000) });
    await sandbox.delete({ deleteOrphanSnapshots: true, signal: AbortSignal.timeout(10_000) });
  }));
  const failed = results.filter((result) => result.status === "rejected");
  if (failed.length) throw new AggregateError(failed.map((result) => result.reason), `Could not delete ${failed.length} sandbox(es) of case ${caseId}`);
}