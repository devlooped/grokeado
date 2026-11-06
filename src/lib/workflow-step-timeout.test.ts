import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { configureWorkflowStepTimeout } from "./workflow-step-timeout.ts";

test("workflow function duration defaults to 600 seconds and accepts an override", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "workflow-timeout-"));
  const file = path.join(dir, "config.json");
  const original = { version: "0", workflows: { maxDuration: "max", experimentalTriggers: [{ type: "queue/v2beta" }] } };
  try {
    await writeFile(file, JSON.stringify(original));
    await configureWorkflowStepTimeout(file, undefined);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { ...original, workflows: { ...original.workflows, maxDuration: 600 } });
    await configureWorkflowStepTimeout(file, "120");
    assert.equal(JSON.parse(await readFile(file, "utf8")).workflows.maxDuration, 120);
    for (const invalid of ["", "0", "-1", "1.5", "abc", "9007199254740992"]) {
      await assert.rejects(configureWorkflowStepTimeout(file, invalid), /positive whole number/);
      assert.equal(JSON.parse(await readFile(file, "utf8")).workflows.maxDuration, 120);
    }
    await writeFile(file, "{}");
    await assert.rejects(configureWorkflowStepTimeout(file, undefined), /Unexpected generated/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
