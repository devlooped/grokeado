import { readFile, writeFile } from "node:fs/promises";
import { createGateway, generateText, jsonSchema, stepCountIs, type ModelMessage, type ToolSet } from "ai";
import { compute } from "./compute.ts";

type Definition = { type: "function"; name: string; description: string; inputSchema: Parameters<typeof jsonSchema>[0] };
type Task = { caseId: string; callId: string; model: { id: string; providerOptions?: Parameters<typeof generateText>[0]["providerOptions"] }; system: string; messages: ModelMessage[]; tools: Definition[]; toolChoice?: "auto" | "none"; timeoutMs?: number; resultPath: string };
const task = JSON.parse(await readFile(process.argv[2]!, "utf8")) as Task;
const origin = process.env.COURT_TOOL_ORIGIN!;
if (!origin || !task.resultPath.startsWith("/workspace/")) throw new Error("invalid_task");
const timeoutMs = task.timeoutMs ?? 150_000;
const deadline = AbortSignal.timeout(timeoutMs);
// Tools stop before the call's deadline: an unfinished tool returns an error to
// the model and the call ends normally, its other results kept for synthesis.
const toolDeadline = AbortSignal.timeout(Math.max(1, timeoutMs - 10_000));

const tools: ToolSet = Object.fromEntries(task.tools.map((definition) => [definition.name, {
  description: definition.description,
  inputSchema: jsonSchema(definition.inputSchema),
  execute: async (input: unknown, options: { toolCallId: string; abortSignal?: AbortSignal }) => {
    if (definition.name === "compute") return compute(input);
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
}]));
// The broker adds SDK OIDC to the exact forwarded path. No credential is in the VM.
const gateway = createGateway({ baseURL: "https://ai-gateway.vercel.sh/v4/ai", apiKey: "placeholder", fetch: (url, init) => {
  const headers = new Headers(init?.headers);
  headers.set("x-court-call-id", task.callId);
  return fetch(url, { ...init, headers });
} });
try {
  const result = await generateText({ model: gateway(task.model.id), providerOptions: task.model.providerOptions,
    system: task.system, messages: task.messages, tools, toolChoice: task.toolChoice ?? "auto", maxOutputTokens: 4096,
    stopWhen: stepCountIs(1), maxRetries: 0, abortSignal: deadline,
  });
  await writeFile(task.resultPath, JSON.stringify({ messages: result.responseMessages, text: result.text, usage: result.usage, finishReason: result.finishReason }), "utf8");
} catch (error) {
  // A model call that outlasts its time is reported, not crashed: the host
  // decides whether the turn can still synthesize.
  if (!deadline.aborted) throw error;
  await writeFile(task.resultPath, JSON.stringify({ messages: [], text: "", finishReason: "timeout" }), "utf8");
}
