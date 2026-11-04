import assert from "node:assert/strict";
import test from "node:test";
import { caseOutcome } from "./acta.ts";
import type { ClaimView, Verdict } from "./court.ts";

const claim = (id: string, verdict?: Verdict): ClaimView => ({
  id,
  quote: "",
  text: "Afirmación " + id,
  votes: {},
  ...(verdict ? { judgment: { verdict, method: "consensus" as const, reasoning: "" } } : {}),
});

test("the outcome is the shared verdict, mixed when claims differ, and absent before any judgment", () => {
  assert.equal(caseOutcome({ claims: [] }), undefined);
  assert.equal(caseOutcome({ claims: [claim("A1")] }), undefined);
  assert.equal(caseOutcome({ claims: [claim("A1", "falso"), claim("A2", "falso"), claim("A3")] }), "falso");
  assert.equal(caseOutcome({ claims: [claim("A1", "falso"), claim("A2", "verdadero")] }), "mixto");
});
