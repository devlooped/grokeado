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

test("malformed and private links return form errors instead of throwing", async (t) => {
  t.mock.method(auth0, "getSession", async () => ({ user: { sub: "daniel", email: "daniel@cazzulino.com", email_verified: true } }) as Awaited<ReturnType<typeof auth0.getSession>>);

  const malformed = new FormData();
  malformed.set("kind", "link");
  malformed.set("url", "example.com");
  assert.deepEqual(await requestFactCheck({}, malformed), { error: "Ingresá un enlace válido (http o https)." });

  const privateLink = new FormData();
  privateLink.set("kind", "link");
  privateLink.set("url", "http://localhost:3000/secret");
  assert.deepEqual(await requestFactCheck({}, privateLink), { error: "Ingresá un enlace público." });
});
