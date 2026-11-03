import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { auth0 } from "../lib/auth0.ts";
import { requestFactCheck, retryCase } from "./actions.ts";

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
    assert.deepEqual(await requestFactCheck({}, form), { error: "Che.bot está en beta. Para pedir un chequeo, enviá un correo a hola@che.bot." });
    form.set("text", "Una afirmación suficientemente larga para pedir un chequeo.");
    assert.deepEqual(await requestFactCheck({}, form), { error: "Che.bot está en beta. Para pedir un chequeo, enviá un correo a hola@che.bot." });
    form.set("text", "short");
    getSession.mock.restore();
  }

  t.mock.method(auth0, "getSession", async () => ({ user: { sub: "daniel", email: "Daniel@Cazzulino.com", email_verified: true } }) as Awaited<ReturnType<typeof auth0.getSession>>);
  assert.deepEqual(await requestFactCheck({}, form), { error: "Pegá un texto de al menos 20 caracteres." });
});

test("retrying a case rejects unauthorized sessions before accessing storage", async (t) => {
  const query = t.mock.method(Pool.prototype, "query", () => { throw new Error("unexpected database access"); });
  const sessions = [
    null,
    { user: { sub: "someone", email: "other@example.com", email_verified: true } },
    { user: { sub: "someone", email: "daniel@cazzulino.com", email_verified: false } },
    { user: { sub: "someone", email: "daniel@cazzulino.com" } },
    { user: { email: "daniel@cazzulino.com", email_verified: true } },
  ];
  for (const session of sessions) {
    const getSession = t.mock.method(auth0, "getSession", async () => session as Awaited<ReturnType<typeof auth0.getSession>>);
    await assert.rejects(retryCase("failed-case"), /No autorizado/);
    getSession.mock.restore();
  }
  assert.equal(query.mock.callCount(), 0);
});

test("an authorized retry attempts the atomic failed-to-queued transition", async (t) => {
  t.mock.method(auth0, "getSession", async () => ({ user: { sub: "daniel", email: "Daniel@Cazzulino.com", email_verified: true } }) as Awaited<ReturnType<typeof auth0.getSession>>);
  const queries: { sql: string; values?: unknown[] }[] = [];
  t.mock.method(Pool.prototype, "query", (async (sql: string, values?: unknown[]) => {
    queries.push({ sql, values });
    return { rows: [], rowCount: 0 };
  }) as typeof Pool.prototype.query);
  const originalUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://example.invalid/test";
  try {
    await assert.rejects(retryCase("failed-case"), { digest: "NEXT_REDIRECT;replace;/caso/failed-case;307;" });
  } finally {
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  }
  const updates = queries.filter(({ sql }) => sql.startsWith("UPDATE cases SET status = 'queued'"));
  assert.equal(updates.length, 1);
  assert.match(updates[0].sql, /status = 'failed'/);
  assert.deepEqual(updates[0].values, ["failed-case"]);
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
