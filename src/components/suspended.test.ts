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

test("only admins see failure details and retry controls", () => {
  const allowed = renderToStaticMarkup(createElement(Suspended, { c: failedCase, user: { sub: "admin-user", roles: ["Admin"] } }));
  assert.match(allowed, /<form/);
  assert.match(allowed, /Reintentar/);
  assert.match(allowed, /Podés volver a intentarlo/);
  assert.match(allowed, /Detalle: Se interrumpió la sesión/);

  for (const user of [
    undefined,
    null,
    { sub: "someone", email: "other@example.com", email_verified: true },
    { sub: "someone", email: "daniel@cazzulino.com", email_verified: false },
    { email: "daniel@cazzulino.com", email_verified: true },
    { sub: "daniel", email: "daniel@cazzulino.com", email_verified: true },
    { sub: "someone", roles: ["admin"] },
    { roles: ["Admin"] },
  ]) {
    const denied = renderToStaticMarkup(createElement(Suspended, { c: failedCase, user }));
    assert.match(denied, /El análisis se interrumpió/);
    assert.match(denied, /El panel no pudo completar el análisis/);
    assert.doesNotMatch(denied, /Detalle:|Se interrumpió la sesión|<form|Reintentar|Podés volver a intentarlo/);
    assert.match(denied, /href="mailto:hola@che\.bot\?subject=Caso%20failed-case%20interrumpido"/);
  }
  for (const html of [allowed, renderToStaticMarkup(createElement(Suspended, { c: failedCase, user: undefined }))]) {
    assert.ok(html.includes('href="/"'), "every visitor has a way back");
  }
  assert.doesNotMatch(allowed, /mailto:/);
});
