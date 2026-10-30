import assert from "node:assert/strict";
import test from "node:test";
import { evidenceSandboxLaunch, evidenceTaskDocument } from "./broker.ts";

test("puts the dedicated gateway key only in the egress header", () => {
  const key = "sk-evidence-dedicated";
  const launch = evidenceSandboxLaunch(key, "sk-project-main");
  assert.equal(launch.env.AI_GATEWAY_API_KEY, "placeholder");
  assert.equal(JSON.stringify(launch.env).includes(key), false);
  assert.equal(launch.networkPolicy.allow["ai-gateway.vercel.sh"][0]?.transform[0]?.headers.Authorization, `Bearer ${key}`);
  assert.deepEqual(launch.networkPolicy.allow["*"], []);
  assert.throws(() => evidenceSandboxLaunch("placeholder"), /dedicated AI Gateway key/);
  assert.throws(() => evidenceSandboxLaunch("sk-project-main", "sk-project-main"), /dedicated AI Gateway key/);
  assert.throws(() => evidenceSandboxLaunch("  "), /dedicated AI Gateway key/);
});

test("copies the task document so the caller cannot mutate the sandbox input", () => {
  const paths = ["evidence/grok/old.md"];
  const task = evidenceTaskDocument({
    caseId: "case-1",
    runId: "run-1",
    model: "spacexai/grok-4.7",
    seat: "grok",
    stage: "exposicion",
    task: "Leé el raw.",
    deadlineAt: "2026-10-30T12:03:00.000Z",
    maxSteps: 8,
    baseHashes: { "evidence/base/raw/a.pdf": "abc" },
    readOnlyHashes: { "evidence/base/raw/a.pdf": "abc" },
    existingSeatPaths: paths,
  });
  paths.push("evidence/grok/extra.md");
  assert.deepEqual(task.existingSeatPaths, ["evidence/grok/old.md"]);
});
