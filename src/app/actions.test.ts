import assert from "node:assert/strict";
import { test } from "node:test";
import { auth0 } from "../lib/auth0.ts";
import { BETA_MESSAGE } from "../lib/case-access.ts";
import { requestFactCheck } from "./actions.ts";

test("case requests require the verified authorized account before validating input", async (t) => {
  const form = new FormData();
  form.set("kind", "text");
  form.set("text", "short");

  const sessions = [
    null,
    { user: { sub: "someone", email: "other@example.com", email_verified: true } },
    { user: { sub: "someone", email: "daniel@cazzulino.com", email_verified: false } },
    { user: { sub: "someone", email: "daniel@cazzulino.com" } },
    { user: { email: "daniel@cazzulino.com", email_verified: true } },
  ];
  for (const session of sessions) {
    const getSession = t.mock.method(auth0, "getSession", async () => session as Awaited<ReturnType<typeof auth0.getSession>>);
    assert.deepEqual(await requestFactCheck({}, form), { error: BETA_MESSAGE });
    form.set("text", "Una afirmación suficientemente larga para pedir un chequeo.");
    assert.deepEqual(await requestFactCheck({}, form), { error: BETA_MESSAGE });
    form.set("text", "short");
    getSession.mock.restore();
  }

  t.mock.method(auth0, "getSession", async () => ({ user: { sub: "daniel", email: "Daniel@Cazzulino.com", email_verified: true } }) as Awaited<ReturnType<typeof auth0.getSession>>);
  assert.deepEqual(await requestFactCheck({}, form), { error: "Pegá un texto de al menos 20 caracteres." });
});
