// Pipeline 3 research runs on the provider's side, within one model call: the
// sandbox VM never fetches anything. AI SDK 7 serializes these tools as
// { type: "provider", id, name, args } and the Gateway routes them by model.
// They are plain objects, so the harness needs no provider package; the broker
// accepts exactly these definitions (see gateway-validation.ts).
export type ProviderToolDefinition = { type: "provider"; id: `${string}.${string}`; name: string; args: Record<string, unknown> };
export type NativeResearchPhase = "instruction" | "criticism";

const tool = (id: `${string}.${string}`, name: string, args: Record<string, unknown> = {}): ProviderToolDefinition => ({ type: "provider", id, name, args });

// Searches a provider may run in one call: research needs more than a review.
const MAX_USES: Record<NativeResearchPhase, number> = { instruction: 10, criticism: 5 };

const PROVIDER_TOOLS: Record<string, (phase: NativeResearchPhase) => ProviderToolDefinition[]> = {
  xai: () => [tool("xai.web_search", "web_search"), tool("xai.x_search", "x_search")],
  openai: () => [tool("openai.web_search", "web_search")],
  anthropic: (phase) => [
    tool("anthropic.web_search_20250305", "web_search", { maxUses: MAX_USES[phase] }),
    tool("anthropic.web_fetch_20250910", "web_fetch", { maxUses: MAX_USES[phase] }),
  ],
  google: () => [tool("google.google_search", "google_search"), tool("google.url_context", "url_context")],
};

// Gateway-executed search, for a model of any other provider an admin picks.
const FALLBACK = () => [tool("gateway.parallel_search", "web_search", { mode: "advanced", maxResults: 10 })];

// The provider of a Gateway model id, as its tools name it.
export function nativeProvider(modelId: string): string | undefined {
  const prefix = modelId.slice(0, modelId.indexOf("/"));
  const provider = prefix === "spacexai" ? "xai" : prefix;
  return Object.hasOwn(PROVIDER_TOOLS, provider) ? provider : undefined;
}

// A native research call outlasts an ordinary one; the broker function allows 300 s.
export const NATIVE_GENERATION_MS = 285_000;

export function hasNativeTools(definitions: readonly unknown[]): boolean {
  return definitions.some((definition) => (definition as { type?: unknown } | null)?.type === "provider");
}

// What a provider cited in a Gateway generation result, and the searches it ran
// on its side. For the audit only: admitted evidence is what the host fetched.
export function nativeCitations(result: unknown): { sources: Array<{ url: string; title?: string }>; searches: number } {
  const content = (result as { content?: unknown } | null)?.content;
  const parts = Array.isArray(content) ? content as Array<Record<string, unknown>> : [];
  const sources = parts.flatMap((part) => part.type === "source" && part.sourceType === "url" && typeof part.url === "string"
    ? [{ url: part.url, ...(typeof part.title === "string" && part.title ? { title: part.title } : {}) }] : []);
  const searches = parts.filter((part) => part.type === "tool-call" && part.providerExecuted === true).length;
  return { sources, searches };
}

export function nativeResearchTools(modelId: string, phase: NativeResearchPhase): ProviderToolDefinition[] {
  const provider = nativeProvider(modelId);
  return provider ? PROVIDER_TOOLS[provider]!(phase) : FALLBACK();
}
