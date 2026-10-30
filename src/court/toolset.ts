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

export function toAiTools(tools: Toolset) {
  return Object.fromEntries(Object.entries(tools).map(([name, t]) => [name, {
    description: t.description,
    inputSchema: t.schema as z.ZodType,
    execute: async (args: unknown) => {
      try {
        return (t.handle as (input: unknown) => string)(args);
      } catch (err) {
        // A rejected court action is feedback for the model to correct, not a failed step.
        if (err instanceof Rejection) return { error: err.message };
        throw err;
      }
    },
  }]));
}
