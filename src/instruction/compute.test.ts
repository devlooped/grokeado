import assert from "node:assert/strict";
import test from "node:test";
import { compute } from "../../sandbox/harness/compute.ts";

test("sandbox computation accepts bounded numeric data, never shell commands or file access", () => {
  assert.deepEqual(compute({ operation: "mean", values: [2, 4, 6] }), { value: 4 });
  assert.deepEqual(compute({ operation: "subtract", values: [10, 3, 2] }), { value: 5 });
  assert.deepEqual(compute({ operation: "divide", values: [12, 3, 2] }), { value: 2 });
  for (const input of [{ command: "cat /workspace/task.json" }, { operation: "add", values: [1], path: "/opt/evidence-harness/instruction-agent.ts" }, { operation: "add", values: ["process.env"] }, { operation: "add", values: Array(1001).fill(1) }, { operation: "add", values: [] }]) assert.deepEqual(compute(input), { error: "invalid_computation" });
  assert.deepEqual(compute({ operation: "divide", values: [1, 0] }), { error: "non_finite_result" });
  assert.deepEqual(compute({ operation: "multiply", values: [Number.MAX_VALUE, 2] }), { error: "non_finite_result" });
});
