import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import nextEnv from "@next/env";
import { Pool } from "pg";
import { Sandbox } from "@vercel/sandbox";
import { PhaseSession } from "../src/court/phase-session.ts";
import { prepareInSandbox } from "../src/instruction/preparation.ts";
import { requireLocalDatabase } from "../src/lib/local-database.ts";
import { consumeSandboxBinding, createCase, deleteCase, finishCase, getCase, getCaseAuditRecords, getCover, getEvents, getImage, getSourceOperations, loadPhaseCheckpoint, openSession, recordEvents, requeueCase, revokeSandboxBindings, saveCaseAuditRecord, saveCaseLanguage, saveCaseModels, saveCover, saveSandboxBinding, sourceOperationRepository as operations } from "../src/store.ts";

nextEnv.loadEnvConfig(process.cwd(), true);
const cleanup = new Pool({ connectionString: requireLocalDatabase(), connectionTimeoutMillis: 5000 });
const id = `fixture-rerun-${randomUUID()}`;
const submission = { kind: "image" as const, mimeType: "image/png", note: "Original fixture input", language: "es" as const };
const image = Buffer.from("Original fixture image");
const initial = { phase: "intake" as const, seat: "judge" as const, channel: "preparation" as const, model: { id: "fixture/old-model" }, system: "Old system", tools: "[]", initial: "Old canonical material" };
const artifacts = new Map([["old-artifact", "Old generated output"]]);
await createCase(id, submission, image, "fixture-owner");
try {
  await openSession(id, 2);
  await saveCaseLanguage(id, "es");
  await saveCaseModels(id, { judge: { id: "fixture/old-model", effort: null } });
  await recordEvents(id, [{ type: "instruction_opened", seq: 1, at: new Date().toISOString() }]);
  await saveCover(id, { mimeType: "image/png", bytes: Buffer.from("Old generated cover"), generated: true });
  const claim = await operations.claim(id, "old-operation", "acquisition", 30_000);
  assert.ok(claim.owned);
  await operations.publish(id, "old-operation", claim.owner, { old: true });
  await operations.alias(id, "https://example.test/old", "old-source");
  await saveCaseAuditRecord(id, "old-audit", { old: true });
  const old = await PhaseSession.open(id, initial);
  await old.begin("old-turn", [], "Old task");
  old.state.sandboxId = "old-sandbox";
  await old.save();
  await saveSandboxBinding(id, "old-sandbox", { phase: "intake", seat: "judge", sessionKey: old.key, phaseSessionId: old.state.id, revoked: false, model: old.state.model, gatewayTools: [], expiresAt: old.state.activeTurn!.expiresAt });
  await revokeSandboxBindings(id);
  await finishCase(id, "failed", "Fixture failure");

  let cleanups = 0;
  const results = await Promise.all(Array.from({ length: 2 }, () => requeueCase(id, async (ids) => {
    assert.deepEqual(ids, [id]);
    cleanups++;
    artifacts.clear();
  })));
  assert.equal(results.filter(Boolean).length, 1, "one concurrent retry wins the reset");
  assert.equal(cleanups, 1);
  const reset = await getCase(id);
  assert.equal(reset?.id, id);
  assert.equal(reset?.status, "queued");
  assert.equal(reset?.ownerId, "fixture-owner");
  assert.deepEqual(reset?.submission, submission);
  assert.equal(reset?.models, undefined);
  assert.equal(reset?.pipelineVersion, 1, "old pipeline selection was removed");
  assert.equal(reset?.error, undefined);
  assert.deepEqual(await getImage(id), { mimeType: "image/png", bytes: image });
  assert.deepEqual(await getEvents(id), []);
  assert.equal(await getCover(id), undefined);
  assert.deepEqual(await getSourceOperations(id), []);
  assert.equal(await operations.resolve(id, "https://example.test/old"), undefined);
  assert.deepEqual(await getCaseAuditRecords(id), []);
  assert.equal(await loadPhaseCheckpoint(id, old.key), undefined);
  await assert.rejects(consumeSandboxBinding("old-sandbox", id), /sandbox_forbidden/);
  assert.equal(artifacts.size, 0);

  const keys = ["INSTRUCTION_TOOL_ORIGIN", "INSTRUCTION_SANDBOX_TEAM_ID", "INSTRUCTION_SANDBOX_PROJECT_ID", "INSTRUCTION_SANDBOX_SNAPSHOT_ID"] as const;
  const previous = keys.map((key) => process.env[key]);
  Object.assign(process.env, { INSTRUCTION_TOOL_ORIGIN: "https://example.test", INSTRUCTION_SANDBOX_TEAM_ID: "fixture-team", INSTRUCTION_SANDBOX_PROJECT_ID: "fixture-project", INSTRUCTION_SANDBOX_SNAPSHOT_ID: "fixture-latest-snapshot" });
  try {
    assert.equal((await openSession(id, () => 2)).pipelineVersion, 2);
    const fresh = await PhaseSession.open(id, { ...initial, model: { id: "fixture/current-model" }, system: "Current system", initial: "Current canonical material" });
    assert.notEqual(fresh.state.id, old.state.id);
    assert.equal(fresh.state.sandboxId, undefined);
    assert.deepEqual(fresh.state.turns, {});
    await fresh.begin("fresh-turn", [], "Fresh task");
    const sandbox = {
      name: `fresh-${id}`, writeFiles: async () => {}, runCommand: async () => ({ exitCode: 0 }), stop: async () => {},
      readFileToBuffer: async () => Buffer.from(JSON.stringify({ messages: [{ role: "assistant", content: "Fresh analysis" }], text: "Fresh analysis", finishReason: "stop" })),
    };
    let creates = 0;
    assert.equal(await prepareInSandbox(fresh, {
      sandbox: {
        create: async (params: { source: { snapshotId: string } }) => { assert.equal(params.source.snapshotId, "fixture-latest-snapshot"); creates++; return sandbox; },
        get: async () => { throw new Error("A fresh rerun must never resume an old VM"); },
      } as unknown as typeof Sandbox,
      bind: saveSandboxBinding,
    }), "Fresh analysis");
    assert.equal(creates, 1);
    assert.equal(fresh.state.sandboxId, sandbox.name);
  } finally {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
  }
  console.log("Local PostgreSQL: failed-case retry fully resets generated state, preserves ID/input/image, admits one retry and creates a fresh mocked VM from current snapshot configuration; no Blob or paid AI calls.");
} finally {
  await finishCase(id, "failed");
  assert.equal(await deleteCase(id, async () => {}), "deleted");
  await cleanup.query("DELETE FROM admin_notifications WHERE case_id = $1", [id]);
  await cleanup.end();
}
