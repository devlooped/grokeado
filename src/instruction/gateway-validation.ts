import type { SandboxBinding } from "./authorization.ts";

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

function inspectPrompt(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(inspectPrompt); return; }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (["file", "image", "reasoning-file", "url"].includes(String(record.type))) throw new Error("external_model_content_forbidden");
  for (const [key, child] of Object.entries(record)) {
    if (key === "providerOptions" && child && typeof child === "object") {
      const options = child as Record<string, unknown>;
      for (const [provider, settings] of Object.entries(options)) {
        if (!["anthropic", "google", "openai", "xai"].includes(provider) || !settings || typeof settings !== "object") throw new Error("message_options_forbidden");
        for (const option of Object.keys(settings)) if (!["cacheControl", "signature", "redactedData", "thoughtSignature", "reasoningEncryptedContent", "itemId"].includes(option)) throw new Error("message_options_forbidden");
      }
    } else inspectPrompt(child);
  }
}

export function validateGatewayGeneration(request: Request, body: unknown, binding: SandboxBinding): asserts body is Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid_generation");
  const record = body as Record<string, unknown>;
  const keys = new Set(["prompt", "tools", "toolChoice", "providerOptions", "maxOutputTokens"]);
  if (Object.keys(record).some((key) => !keys.has(key)) || !Array.isArray(record.prompt) || record.maxOutputTokens !== 4096 ||
      request.headers.get("ai-language-model-id") !== binding.model.id || request.headers.get("ai-language-model-specification-version") !== "4" ||
      request.headers.get("ai-language-model-streaming") !== "false" ||
      stableJson(record.providerOptions ?? {}) !== stableJson(binding.model.providerOptions ?? {}) ||
      stableJson(record.tools ?? []) !== stableJson(binding.gatewayTools)) throw new Error("generation_snapshot_mismatch");
  const tools = record.tools as Array<Record<string, unknown>> | undefined;
  if (tools?.some((tool) => tool.type !== "function")) throw new Error("native_tools_forbidden");
  if (record.toolChoice !== undefined) {
    const choice = record.toolChoice as Record<string, unknown>;
    if (!choice || typeof choice !== "object" || Object.keys(choice).some((key) => !["type", "toolName"].includes(key)) ||
        !["auto", "none", "required", "tool"].includes(String(choice.type)) ||
        (choice.type === "tool" && !tools?.some((tool) => tool.name === choice.toolName))) throw new Error("tool_choice_forbidden");
  }
  inspectPrompt(record.prompt);
}
