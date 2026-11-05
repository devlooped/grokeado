import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { auth0 } from "../../lib/auth0.ts";
import { markNotificationsRead } from "./actions.ts";

test("marking notifications read requires an admin and a valid ID before touching storage", async (t) => {
  const query = t.mock.method(Pool.prototype, "query", () => { throw new Error("unexpected database access"); });
  const form = new FormData();
  form.set("through", "1");
  for (const session of [null, { user: { sub: "user", roles: ["admin"] } }]) {
    const mocked = t.mock.method(auth0, "getSession", async () => session as Awaited<ReturnType<typeof auth0.getSession>>);
    await assert.rejects(markNotificationsRead(form), /No autorizado/);
    mocked.mock.restore();
  }
  t.mock.method(auth0, "getSession", async () => ({ user: { sub: "admin", roles: ["Admin"] } }) as unknown as Awaited<ReturnType<typeof auth0.getSession>>);
  for (const id of ["", "-1", "1 OR 1=1", "9223372036854775808"]) {
    form.set("through", id);
    await assert.rejects(markNotificationsRead(form), /Notificación inválida/);
  }
  assert.equal(query.mock.callCount(), 0);
});
