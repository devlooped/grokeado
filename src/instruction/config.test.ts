import assert from "node:assert/strict";
import test from "node:test";
import { instructionBridgeConfig } from "./config.ts";

const token = (claims: unknown) => `fixture.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`;
const deployed = {
  APP_BASE_URL: "https://court.example.test", EVIDENCE_SANDBOX_SNAPSHOT_ID: "existing-snapshot",
};
const hostToken = token({ owner_id: "team-fixture", project_id: "project-fixture", exp: Math.floor(Date.now() / 1000) + 3600 });
const getHostToken = async () => hostToken;

test("bridge reuses existing app origin, snapshot and host deployment identity", async () => {
  assert.deepEqual(await instructionBridgeConfig(deployed, getHostToken), { origin: deployed.APP_BASE_URL, teamId: "team-fixture", projectId: "project-fixture", snapshotId: "existing-snapshot" });
  assert.equal((await instructionBridgeConfig({ ...deployed, APP_BASE_URL: undefined, VERCEL_URL: "deployment.example.test" }, getHostToken)).origin, "https://deployment.example.test");
});

test("deployment identity comes from Vercel request context instead of the environment", async () => {
  const key = Symbol.for("@vercel/request-context");
  const global = globalThis as typeof globalThis & { [key: symbol]: unknown };
  const previous = global[key];
  global[key] = { get: () => ({ headers: { "x-vercel-oidc-token": hostToken } }) };
  try {
    const config = await instructionBridgeConfig(deployed);
    assert.equal(config.teamId, "team-fixture");
    assert.equal(config.projectId, "project-fixture");
  } finally { if (previous === undefined) delete global[key]; else global[key] = previous; }
});

test("explicit bridge configuration overrides deployment defaults without requiring an OIDC token", async () => {
  assert.deepEqual(await instructionBridgeConfig({
    ...deployed, INSTRUCTION_TOOL_ORIGIN: "https://override.example.test", INSTRUCTION_SANDBOX_TEAM_ID: "explicit-team",
    INSTRUCTION_SANDBOX_PROJECT_ID: "explicit-project", INSTRUCTION_SANDBOX_SNAPSHOT_ID: "explicit-snapshot",
  }, async () => { throw new Error("must not request a token"); }), { origin: "https://override.example.test", teamId: "explicit-team", projectId: "explicit-project", snapshotId: "explicit-snapshot" });
});

test("bridge fails closed without trusted identity, snapshot or a valid HTTPS origin", async () => {
  for (const value of ["malformed", token({ owner_id: "team-fixture" }), token({ owner_id: 42, project_id: "project-fixture" })]) {
    await assert.rejects(instructionBridgeConfig(deployed, async () => value), /requires trusted/);
  }
  await assert.rejects(instructionBridgeConfig(deployed, async () => { throw new Error("unavailable"); }), /requires trusted/);
  await assert.rejects(instructionBridgeConfig({ ...deployed, EVIDENCE_SANDBOX_SNAPSHOT_ID: undefined }, getHostToken), /requires trusted/);
  await assert.rejects(instructionBridgeConfig({ ...deployed, APP_BASE_URL: undefined }, getHostToken), /trusted HTTPS/);
  await assert.rejects(instructionBridgeConfig({ ...deployed, INSTRUCTION_TOOL_ORIGIN: "http://localhost:3000" }, getHostToken), /Invalid trusted/);
  await assert.rejects(instructionBridgeConfig({ ...deployed, INSTRUCTION_TOOL_ORIGIN: "https://court.example.test/path" }, getHostToken), /Invalid trusted/);
});
