import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { auth0 } from "../lib/auth0.ts";
import { DELETE } from "./api/cases/[id]/route.ts";

test("DELETE independently checks the server session before accessing storage", async (t) => {
  const db = t.mock.method(Pool.prototype, "query", () => { throw new Error("unexpected database access"); });
  const req = new Request("https://example.test/api/cases/AA-123-BB", { method: "DELETE", headers: { origin: "https://example.test" } });
  for (const [user, expected] of [[undefined, 401], [{ sub: "user", roles: ["beta"] }, 403], [{ sub: "user", roles: ["admin"] }, 403], [{ roles: ["Admin"] }, 401]] as const) {
    const mocked = t.mock.method(auth0, "getSession", async () => user ? ({ user } as unknown as Awaited<ReturnType<typeof auth0.getSession>>) : null);
    const response = await DELETE(req, { params: Promise.resolve({ id: "AA-123-BB" }) });
    assert.equal(response.status, expected);
    mocked.mock.restore();
  }
  assert.equal(db.mock.callCount(), 0);
});
