import assert from "node:assert/strict";
import test from "node:test";
import { parseCatalog } from "./gateway-catalog.ts";

test("parseCatalog keeps id, name, type, tags and effort values, sorted by id", () => {
  const models = parseCatalog({ data: [
    { id: "spacexai/grok-4.7", name: "Grok 4.7", type: "language", tags: ["tool-use", 1], reasoning_options: [{ type: "effort", values: ["none", "low", "high"] }] },
    { id: "google/gemini-3.5-flash-lite", type: "language" },
    { name: "no id" },
  ] });
  assert.deepEqual(models, [
    { id: "google/gemini-3.5-flash-lite", name: "google/gemini-3.5-flash-lite", type: "language", tags: [], efforts: [] },
    { id: "spacexai/grok-4.7", name: "Grok 4.7", type: "language", tags: ["tool-use"], efforts: ["low", "high"], supportsNoReasoning: true },
  ]);
  assert.throws(() => parseCatalog({ models: [] }), /formato/);
});
