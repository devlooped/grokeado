import { z } from "zod";
import type { RecordedEvent } from "../domain/court.ts";
import type { Operation } from "../instruction/source-store.ts";

export const CaseLogRecordSchema = z.object({ schemaVersion: z.literal(2), id: z.string().min(1), kind: z.enum(["court_event", "model_step", "source_operation"]), at: z.iso.datetime(), seat: z.string().optional(), phase: z.string().optional(), modelId: z.string().optional(), effort: z.string().nullable().optional(), data: z.record(z.string(), z.unknown()) }).strict();
export type CaseLogRecord = z.infer<typeof CaseLogRecordSchema>;

// Select provenance/usage/references, never source bodies or private checkpoints.
function operationResult(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key]) => /(?:Path|Hash)$/.test(key) || ["path", "hash", "url", "finalUrl", "sourceId", "modelId", "effort", "usage", "verificationUsage"].includes(key)));
}

export function buildCaseLog(events: readonly RecordedEvent[], audit: readonly unknown[], operations: readonly Operation[]): string {
  const records = new Map<string, CaseLogRecord>();
  const add = (input: unknown) => {
    const record = CaseLogRecordSchema.parse(input);
    const previous = records.get(record.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(record)) throw new Error("Conflicting public case-log record ID");
    records.set(record.id, record);
  };
  for (const event of events) add({ schemaVersion: 2, id: `court:${event.seq}`, kind: "court_event", at: event.at, data: event });
  for (const record of audit) add(record);
  for (const operation of operations) add({ schemaVersion: 2, id: `source:${operation.key}`, kind: "source_operation", at: operation.at, ...(operationResult(operation.result).modelId ? { modelId: operationResult(operation.result).modelId, effort: operationResult(operation.result).effort ?? null } : {}), data: { operation: operation.key, stage: operation.stage, status: operation.status, recoveries: operation.recoveries, artifacts: operationResult(operation.result) } });
  const groups = new Map<string, CaseLogRecord[]>();
  for (const record of records.values()) {
    const origin = record.kind === "court_event" ? "court" : record.kind === "model_step" ? `model:${record.seat}:${record.phase}:${String(record.data.channel)}:${String(record.data.sessionId)}` : `source:${String(record.data.operation)}`;
    if (!groups.has(origin)) groups.set(origin, []);
    groups.get(origin)!.push(record);
  }
  for (const group of groups.values()) group.sort((a, b) => a.kind === "court_event" && b.kind === "court_event" ? Number(a.data.seq) - Number(b.data.seq) : typeof a.data.sequence === "number" && typeof b.data.sequence === "number" ? a.data.sequence - b.data.sequence : compare(a, b));
  const output: CaseLogRecord[] = [];
  // Merge heads, preserving each authoritative origin's order even with clock skew.
  while (groups.size) {
    const first = [...groups].sort(([, a], [, b]) => compare(a[0]!, b[0]!))[0]!;
    output.push(first[1].shift()!);
    if (!first[1].length) groups.delete(first[0]);
  }
  return output.map((record) => JSON.stringify(record)).join("\n") + (output.length ? "\n" : "");
}

function compare(a: CaseLogRecord, b: CaseLogRecord) { return a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }

export function parseCaseLog(source: string): CaseLogRecord[] {
  const records = source.split(/\r?\n/).filter(Boolean).map((line) => CaseLogRecordSchema.parse(JSON.parse(line)));
  if (new Set(records.map((record) => record.id)).size !== records.length) throw new Error("Duplicate case-log records");
  return records;
}
