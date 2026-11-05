import assert from "node:assert/strict";
import test from "node:test";
import { requestedPipeline } from "./rollout.ts";

test("new cases default to shared instruction in production and retain explicit legacy rollback", () => {
  const values = { COURT_PIPELINE_VERSION: "2", VERCEL_ENV: "production", INSTRUCTION_STAGING_CASE_ID: "fixture", INSTRUCTION_TOOL_ORIGIN: "https://court.example.test", APP_BASE_URL: "https://court.example.test", BLOB_READ_WRITE_TOKEN: "fixture-only", INSTRUCTION_SANDBOX_TEAM_ID: "team", INSTRUCTION_SANDBOX_PROJECT_ID: "project", INSTRUCTION_SANDBOX_SNAPSHOT_ID: "snapshot", EVIDENCE_AI_GATEWAY_API_KEY: "fixture-only", VERCEL_OIDC_TOKEN: "", EVIDENCE_SANDBOX_SNAPSHOT_ID: "" };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, values);
    assert.equal(requestedPipeline("fixture", false), 2);
    assert.equal(requestedPipeline("different-case", false), 2);
    delete process.env.COURT_PIPELINE_VERSION;
    assert.equal(requestedPipeline("different-case", false), 2);
    process.env.VERCEL_ENV = "preview";
    assert.equal(requestedPipeline("different-case", false), 2);
    for (const key of ["INSTRUCTION_SANDBOX_TEAM_ID", "INSTRUCTION_SANDBOX_PROJECT_ID", "INSTRUCTION_SANDBOX_SNAPSHOT_ID", "EVIDENCE_AI_GATEWAY_API_KEY"]) {
      delete process.env[key];
      assert.throws(() => requestedPipeline("fixture", false), /required|requires/);
      process.env[key] = values[key as keyof typeof values];
    }
    process.env.EVIDENCE_AI_GATEWAY_API_KEY = "placeholder";
    assert.throws(() => requestedPipeline("fixture", false), /required/);
    process.env.EVIDENCE_AI_GATEWAY_API_KEY = " ";
    assert.throws(() => requestedPipeline("fixture", false), /required/);
    process.env.COURT_PIPELINE_VERSION = "invalid";
    assert.throws(() => requestedPipeline("fixture", false), /must be 1 or 2/);
    process.env.COURT_PIPELINE_VERSION = "1";
    assert.equal(requestedPipeline("fixture", false), 1);
    delete process.env.COURT_PIPELINE_VERSION;
    for (const key of ["INSTRUCTION_TOOL_ORIGIN", "INSTRUCTION_SANDBOX_TEAM_ID", "INSTRUCTION_SANDBOX_PROJECT_ID", "INSTRUCTION_SANDBOX_SNAPSHOT_ID"]) delete process.env[key];
    process.env.EVIDENCE_AI_GATEWAY_API_KEY = values.EVIDENCE_AI_GATEWAY_API_KEY;
    process.env.EVIDENCE_SANDBOX_SNAPSHOT_ID = "existing-snapshot";
    process.env.VERCEL_OIDC_TOKEN = `fixture.${Buffer.from(JSON.stringify({ owner_id: "team", project_id: "project" })).toString("base64url")}.fixture`;
    assert.equal(requestedPipeline("production-case", false), 2, "normal deployment reuses existing configuration without instruction-specific variables");
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("mock shared instruction still requires the dedicated local database", () => {
  const previous = { COURT_PIPELINE_VERSION: process.env.COURT_PIPELINE_VERSION, DATABASE_URL: process.env.DATABASE_URL };
  try {
    delete process.env.COURT_PIPELINE_VERSION;
    delete process.env.DATABASE_URL;
    assert.throws(() => requestedPipeline("fixture", true), /Local database preflight/);
    process.env.DATABASE_URL = "postgresql://grokeado:fixture@remote.example.test:5432/grokeado_local_fixture";
    assert.throws(() => requestedPipeline("fixture", true), /Local database preflight/);
    process.env.DATABASE_URL = "postgresql://grokeado:fixture@127.0.0.1:5432/grokeado_local_fixture";
    assert.equal(requestedPipeline("fixture", true), 2);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
