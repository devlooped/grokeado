import { unstable_cache } from "next/cache";
import { gatewayTokenPrices, PRICING_URL, type TokenPrices } from "../domain/cost.ts";

export async function fetchTokenPrices(request: typeof fetch = fetch): Promise<TokenPrices> {
  // The full catalog is larger than Next's fetch-cache entry limit. Cache only
  // the small, parsed Vercel price map, not the multi-provider response body.
  const response = await request(PRICING_URL, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("Token pricing unavailable");
  return gatewayTokenPrices(await response.json());
}

const cachedPrices = unstable_cache(() => fetchTokenPrices(), ["models-dev-vercel-token-prices-v1"], { revalidate: 3600 });

export async function loadTokenPrices(read = cachedPrices): Promise<TokenPrices> {
  try {
    return await read();
  } catch {
    // Pricing must never prevent viewing a case; the UI marks unpriced calls.
    return {};
  }
}
