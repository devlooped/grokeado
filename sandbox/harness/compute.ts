import { z } from "zod";

// Deliberately data-only: no shell, evaluator, filesystem, or network capability.
export const ComputeSchema = z.object({
  operation: z.enum(["add", "subtract", "multiply", "divide", "mean", "min", "max"]),
  values: z.array(z.number()).min(1).max(1000),
}).strict();

export function compute(input: unknown): { value: number } | { error: string } {
  const parsed = ComputeSchema.safeParse(input);
  if (!parsed.success) return { error: "invalid_computation" };
  const { operation, values } = parsed.data;
  let value: number;
  switch (operation) {
    case "add": value = values.reduce((a, b) => a + b, 0); break;
    case "subtract": value = values.slice(1).reduce((a, b) => a - b, values[0]!); break;
    case "multiply": value = values.reduce((a, b) => a * b, 1); break;
    case "divide": value = values.slice(1).reduce((a, b) => a / b, values[0]!); break;
    case "mean": value = values.reduce((a, b) => a + b / values.length, 0); break;
    case "min": value = Math.min(...values); break;
    case "max": value = Math.max(...values); break;
  }
  return Number.isFinite(value) ? { value } : { error: "non_finite_result" };
}
