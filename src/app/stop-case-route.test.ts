import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { auth0 } from "../lib/auth0.ts";
import { POST } from "./api/cases/[id]/stop/route.ts";

test("stop route independently checks the server session before accessing storage", async (t) => {
  const db = t.mock.method(Pool.prototype, "query", () => { throw new Error("unexpected database access"); });
  const req = new Request("https://example.test/api/cases/AA-123-BB/stop", { method: "POST", headers: { origin: "https://example.test" } });
  for (const [user, expected] of [[undefined, 401], [{ sub: "user", roles: ["beta"] }, 403], [{ sub: "user", roles: ["admin"] }, 403], [{ roles: ["Admin"] }, 401]] as const) {
    const mocked = t.mock.method(auth0, "getSession", async () => user ? ({ user } as unknown as Awaited<ReturnType<typeof auth0.getSession>>) : null);
    assert.equal((await POST(req, { params: Promise.resolve({ id: "AA-123-BB" }) })).status, expected);
    mocked.mock.restore();
  }
  assert.equal(db.mock.callCount(), 0);
});
