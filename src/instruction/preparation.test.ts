import assert from "node:assert/strict";
import test from "node:test";
import { Sandbox } from "@vercel/sandbox";
import { FatalError } from "workflow";
import { MemoryPhaseRepository, PhaseSession } from "../court/phase-session.ts";
import { prepareInSandbox } from "./preparation.ts";

test("preparation requires a final response, preserves checkpoints on exhaustion, and resumes the same sandbox", async () => {
  const keys = ["INSTRUCTION_TOOL_ORIGIN", "INSTRUCTION_SANDBOX_SNAPSHOT_ID", "INSTRUCTION_SANDBOX_TEAM_ID", "INSTRUCTION_SANDBOX_PROJECT_ID"] as const;
  const previous = keys.map((key) => process.env[key]);
  Object.assign(process.env, { INSTRUCTION_TOOL_ORIGIN: "https://staging.example.test", INSTRUCTION_SANDBOX_SNAPSHOT_ID: "fixture-snapshot", INSTRUCTION_SANDBOX_TEAM_ID: "fixture-team", INSTRUCTION_SANDBOX_PROJECT_ID: "fixture-project" });
  try {
    let runs = 0, stops = 0, creates = 0, resumes = 0, harnessUploads = 0, exitCode = 0;
    let response = { messages: [{ role: "assistant", content: "Still working" }], text: "unfinished draft", finishReason: "tool-calls" };
    const tasks: Array<{ callId: string; toolChoice: string; timeoutMs: number }> = [];
    let synthesize = false, interruptRead = false;
    const sandbox = {
      name: "persistent-fixture", writeFiles: async (files: { path: string; content: string }[]) => {
        const task = files.find((file) => file.path === "/workspace/task.json");
        if (task) tasks.push(JSON.parse(task.content));
        if (files.some((file) => file.path === "/opt/evidence-harness/instruction-agent.ts")) {
          harnessUploads++;
          assert.ok(files.find((file) => file.path === "/opt/evidence-harness/instruction-agent.ts")?.content.includes("createGateway"));
          assert.ok(files.find((file) => file.path === "/opt/evidence-harness/compute.ts")?.content.includes("export"));
        }
      },
      runCommand: async (command: { cmd: string }) => { if (command.cmd === "node") { runs++; return { exitCode }; } return { exitCode: 0 }; },
      readFileToBuffer: async () => {
        if (interruptRead) { interruptRead = false; throw new Error("Interrupted before message checkpoint"); }
        return Buffer.from(JSON.stringify(synthesize && tasks.at(-1)?.toolChoice === "none"
          ? { messages: [{ role: "assistant", content: "Final analysis" }], text: "Final analysis", finishReason: "stop" }
          : response));
      },
      stop: async () => { stops++; },
    };
    const deps = {
      sandbox: {
        create: async (input: { timeout: number }) => { assert.equal(input.timeout, 300_000); creates++; return sandbox; },
        get: async (input: { name: string; resume: boolean }) => { assert.deepEqual(input, { name: sandbox.name, resume: true }); resumes++; return sandbox; },
      } as unknown as typeof Sandbox,
      bind: async (_caseId: string, name: string) => { assert.equal(name, sandbox.name); },
    };
    const repository = new MemoryPhaseRepository();
    const initial = { phase: "instruction" as const, seat: "grok" as const, channel: "preparation" as const, model: { id: "fixture/model" }, system: "fixture", tools: "[]", initial: "Canonical material" };
    let session = await PhaseSession.open("fixture", initial, repository);
    await session.begin("exhausted-turn", [], "Prepare");
    await assert.rejects(prepareInSandbox(session, deps), (error) => FatalError.is(error) && /budget exhausted without a final response/.test(error.message));
    assert.equal(runs, 8);
    assert.equal(session.state.turns["exhausted-turn"].complete, false);
    assert.equal(session.state.turns["exhausted-turn"].done, false);
    assert.equal(session.state.activeTurn, undefined, "failed preparation suspends its action grant");
    const prefix = JSON.stringify(session.state.messages);
    session = await PhaseSession.open("fixture", initial, repository);
    await session.begin("exhausted-turn", [], "Prepare");
    await assert.rejects(prepareInSandbox(session, deps), /budget exhausted/);
    assert.equal(runs, 8, "retry must not repeat exhausted model steps");
    assert.equal(JSON.stringify(session.state.messages), prefix);
    assert.equal(creates, 1);
    assert.equal(resumes, 1);
    assert.equal(stops, 2);
    assert.equal(harnessUploads, 1, "new sandboxes get the deployed harness; resumes retain it");

    synthesize = true;
    const synthesizing = await PhaseSession.open("fixture-synthesis", initial, repository);
    await synthesizing.begin("turn", [], "Prepare");
    const first = tasks.length;
    assert.equal(await prepareInSandbox(synthesizing, deps), "Final analysis");
    assert.deepEqual(tasks.slice(first).map((task) => task.toolChoice), [...Array(7).fill("auto"), "none"]);
    assert.equal(synthesizing.state.turns.turn.steps, 8, "synthesis stays within the existing step budget");
    assert.equal(synthesizing.state.turns.turn.complete, true);

    let interrupted = await PhaseSession.open("fixture-interrupted", initial, repository);
    await interrupted.begin("turn", [], "Prepare");
    const beforeInterruption = tasks.length;
    interruptRead = true;
    await assert.rejects(prepareInSandbox(interrupted, deps), /Interrupted before message checkpoint/);
    interrupted = await PhaseSession.open("fixture-interrupted", initial, repository);
    const replayTurn = await interrupted.begin("turn", [], "Prepare");
    replayTurn.expiresAt = new Date(Date.now() + 30_000).toISOString();
    await interrupted.save();
    assert.equal(await prepareInSandbox(interrupted, deps), "Final analysis");
    assert.deepEqual(tasks.slice(beforeInterruption).map((task) => task.toolChoice), ["auto", "auto", "none"]);
    assert.equal(tasks[beforeInterruption].callId, tasks[beforeInterruption + 1].callId, "replay must retain the call ID and tool choice for the broker's request hash");
    assert.equal(replayTurn.preparationToolChoice, undefined);

    const nearDeadline = await PhaseSession.open("fixture-deadline", initial, repository);
    const deadlineTurn = await nearDeadline.begin("turn", [], "Prepare");
    deadlineTurn.expiresAt = new Date(Date.now() + 30_000).toISOString();
    assert.equal(await prepareInSandbox(nearDeadline, deps), "Final analysis");
    assert.equal(deadlineTurn.steps, 1, "little remaining time must force synthesis immediately");
    assert.equal(tasks.at(-1)?.toolChoice, "none");
    assert.ok(tasks.at(-1)!.timeoutMs > 0 && tasks.at(-1)!.timeoutMs <= 30_000);

    const expired = await PhaseSession.open("fixture-expired", initial, repository);
    const expiredTurn = await expired.begin("turn", [], "Prepare");
    expiredTurn.expiresAt = new Date(Date.now() - 1).toISOString();
    const beforeExpiry = runs;
    await assert.rejects(prepareInSandbox(expired, deps), (error) => FatalError.is(error) && /budget exhausted/.test(error.message));
    assert.equal(runs, beforeExpiry, "an expired checkpoint must not spend another model call");
    assert.equal(expiredTurn.complete, false);
    assert.equal(expired.state.activeTurn, undefined);
    synthesize = false;

    for (const [finishReason, text] of [["length", "truncated"], ["stop", "  "], ["stop", "Final analysis"]]) {
      const next = await PhaseSession.open(`fixture-${finishReason}-${text.trim() ? "text" : "empty"}`, initial, repository);
      await next.begin("turn", [], "Prepare");
      response = { messages: [{ role: "assistant", content: text }], text, finishReason };
      if (text === "Final analysis") {
        assert.equal(await prepareInSandbox(next, deps), text);
        assert.equal(next.state.turns.turn.complete, true);
      } else {
        await assert.rejects(prepareInSandbox(next, deps), (error) => FatalError.is(error) && /without a complete final response/.test(error.message));
        assert.equal(next.state.turns.turn.complete, false);
      }
      assert.equal(next.state.activeTurn, undefined);
    }
    const failed = await PhaseSession.open("fixture-command-failure", initial, repository);
    await failed.begin("turn", [], "Prepare");
    exitCode = 1;
    await assert.rejects(prepareInSandbox(failed, deps), /Brokered preparation failed \(exit 1\); refusing independent processing fallback/);
    assert.equal(failed.state.turns.turn.complete, false);
    assert.equal(failed.state.activeTurn, undefined);
  } finally {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
  }
});
