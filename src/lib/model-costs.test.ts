import assert from "node:assert/strict";
import test from "node:test";
import { fetchTokenPrices, loadTokenPrices } from "./model-costs.ts";
import { PRICING_URL } from "../domain/cost.ts";

test("pricing is fetched publicly from models.dev and failures leave costs unpriced", async () => {
  const request: typeof fetch = async (url, init) => {
    assert.equal(url, PRICING_URL);
    assert.equal(init?.cache, "no-store");
    assert.ok(init?.signal);
    assert.equal(init?.headers, undefined);
    return Response.json({ vercel: { models: { "openai/test": { cost: { input: 2, output: 10 } } } } });
  };
  assert.deepEqual(await fetchTokenPrices(request), { "openai/test": { input: 2, output: 10 } });
  for (const response of [new Response(null, { status: 503 }), Response.json({})]) assert.deepEqual(await loadTokenPrices(() => fetchTokenPrices(async () => response)), {});
  assert.deepEqual(await loadTokenPrices(async () => { throw new Error("offline"); }), {});
});
