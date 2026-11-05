import assert from "node:assert/strict";
import test from "node:test";
import { requestedPipeline } from "./rollout.ts";

test("new cases default to shared instruction in production and retain explicit legacy rollback", async () => {
  const values = { COURT_PIPELINE_VERSION: "2", VERCEL_ENV: "production", INSTRUCTION_STAGING_CASE_ID: "fixture", INSTRUCTION_TOOL_ORIGIN: "https://court.example.test", APP_BASE_URL: "https://court.example.test", BLOB_READ_WRITE_TOKEN: "fixture-only", INSTRUCTION_SANDBOX_TEAM_ID: "team", INSTRUCTION_SANDBOX_PROJECT_ID: "project", INSTRUCTION_SANDBOX_SNAPSHOT_ID: "snapshot", AI_GATEWAY_API_KEY: "fixture-only", VERCEL_OIDC_TOKEN: `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.fixture`, VERCEL_OIDC_TOKEN_FILE: "", EVIDENCE_SANDBOX_SNAPSHOT_ID: "" };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, values);
    assert.equal(await requestedPipeline("fixture", false), 2);
    assert.equal(await requestedPipeline("different-case", false), 2);
    delete process.env.COURT_PIPELINE_VERSION;
    assert.equal(await requestedPipeline("different-case", false), 2);
    process.env.VERCEL_ENV = "preview";
    assert.equal(await requestedPipeline("different-case", false), 2);
    for (const key of ["INSTRUCTION_SANDBOX_TEAM_ID", "INSTRUCTION_SANDBOX_PROJECT_ID", "INSTRUCTION_SANDBOX_SNAPSHOT_ID", "AI_GATEWAY_API_KEY"]) {
      delete process.env[key];
      await assert.rejects(requestedPipeline("fixture", false), /required|requires/);
      process.env[key] = values[key as keyof typeof values];
    }
    process.env.AI_GATEWAY_API_KEY = "placeholder";
    await assert.rejects(requestedPipeline("fixture", false), /required/);
    process.env.AI_GATEWAY_API_KEY = " ";
    await assert.rejects(requestedPipeline("fixture", false), /required/);
    process.env.COURT_PIPELINE_VERSION = "invalid";
    await assert.rejects(requestedPipeline("fixture", false), /must be 1 or 2/);
    process.env.COURT_PIPELINE_VERSION = "1";
    assert.equal(await requestedPipeline("fixture", false), 1);
    delete process.env.COURT_PIPELINE_VERSION;
    for (const key of ["INSTRUCTION_TOOL_ORIGIN", "INSTRUCTION_SANDBOX_TEAM_ID", "INSTRUCTION_SANDBOX_PROJECT_ID", "INSTRUCTION_SANDBOX_SNAPSHOT_ID"]) delete process.env[key];
    process.env.AI_GATEWAY_API_KEY = values.AI_GATEWAY_API_KEY;
    process.env.EVIDENCE_SANDBOX_SNAPSHOT_ID = "existing-snapshot";
    process.env.VERCEL_OIDC_TOKEN = `fixture.${Buffer.from(JSON.stringify({ owner_id: "team", project_id: "project", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.fixture`;
    assert.equal(await requestedPipeline("production-case", false), 2, "normal deployment reuses existing configuration without instruction-specific variables");
    const contextKey = Symbol.for("@vercel/request-context");
    const global = globalThis as typeof globalThis & { [key: symbol]: unknown };
    const previousContext = global[contextKey];
    try {
      const contextToken = process.env.VERCEL_OIDC_TOKEN;
      global[contextKey] = { get: () => ({ headers: { "x-vercel-oidc-token": contextToken } }) };
      delete process.env.VERCEL_OIDC_TOKEN;
      assert.equal(await requestedPipeline("production-case", false), 2, "production identity comes from the Vercel function context");
      delete process.env.AI_GATEWAY_API_KEY;
      await assert.rejects(requestedPipeline("production-case", false), /authenticated sandbox bridge are required/, "the gateway key is still required");
    } finally { if (previousContext === undefined) delete global[contextKey]; else global[contextKey] = previousContext; }
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("mock shared instruction still requires the dedicated local database", async () => {
  const previous = { COURT_PIPELINE_VERSION: process.env.COURT_PIPELINE_VERSION, DATABASE_URL: process.env.DATABASE_URL };
  try {
    delete process.env.COURT_PIPELINE_VERSION;
    delete process.env.DATABASE_URL;
    await assert.rejects(requestedPipeline("fixture", true), /Local database preflight/);
    process.env.DATABASE_URL = "postgresql://grokeado:fixture@remote.example.test:5432/grokeado_local_fixture";
    await assert.rejects(requestedPipeline("fixture", true), /Local database preflight/);
    process.env.DATABASE_URL = "postgresql://grokeado:fixture@127.0.0.1:5432/grokeado_local_fixture";
    assert.equal(await requestedPipeline("fixture", true), 2);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
