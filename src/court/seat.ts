import { Agent, type ModelSelection, type SDKCustomTool, type SDKImage, type ToolName } from "@cursor/sdk";
import { mkdirSync } from "node:fs";
import { z } from "zod";

export class Rejection extends Error {}

export interface Tool<T> {
  description: string;
  schema: z.ZodType<T>;
  handle(input: T): string;
}

export type Toolset = Record<string, Tool<never>>;

export function tool<T>(description: string, schema: z.ZodType<T>, handle: (input: T) => string): Tool<never> {
  return { description, schema, handle } as unknown as Tool<never>;
}

export interface Seat {
  send(prompt: string, tools: Toolset, images?: SDKImage[]): Promise<void>;
  dispose(): Promise<void>;
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export function toSdkTools(tools: Toolset): Record<string, SDKCustomTool> {
  return Object.fromEntries(
    Object.entries(tools).map(([name, t]) => {
      const schema = t.schema as z.ZodType;
      const sdkTool: SDKCustomTool = {
        description: t.description,
        inputSchema: z.toJSONSchema(schema) as SDKCustomTool["inputSchema"],
        execute: (args) => {
          const parsed = schema.safeParse(args);
          if (!parsed.success) return errorResult("Argumentos inválidos:\n" + z.prettifyError(parsed.error));
          try {
            return (t.handle as (input: unknown) => string)(parsed.data);
          } catch (err) {
            if (err instanceof Rejection) return errorResult(err.message);
            throw err;
          }
        },
      };
      return [name, sdkTool];
    })
  );
}

export async function openSdkSeat(options: {
  name: string;
  model: ModelSelection;
  cwd: string;
  builtinTools: ToolName[];
  extraTools?: Record<string, SDKCustomTool>;
}): Promise<Seat> {
  mkdirSync(options.cwd, { recursive: true });
  const agent = await Agent.create({
    name: options.name,
    model: options.model,
    tools: [...options.builtinTools, "mcp"],
    local: { cwd: options.cwd, settingSources: [] },
  });
  return {
    async send(prompt, tools, images) {
      const run = await agent.send({ text: prompt, images }, { local: { customTools: { ...options.extraTools, ...toSdkTools(tools) } } });
      const result = await run.wait();
      if (result.status === "error") throw new Error(options.name + " run " + run.id + " failed");
    },
    dispose: () => agent[Symbol.asyncDispose](),
  };
}
