import assert from "node:assert/strict";
import test from "node:test";
import { caseCosts, gatewayTokenPrices, tokenCost } from "./cost.ts";
import type { UsageCall } from "./usage.ts";

const call: UsageCall = { provider: "openai", model: "openai/test", effort: "high", role: "analyst", inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 200_000, cacheWriteTokens: 100_000 };
const prices = { "openai/test": { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 } };

test("use only models.dev's Vercel Gateway prices with exact model IDs and preserve free rates", () => {
  assert.deepEqual(gatewayTokenPrices({ openai: { models: { "openai/test": { cost: { input: 999, output: 999 } } } }, vercel: { models: {
    "openai/test": { cost: prices["openai/test"] }, "test/free": { cost: { input: 0, output: 0 } }, "test/image": {}, "test/invalid": { cost: { input: -1 } },
  } } }), { ...prices, "test/free": { input: 0, output: 0 } });
  assert.throws(() => gatewayTokenPrices({}));
});

test("cost includes cached reads/writes once, and output totals already include reasoning", () => {
  assert.deepEqual(tokenCost(call, prices), { input: 1.67, output: 1, total: 2.67 });
  assert.deepEqual(tokenCost({ ...call, cacheReadTokens: 0, cacheWriteTokens: 0 }, prices), { input: 2, output: 1, total: 3 });
  assert.deepEqual(tokenCost(call, { "openai/test": { input: 0, output: 0 } }), { input: 0, output: 0, total: 0 });
});

test("apply the highest matching context tier to each individual call, not the case total", () => {
  const tiered = { "openai/test": { input: 1, output: 2, tiers: [{ tier: { type: "context", size: 200001 }, input: 2, output: 4 }, { tier: { type: "context", size: 500001 }, input: 3, output: 6 }] } };
  const small = { ...call, inputTokens: 200000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  assert.equal(tokenCost(small, tiered)!.total, 0.2);
  assert.equal(tokenCost({ ...small, inputTokens: 200001 }, tiered)!.total, 0.400002);
  assert.equal(tokenCost({ ...small, inputTokens: 600000 }, tiered)!.total, 1.8);
  assert.equal(caseCosts([small, small], tiered).total, 0.4);
});

test("all three pivots have the same total, with unknown usage and missing image pricing explicit", () => {
  const calls: UsageCall[] = [call, { ...call, role: "moderator" }, { ...call, provider: "spacexai", model: "spacexai/image", role: "imagine", inputTokens: null, outputTokens: null }];
  const costs = caseCosts(calls, prices);
  assert.equal(costs.total, 5.34);
  assert.equal(costs.unpricedCalls, 1);
  assert.equal(costs.rows.role.find((row) => row.label === "imagine")!.inputTokens, null);
  for (const rows of Object.values(costs.rows)) assert.equal(rows.reduce((sum, row) => sum + row.total, 0), costs.total);
  assert.equal(tokenCost(call, {}), null);
  assert.equal(tokenCost({ ...call, inputTokens: null }, prices), null);
  assert.equal(tokenCost({ ...call, cacheReadTokens: 2_000_000 }, prices), null);
  assert.equal(caseCosts([], {}).calls, 0);
});
