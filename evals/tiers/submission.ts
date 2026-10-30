import { gateway, generateText, stepCountIs, tool, type LanguageModel } from "ai";
import type { z } from "zod";
import type { CourtModel } from "../../src/court/models.ts";

export async function generateSubmission<T>(options: {
  model: CourtModel;
  prompt: string;
  schema: z.ZodType<T>;
  research: boolean;
  onStepFinish?: Parameters<typeof generateText>[0]["onStepFinish"];
}, model?: LanguageModel) {
  let output: T | undefined;
  const result = await generateText({
    model: model ?? gateway(options.model.id), providerOptions: options.model.providerOptions,
    prompt: options.prompt, maxOutputTokens: 10_000, maxRetries: 1, abortSignal: AbortSignal.timeout(180_000),
    tools: {
      ...(options.research ? {
        web_search: gateway.tools.parallelSearch({ mode: "advanced", maxResults: 5, maxCharsTotal: 12_000 }),
        web_fetch: gateway.tools.browserbaseFetch({ format: "markdown", allowRedirects: true }),
      } : {}),
      submit: tool({ description: "Registra el resultado estructurado y termina este turno.", inputSchema: options.schema,
        execute: async (value) => { output = value; return "Registrado."; } }),
    },
    toolChoice: "required",
    // Gateway can execute several searches inside a single provider step. Keep
    // fetch and submit visible from the start, or that step cannot file evidence.
    // Also avoid forcing web_search by name: OpenAI aliases it to a native tool.
    prepareStep: ({ stepNumber }) => options.research && stepNumber >= 7
      ? { toolChoice: { type: "tool", toolName: "submit" } } : {},
    stopWhen: [stepCountIs(options.research ? 9 : 3), () => output !== undefined],
    onStepFinish: options.onStepFinish,
  });
  if (output === undefined) throw new Error("No structured submission within the generation limit");
  return { output, result };
}
