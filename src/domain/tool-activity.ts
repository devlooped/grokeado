import { z } from "zod";
import { COUNSEL } from "./court.ts";

const publicUrl = z.string().url().refine((value) => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
});

// Only these public inputs cross into the timeline; results, prompts and traces do not.
export const ToolActivityDataSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("read_source"), url: publicUrl }),
  z.object({ tool: z.literal("read_evidence"), id: z.string().regex(/^E[1-9]\d*$/), url: publicUrl }),
  z.object({ tool: z.literal("web_search"), query: z.string().min(3).max(4000) }),
  z.object({ tool: z.literal("x_search"), query: z.string().min(3).max(4000) }),
]);

export const ToolActivitySchema = z.object({
  schemaVersion: z.literal(2), id: z.string().regex(/^tool:/), kind: z.literal("tool_call"),
  at: z.iso.datetime(), seat: z.enum(["judge", ...COUNSEL]),
  modelId: z.string().min(1).optional(), effort: z.string().nullable().optional(),
  data: ToolActivityDataSchema,
});
export type ToolActivity = z.infer<typeof ToolActivitySchema>;
export type ToolActivityData = z.infer<typeof ToolActivityDataSchema>;

export function publicToolActivities(records: readonly unknown[]): ToolActivity[] {
  return records.flatMap((record) => {
    const parsed = ToolActivitySchema.safeParse(record);
    return parsed.success ? [parsed.data] : [];
  });
}
