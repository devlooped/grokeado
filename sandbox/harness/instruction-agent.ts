import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createGateway, generateText, jsonSchema, stepCountIs, type ModelMessage, type ToolSet } from "ai";
import { compute } from "./compute.ts";

type FunctionDefinition = { type: "function"; name: string; description: string; inputSchema: Parameters<typeof jsonSchema>[0] };
// Native research tools run on the provider's side within the call (pipeline 3).
type ProviderDefinition = { type: "provider"; id: `${string}.${string}`; name: string; args: Record<string, unknown> };
export type Definition = FunctionDefinition | ProviderDefinition;
export type Task = { caseId: string; callId: string; model: { id: string; providerOptions?: Parameters<typeof generateText>[0]["providerOptions"] }; system: string; messages: ModelMessage[]; tools: Definition[]; toolChoice?: "auto" | "none"; timeoutMs?: number; maxOutputTokens?: number; resultPath: string };
export type CallResult = {
  messages: ModelMessage[]; text: string; usage?: unknown; finishReason: string;
  // What the provider cited, and how many searches it ran on its side.
  sources?: Array<{ url: string; title?: string }>; searches?: number; providerMetadata?: unknown;
};
// local: a call in the host's own process (the research eval), with the host's
// Gateway credential instead of the broker.
type CallOptions = { origin?: string; local?: boolean };

export function toolSet(task: Task, origin: string | undefined, toolDeadline: AbortSignal): ToolSet {
  return Object.fromEntries(task.tools.map((definition) => {
    // A provider-executed tool's input is the provider's own; any object passes.
    if (definition.type === "provider") return [definition.name, { type: "provider", id: definition.id, args: definition.args, isProviderExecuted: true, inputSchema: jsonSchema({ type: "object" }) }];
    return [definition.name, {
      description: definition.description,
      inputSchema: jsonSchema(definition.inputSchema),
      execute: async (input: unknown, options: { toolCallId: string; abortSignal?: AbortSignal }) => {
        if (definition.name === "compute") return compute(input);
        if (!origin) throw new Error("host_tool_unavailable");
        const signals = [toolDeadline, AbortSignal.timeout(120_000), ...(options.abortSignal ? [options.abortSignal] : [])];
        let response: Response;
        try {
          response = await fetch(`${origin}/api/cases/${task.caseId}/turn-tools`, {
            method: "POST", redirect: "error", headers: { "content-type": "application/json" },
            body: JSON.stringify({ tool: definition.name, input, callId: options.toolCallId }), signal: AbortSignal.any(signals),
          });
        } catch (error) {
          if (toolDeadline.aborted) throw new Error("tool_time_exhausted: this preparation step ran out of time before the tool finished");
          throw error;
        }
        if (!response.ok) throw new Error("host_tool_unavailable");
        return response.json();
      },
    }];
  })) as ToolSet;
}

// One model call. Used by the VM entry point below, and in process by the
// research eval (with the host's own Gateway credential and fetch).
export async function runCall(task: Task, options: CallOptions = {}): Promise<CallResult> {
  const timeoutMs = task.timeoutMs ?? 150_000;
  const deadline = AbortSignal.timeout(timeoutMs);
  // Tools stop before the call's deadline: an unfinished tool returns an error to
  // the model and the call ends normally, its other results kept for synthesis.
  const toolDeadline = AbortSignal.timeout(Math.max(1, timeoutMs - 10_000));
  // In the VM, the broker adds SDK OIDC to the exact forwarded path. No credential is in the VM.
  const gateway = options.local ? createGateway() : createGateway({ baseURL: "https://ai-gateway.vercel.sh/v4/ai", apiKey: "placeholder", fetch: (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set("x-court-call-id", task.callId);
    return fetch(url, { ...init, headers });
  } });
  try {
    const result = await generateText({ model: gateway(task.model.id), providerOptions: task.model.providerOptions,
      system: task.system, messages: task.messages, tools: toolSet(task, options.origin, toolDeadline), toolChoice: task.toolChoice ?? "auto", maxOutputTokens: task.maxOutputTokens ?? 4096,
      stopWhen: stepCountIs(1), maxRetries: 0, abortSignal: deadline,
    });
    const sources = result.sources.flatMap((source) => source.sourceType === "url" ? [{ url: source.url, ...(source.title ? { title: source.title } : {}) }] : []);
    const searches = result.content.filter((part) => part.type === "tool-call" && part.providerExecuted).length;
    return { messages: result.responseMessages, text: result.text, usage: result.usage, finishReason: result.finishReason,
      ...(task.tools.some((definition) => definition.type === "provider") ? { sources, searches, providerMetadata: result.providerMetadata } : {}) };
  } catch (error) {
    // A model call that outlasts its time is reported, not crashed: the host
    // decides whether the turn can still synthesize.
    if (!deadline.aborted) throw error;
    return { messages: [], text: "", finishReason: "timeout" };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const task = JSON.parse(await readFile(process.argv[2]!, "utf8")) as Task;
  const origin = process.env.COURT_TOOL_ORIGIN!;
  if (!origin || !task.resultPath.startsWith("/workspace/")) throw new Error("invalid_task");
  await writeFile(task.resultPath, JSON.stringify(await runCall(task, { origin })), "utf8");
}
