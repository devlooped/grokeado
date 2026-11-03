import type { RecordedEvent } from "../domain/court.ts";
import { MOCK_MODEL_ID } from "../court/models.ts";
import type { EvidenceFiles } from "./validate.ts";

function parseLine(line: string, path: string, index: number): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(line); } catch { throw new Error(`Invalid JSONL in ${path} at line ${index + 1}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid JSONL entry in ${path} at line ${index + 1}`);
  return value as Record<string, unknown>;
}

// Annotate at promotion, even when the sandbox snapshot uses an older harness.
export function annotateEvidenceTranscript(content: Uint8Array, modelId: string): string {
  const original = new TextDecoder("utf-8", { fatal: true }).decode(content);
  const lines = original.split(/\r?\n/).flatMap((line, index) => line.trim() ? [JSON.stringify({ ...parseLine(line, "sandbox transcript", index), modelId })] : []);
  return lines.length ? lines.join("\n") + "\n" : "";
}

// Rebuild from evidence steps and committed statements on each attempt.
export function buildCaseTranscript(files: EvidenceFiles, events: readonly RecordedEvent[]): { transcript: string; updatedRuns: Map<string, string> } {
  const session = events.find((event) => event.type === "session_opened");
  const models: Partial<Record<string, string>> = session?.counselModels ?? {};
  const statements = events.filter((event) => event.type === "statement").sort((a, b) => a.seq - b.seq).map((event) => ({
    ...event, modelId: event.modelId ?? (session?.simulated ? MOCK_MODEL_ID : models[event.by]) ?? null,
  }));
  const entries: Array<{ at: string; order: string; value: object }> = [];
  const updatedRuns = new Map<string, string>();
  const decoder = new TextDecoder("utf-8", { fatal: true });

  for (const [path, content] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const match = /^evidence\/(grok|gemini|claude|chatgpt)\/runs\/([^/]+)\/transcript\.jsonl$/.exec(path);
    if (!match) continue;
    const [, seat, runId] = match;
    const original = typeof content === "string" ? content : decoder.decode(content);
    const lines: string[] = [];
    for (const [index, line] of original.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      const record = parseLine(line, path, index);
      // Remove previously appended records before regenerating them.
      if (record.type === "statement" && record.evidenceRunId === runId) continue;
      const modelId = typeof record.modelId === "string" && record.modelId ? record.modelId : models[seat!] ?? null;
      const enriched = { ...record, modelId };
      lines.push(JSON.stringify(enriched));
      entries.push({ at: typeof record.at === "string" ? record.at : "", order: `${path}:${String(index).padStart(12, "0")}`, value: { ...enriched, type: "evidence_step", seat, runId } });
    }
    const ownStatements = statements.filter((event) => event.by === seat && event.evidenceRunId === runId);
    lines.push(...ownStatements.map((event) => JSON.stringify(event)));
    const updated = lines.length ? lines.join("\n") + "\n" : "";
    if (updated !== original) updatedRuns.set(path, updated);
  }
  for (const event of statements) entries.push({ at: event.at, order: `statement:${String(event.seq).padStart(12, "0")}`, value: event });
  entries.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.order < b.order ? -1 : a.order > b.order ? 1 : 0);
  return { transcript: entries.length ? entries.map(({ value }) => JSON.stringify(value)).join("\n") + "\n" : "", updatedRuns };
}
