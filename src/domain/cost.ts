import { z } from "zod";
import type { UsageCall } from "./usage.ts";

const rate = z.number().finite().nonnegative();
const rates = z.object({ input: rate.optional(), output: rate.optional(), cache_read: rate.optional(), cache_write: rate.optional() });
const price = rates.extend({ tiers: z.array(rates.extend({ tier: z.object({ type: z.string(), size: rate }) })).optional(), context_over_200k: rates.optional() });
export type TokenPrice = z.infer<typeof price>;
export type TokenPrices = Record<string, TokenPrice>;
export const PRICING_URL = "https://models.dev/api.json";

export function gatewayTokenPrices(catalog: unknown): TokenPrices {
  const parsed = z.object({ vercel: z.object({ models: z.record(z.string(), z.unknown()) }) }).parse(catalog);
  const prices: TokenPrices = {};
  for (const [id, model] of Object.entries(parsed.vercel.models)) {
    const parsedModel = z.object({ cost: price }).safeParse(model);
    if (parsedModel.success) prices[id] = parsedModel.data.cost;
  }
  return prices;
}

export interface TokenCost { input: number; output: number; total: number }

// Apply context tiers per call, NOT to the case's accumulated input. Reasoning
// is already included in outputTokens. Cached tokens are already part of input.
export function tokenCost(call: UsageCall, prices: TokenPrices): TokenCost | null {
  if (call.inputTokens === null || call.outputTokens === null) return null;
  const price = prices[call.model];
  if (!price) return null;
  const tier = price.tiers?.filter((tier) => tier.tier.type === "context" && call.inputTokens! >= tier.tier.size).sort((a, b) => b.tier.size - a.tier.size)[0];
  const selected = { ...price, ...(tier ?? (!price.tiers?.length && call.inputTokens > 200_000 ? price.context_over_200k : undefined)) };
  if (selected.input === undefined || selected.output === undefined) return null;
  const read = call.cacheReadTokens, write = call.cacheWriteTokens;
  if (read + write > call.inputTokens) return null;
  const input = ((call.inputTokens - read - write) * selected.input + read * (selected.cache_read ?? selected.input) + write * (selected.cache_write ?? selected.input)) / 1_000_000;
  const output = call.outputTokens * selected.output / 1_000_000;
  return { input, output, total: input + output };
}

export type CostPivot = "provider" | "model" | "role";
export interface CostRow {
  label: string;
  inputTokens: number | null;
  outputTokens: number | null;
  inputCost: number;
  outputCost: number;
  total: number;
  unpricedCalls: number;
  pricedCalls: number;
}
export interface CaseCosts { rows: Record<CostPivot, CostRow[]>; total: number; unpricedCalls: number; calls: number }

export function caseCosts(calls: readonly UsageCall[], prices: TokenPrices): CaseCosts {
  const result: CaseCosts = { rows: { provider: [], model: [], role: [] }, total: 0, unpricedCalls: 0, calls: calls.length };
  for (const pivot of ["provider", "model", "role"] as const) {
    const groups = new Map<string, CostRow>();
    for (const call of calls) {
      const label = call[pivot];
      const row = groups.get(label) ?? { label, inputTokens: 0, outputTokens: 0, inputCost: 0, outputCost: 0, total: 0, unpricedCalls: 0, pricedCalls: 0 };
      const cost = tokenCost(call, prices);
      row.inputTokens = row.inputTokens === null || call.inputTokens === null ? null : row.inputTokens + call.inputTokens;
      row.outputTokens = row.outputTokens === null || call.outputTokens === null ? null : row.outputTokens + call.outputTokens;
      if (cost) { row.inputCost += cost.input; row.outputCost += cost.output; row.total += cost.total; row.pricedCalls++; }
      else row.unpricedCalls++;
      groups.set(label, row);
    }
    result.rows[pivot] = [...groups.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
  }
  result.total = result.rows.provider.reduce((total, row) => total + row.total, 0);
  result.unpricedCalls = result.rows.provider.reduce((total, row) => total + row.unpricedCalls, 0);
  return result;
}
