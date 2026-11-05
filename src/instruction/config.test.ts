import assert from "node:assert/strict";
import test from "node:test";
import { instructionBridgeConfig } from "./config.ts";

const token = (claims: unknown) => `fixture.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`;
const deployed = {
  APP_BASE_URL: "https://court.example.test", EVIDENCE_SANDBOX_SNAPSHOT_ID: "existing-snapshot",
  VERCEL_OIDC_TOKEN: token({ owner_id: "team-fixture", project_id: "project-fixture" }),
};

test("bridge reuses existing app origin, snapshot and host deployment identity", () => {
  assert.deepEqual(instructionBridgeConfig(deployed), { origin: deployed.APP_BASE_URL, teamId: "team-fixture", projectId: "project-fixture", snapshotId: "existing-snapshot" });
  assert.equal(instructionBridgeConfig({ ...deployed, APP_BASE_URL: undefined, VERCEL_URL: "deployment.example.test" }).origin, "https://deployment.example.test");
});

test("explicit bridge configuration overrides deployment defaults without requiring an OIDC token", () => {
  assert.deepEqual(instructionBridgeConfig({
    ...deployed, VERCEL_OIDC_TOKEN: undefined,
    INSTRUCTION_TOOL_ORIGIN: "https://override.example.test", INSTRUCTION_SANDBOX_TEAM_ID: "explicit-team",
    INSTRUCTION_SANDBOX_PROJECT_ID: "explicit-project", INSTRUCTION_SANDBOX_SNAPSHOT_ID: "explicit-snapshot",
  }), { origin: "https://override.example.test", teamId: "explicit-team", projectId: "explicit-project", snapshotId: "explicit-snapshot" });
});

test("bridge fails closed without trusted identity, snapshot or a valid HTTPS origin", () => {
  for (const VERCEL_OIDC_TOKEN of [undefined, "malformed", token({ owner_id: "team-fixture" }), token({ owner_id: 42, project_id: "project-fixture" })]) {
    assert.throws(() => instructionBridgeConfig({ ...deployed, VERCEL_OIDC_TOKEN }), /requires trusted/);
  }
  assert.throws(() => instructionBridgeConfig({ ...deployed, EVIDENCE_SANDBOX_SNAPSHOT_ID: undefined }), /requires trusted/);
  assert.throws(() => instructionBridgeConfig({ ...deployed, APP_BASE_URL: undefined }), /trusted HTTPS/);
  assert.throws(() => instructionBridgeConfig({ ...deployed, INSTRUCTION_TOOL_ORIGIN: "http://localhost:3000" }), /Invalid trusted/);
  assert.throws(() => instructionBridgeConfig({ ...deployed, INSTRUCTION_TOOL_ORIGIN: "https://court.example.test/path" }), /Invalid trusted/);
});
