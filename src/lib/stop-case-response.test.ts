import assert from "node:assert/strict";
import { test } from "node:test";
import { stopCaseResponse } from "./stop-case-response.ts";

const admin = { sub: "user", roles: ["Admin"] };
const request = (origin = "https://example.test") => new Request("https://example.test/api/cases/AA-123-BB/stop", { method: "POST", headers: { origin } });

test("stop requires an authenticated admin, same origin and a valid id", async () => {
  let calls = 0;
  const stop = async () => { calls++; return "stopped" as const; };
  for (const [req, id, user, status] of [
    [request(), "AA-123-BB", undefined, 401], [request(), "AA-123-BB", { roles: ["Admin"] }, 401],
    [request(), "AA-123-BB", { sub: "user", roles: ["admin"] }, 403],
    [request("https://attacker.test"), "AA-123-BB", admin, 403], [request(), "../bad", admin, 400],
  ] as const) assert.equal((await stopCaseResponse(req, id, user, stop)).status, status);
  assert.equal(calls, 0);
});

test("stop reports successful, missing, inactive and unavailable workflows", async () => {
  for (const [result, status] of [["stopped", 204], ["missing", 404], ["inactive", 409], ["unavailable", 409]] as const) {
    const response = await stopCaseResponse(request(), "AA-123-BB", admin, async (id) => { assert.equal(id, "AA-123-BB"); return result; });
    assert.equal(response.status, status);
  }
});

test("a cancellation failure is reported rather than claimed as stopped", async (t) => {
  t.mock.method(console, "error", () => {});
  assert.equal((await stopCaseResponse(request(), "AA-123-BB", admin, async () => { throw new Error("offline"); })).status, 500);
});
