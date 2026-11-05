import { readFile, writeFile } from "node:fs/promises";
import { createGateway, generateText, jsonSchema, stepCountIs, type ModelMessage, type ToolSet } from "ai";
import { compute } from "./compute.ts";

type Definition = { type: "function"; name: string; description: string; inputSchema: Parameters<typeof jsonSchema>[0] };
type Task = { caseId: string; callId: string; model: { id: string; providerOptions?: Parameters<typeof generateText>[0]["providerOptions"] }; system: string; messages: ModelMessage[]; tools: Definition[]; resultPath: string };
const task = JSON.parse(await readFile(process.argv[2]!, "utf8")) as Task;
const origin = process.env.COURT_TOOL_ORIGIN!;
if (!origin || !task.resultPath.startsWith("/workspace/")) throw new Error("invalid_task");

const tools: ToolSet = Object.fromEntries(task.tools.map((definition) => [definition.name, {
  description: definition.description,
  inputSchema: jsonSchema(definition.inputSchema),
  execute: async (input: unknown, options: { toolCallId: string }) => {
    if (definition.name === "compute") return compute(input);
    const response = await fetch(`${origin}/api/cases/${task.caseId}/turn-tools`, {
      method: "POST", redirect: "error", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: definition.name, input, callId: options.toolCallId }), signal: AbortSignal.timeout(120_000),
    });
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
const result = await generateText({ model: gateway(task.model.id), providerOptions: task.model.providerOptions,
  system: task.system, messages: task.messages, tools, maxOutputTokens: 4096,
  stopWhen: stepCountIs(1), maxRetries: 0, abortSignal: AbortSignal.timeout(150_000),
});
await writeFile(task.resultPath, JSON.stringify({ messages: result.responseMessages, text: result.text, usage: result.usage, finishReason: result.finishReason }), "utf8");
