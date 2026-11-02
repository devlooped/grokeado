import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CaseRecord } from "../domain/court.ts";
import { Suspended } from "./suspended.tsx";

const failedCase: CaseRecord = {
  id: "failed-case",
  createdAt: "2026-10-31T00:00:00Z",
  status: "failed",
  submission: { kind: "text", text: "Una afirmación" },
  error: "Se interrumpió la sesión.",
};

test("the failed-case page offers retries only when authorized", () => {
  const allowed = renderToStaticMarkup(createElement(Suspended, { c: failedCase, user: { sub: "daniel", email: "Daniel@Cazzulino.com", email_verified: true } }));
  assert.match(allowed, /<form/);
  assert.match(allowed, /Reintentar/);
  assert.match(allowed, /Podés volver a intentarlo/);

  for (const user of [
    undefined,
    { sub: "someone", email: "other@example.com", email_verified: true },
    { sub: "someone", email: "daniel@cazzulino.com", email_verified: false },
    { email: "daniel@cazzulino.com", email_verified: true },
  ]) {
    const denied = renderToStaticMarkup(createElement(Suspended, { c: failedCase, user }));
    assert.match(denied, /El análisis se interrumpió/);
    assert.match(denied, /Se interrumpió la sesión/);
    assert.doesNotMatch(denied, /<form|Reintentar|Podés volver a intentarlo/);
  }
});
