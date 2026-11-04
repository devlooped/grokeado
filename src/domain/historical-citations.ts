import type { RecordedEvent } from "./court.ts";

// Translate only known unified-source references for display; stored events and
// original evidence remain untouched. Reserve existing E IDs to avoid collisions.
export function displayHistoricalCitations(events: readonly RecordedEvent[]): { events: RecordedEvent[]; aliases: Map<string, string> } {
  const sources = events.flatMap((e) => e.type === "evidence_unified" ? e.sources : []);
  const used = new Set(sources.map((source) => source.id));
  const renamed = new Map<string, string>();
  let next = 1;
  for (const { id } of sources) {
    if (!/^S[1-9]\d*$/.test(id) || renamed.has(id)) continue;
    let target = "E" + id.slice(1);
    if (used.has(target)) {
      while (used.has("E" + next)) next++;
      target = "E" + next++;
    }
    used.add(target);
    renamed.set(id, target);
  }
  const id = (value: string) => renamed.get(value) ?? value;
  // URLs and evidence paths are data, not references, even if a segment is S1.
  const text = (value: string) => value.replace(/https?:\/\/[^\s<>"']+|\/evidence\/[^\s<>"']+|\bS[1-9]\d*\b/g, (token) => id(token));
  const converted = events.map((e): RecordedEvent => {
    switch (e.type) {
      case "evidence_unified": return { ...e, sources: e.sources.map((source) => ({ ...source, id: id(source.id) })) };
      case "source_review_vote": return { ...e, sourceId: id(e.sourceId), reason: text(e.reason) };
      case "source_decided": return { ...e, sourceId: id(e.sourceId) };
      case "statement": return { ...e, text: text(e.text), evidenceIds: e.evidenceIds.map(id) };
      case "objection": return { ...e, grounds: text(e.grounds) };
      case "objection_reply": return { ...e, text: text(e.text) };
      case "ruling": return { ...e, reason: text(e.reason) };
      case "vote": return { ...e, rationale: text(e.rationale) };
      case "judgment": return { ...e, reasoning: text(e.reasoning) };
      case "content_vote": return { ...e, rationale: text(e.rationale) };
      case "content_judgment": return { ...e, reasoning: text(e.reasoning) };
      case "case_summary": return { ...e, text: text(e.text) };
      default: return e;
    }
  });
  return { events: converted, aliases: new Map([...renamed].map(([oldId, newId]) => [newId, oldId])) };
}
