import assert from "node:assert/strict";
import { test } from "node:test";
import { VERDICTS, type CourtEvent } from "../domain/court.ts";
import { toAiTools } from "./toolset.ts";
import { planTurn } from "./turns.ts";

const submission = { kind: "text" as const, text: "Una afirmación." };
const record: CourtEvent[] = [{ type: "claims_entered", claims: [{ id: "A1", quote: "Una afirmación", text: "Una afirmación." }] }];

test("the analyst and moderator tools accept and record all four verdicts", async () => {
  for (const verdict of VERDICTS) {
    const closing = planTurn({ kind: "closing", counsel: "grok" }, record, submission);
    const vote = { votes: [{ claimId: "A1", verdict, rationale: "Según la evidencia del registro." }] };
    await toAiTools(closing.tools).cast_votes.execute(closing.tools.cast_votes.schema.parse(vote));
    assert.ok(closing.produced.some((e) => e.type === "vote" && e.verdict === verdict));

    const tiebreak = planTurn({ kind: "tiebreak" }, record, submission);
    const decision = { decisions: [{ claimId: "A1", verdict, reasoning: "La evidencia del registro permite decidir." }] };
    await toAiTools(tiebreak.tools).decide.execute(tiebreak.tools.decide.schema.parse(decision));
    assert.ok(tiebreak.produced.some((e) => e.type === "judgment" && e.verdict === verdict));
    for (const tool of [closing.tools.cast_votes, tiebreak.tools.decide]) {
      assert.ok(tool.description.includes("no_verificable (Insostenible)"));
      assert.ok(tool.description.includes("enganoso (Engañoso)"));
    }
  }

  const closing = planTurn({ kind: "closing", counsel: "grok" }, record, submission);
  assert.equal(closing.tools.cast_votes.schema.safeParse({ votes: [{ claimId: "A1", verdict: "otro", rationale: "Según la evidencia del registro." }] }).success, false);
});
