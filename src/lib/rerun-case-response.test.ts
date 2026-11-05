import assert from "node:assert/strict";
import { test } from "node:test";
import type { CaseRecord, Submission } from "../domain/court.ts";
import { rerunCaseResponse } from "./rerun-case-response.ts";

const admin = { sub: "admin-user", roles: ["Admin"] };
const request = (origin = "https://example.test") => new Request("https://example.test/api/cases/AA-123-BB/rerun", { method: "POST", headers: { origin } });
const original = (submission: Submission, status: CaseRecord["status"] = "resolved"): CaseRecord => ({ id: "AA-123-BB", createdAt: "2026-01-01", status, submission, pipelineVersion: 1 });
function dependencies(record: CaseRecord | undefined = original({ kind: "text", text: "A claim", language: "auto", resolvedLanguage: "es" })) {
  const calls: unknown[][] = [];
  const deps = {
    getCase: async (id: string): Promise<CaseRecord | undefined> => { calls.push(["getCase", id]); return record; },
    getImage: async (id: string): Promise<{ bytes: Buffer } | undefined> => { calls.push(["getImage", id]); return { bytes: Buffer.from("image") }; },
    createCase: async (submission: Submission, image: Buffer | undefined, ownerId: string) => { calls.push(["createCase", submission, image, ownerId]); return "CC-456-DD"; },
    start: async (id: string) => { calls.push(["start", id]); },
    finish: async (id: string, status: "failed", error: string) => { calls.push(["finish", id, status, error]); },
  };
  return { calls, deps };
}

test("reruns reject unauthorized, cross-origin and invalid requests before accessing storage", async () => {
  const { calls, deps } = dependencies();
  for (const [req, id, user, status] of [
    [request(), "AA-123-BB", undefined, 401],
    [request(), "AA-123-BB", { roles: ["Admin"] }, 401],
    [request(), "AA-123-BB", { sub: "user", roles: ["admin"] }, 403],
    [request("https://attacker.test"), "AA-123-BB", admin, 403],
    [request(), "../bad", admin, 400],
  ] as const) assert.equal((await rerunCaseResponse(req, id, user, deps)).status, status);
  assert.deepEqual(calls, []);
});

test("a rerun creates and starts a fresh case from the submission, without reusing detected language", async () => {
  const { calls, deps } = dependencies();
  const response = await rerunCaseResponse(request(), "AA-123-BB", admin, deps);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id: "CC-456-DD" });
  assert.deepEqual(calls, [["getCase", "AA-123-BB"], ["createCase", { kind: "text", text: "A claim", language: "auto" }, undefined, "admin-user"], ["start", "CC-456-DD"]]);
});

test("image reruns copy original bytes, while missing images, active and missing cases are rejected", async () => {
  const submission: Submission = { kind: "image", mimeType: "image/png", note: "note", language: "en" };
  const image = dependencies(original(submission, "failed"));
  assert.equal((await rerunCaseResponse(request(), "AA-123-BB", admin, image.deps)).status, 201);
  assert.deepEqual(image.calls, [["getCase", "AA-123-BB"], ["getImage", "AA-123-BB"], ["createCase", submission, Buffer.from("image"), "admin-user"], ["start", "CC-456-DD"]]);
  const missingImage = dependencies(original(submission));
  missingImage.deps.getImage = async () => undefined;
  assert.equal((await rerunCaseResponse(request(), "AA-123-BB", admin, missingImage.deps)).status, 409);
  assert.equal(missingImage.calls.length, 1);
  for (const status of ["queued", "in_session"] as const) {
    const active = dependencies(original(submission, status));
    assert.equal((await rerunCaseResponse(request(), "AA-123-BB", admin, active.deps)).status, 409);
    assert.equal(active.calls.length, 1);
  }
  const missing = dependencies();
  missing.deps.getCase = async () => undefined;
  assert.equal((await rerunCaseResponse(request(), "AA-123-BB", admin, missing.deps)).status, 404);
});

test("a workflow start failure leaves the new case visibly failed", async (t) => {
  const { calls, deps } = dependencies();
  deps.start = async (id) => { calls.push(["start", id]); throw new Error("offline"); };
  t.mock.method(console, "error", () => {});
  const response = await rerunCaseResponse(request(), "AA-123-BB", admin, deps);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id: "CC-456-DD" });
  assert.deepEqual(calls.at(-1), ["finish", "CC-456-DD", "failed", "No se pudo iniciar la sesión."]);
});
