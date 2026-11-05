import assert from "node:assert/strict";
import test from "node:test";
import { Sandbox } from "@vercel/sandbox";
import { MemoryPhaseRepository, PhaseSession } from "../court/phase-session.ts";
import { prepareInSandbox } from "./preparation.ts";

test("preparation requires a final response, preserves checkpoints on exhaustion, and resumes the same sandbox", async () => {
  const keys = ["INSTRUCTION_TOOL_ORIGIN", "INSTRUCTION_SANDBOX_SNAPSHOT_ID", "INSTRUCTION_SANDBOX_TEAM_ID", "INSTRUCTION_SANDBOX_PROJECT_ID"] as const;
  const previous = keys.map((key) => process.env[key]);
  Object.assign(process.env, { INSTRUCTION_TOOL_ORIGIN: "https://staging.example.test", INSTRUCTION_SANDBOX_SNAPSHOT_ID: "fixture-snapshot", INSTRUCTION_SANDBOX_TEAM_ID: "fixture-team", INSTRUCTION_SANDBOX_PROJECT_ID: "fixture-project" });
  try {
    let runs = 0, stops = 0, creates = 0, resumes = 0, harnessUploads = 0;
    let response = { messages: [{ role: "assistant", content: "Still working" }], text: "unfinished draft", finishReason: "tool-calls" };
    const sandbox = {
      name: "persistent-fixture", writeFiles: async (files: { path: string; content: string }[]) => {
        if (files.some((file) => file.path === "/opt/evidence-harness/instruction-agent.ts")) {
          harnessUploads++;
          assert.ok(files.find((file) => file.path === "/opt/evidence-harness/instruction-agent.ts")?.content.includes("createGateway"));
          assert.ok(files.find((file) => file.path === "/opt/evidence-harness/compute.ts")?.content.includes("export"));
        }
      },
      runCommand: async (command: { cmd: string }) => { if (command.cmd === "node") runs++; return { exitCode: 0 }; },
      readFileToBuffer: async () => Buffer.from(JSON.stringify(response)),
      stop: async () => { stops++; },
    };
    const deps = {
      sandbox: {
        create: async () => { creates++; return sandbox; },
        get: async (input: { name: string; resume: boolean }) => { assert.deepEqual(input, { name: sandbox.name, resume: true }); resumes++; return sandbox; },
      } as unknown as typeof Sandbox,
      bind: async (_caseId: string, name: string) => { assert.equal(name, sandbox.name); },
    };
    const repository = new MemoryPhaseRepository();
    const initial = { phase: "instruction" as const, seat: "grok" as const, channel: "preparation" as const, model: { id: "fixture/model" }, system: "fixture", tools: "[]", initial: "Canonical material" };
    let session = await PhaseSession.open("fixture", initial, repository);
    await session.begin("exhausted-turn", [], "Prepare");
    await assert.rejects(prepareInSandbox(session, deps), /budget exhausted without a final response/);
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

    for (const [finishReason, text] of [["length", "truncated"], ["stop", "  "], ["stop", "Final analysis"]]) {
      const next = await PhaseSession.open(`fixture-${finishReason}-${text.trim() ? "text" : "empty"}`, initial, repository);
      await next.begin("turn", [], "Prepare");
      response = { messages: [{ role: "assistant", content: text }], text, finishReason };
      if (text === "Final analysis") {
        assert.equal(await prepareInSandbox(next, deps), text);
        assert.equal(next.state.turns.turn.complete, true);
      } else {
        await assert.rejects(prepareInSandbox(next, deps), /without a complete final response/);
        assert.equal(next.state.turns.turn.complete, false);
      }
      assert.equal(next.state.activeTurn, undefined);
    }
  } finally {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
  }
});
