import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { CaseProgress } from "../store.ts";
import { caseEventStream, caseProgressVersion } from "./case-event-stream.ts";

const progress: CaseProgress = { status: "in_session", revision: 0, seq: 1 };
const decoder = new TextDecoder();
const frame = async (reader: ReadableStreamDefaultReader<Uint8Array>) => decoder.decode((await reader.read()).value);
const request = (since = "", signal?: AbortSignal, lastId?: string) => new Request("https://example.test/api/cases/fixture/events?since=" + encodeURIComponent(since), {
  signal, headers: lastId ? { "Last-Event-ID": lastId } : undefined,
});

async function advance(t: TestContext, ms = 1000) {
  t.mock.timers.tick(ms);
  await setImmediate();
}

test("the SSE response sends only a cursor, never submission, messages or internal traces", async (t) => {
  const response = await caseEventStream(request(), "fixture", async () => ({ ...progress, ownerId: "PRIVATE OWNER", submission: "PRIVATE SUBMISSION", reasoning: "PRIVATE TRACE" }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  const reader = response.body!.getReader();
  t.after(() => reader.cancel());
  assert.equal(await frame(reader), "retry: 1000\n\n");
  assert.equal(await frame(reader), 'id: 0:in_session:1\nevent: case-update\ndata: {"version":"0:in_session:1","done":false}\n\n');
});

test("only recorded progress changes emit updates, including queue entry and terminal status", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let current: CaseProgress = { status: "queued", revision: 0, seq: 0 };
  const response = await caseEventStream(request(caseProgressVersion(current)), "fixture", async () => current);
  const reader = response.body!.getReader();
  t.after(() => reader.cancel());
  await frame(reader); // retry directive; the initial snapshot already matches the page
  let emitted = false;
  const next = frame(reader).then((value) => { emitted = true; return value; });
  await advance(t);
  assert.equal(emitted, false, "unchanged snapshots must not refresh the page");
  current = { ...current, status: "in_session" };
  await advance(t);
  assert.match(await next, /"version":"0:in_session:0","done":false/);
  current = { ...current, seq: 2 };
  await advance(t);
  assert.match(await frame(reader), /"version":"0:in_session:2","done":false/);
  current = { ...current, status: "resolved", revision: 1 };
  await advance(t);
  assert.match(await frame(reader), /"version":"1:resolved:2","done":true/);
  assert.equal((await reader.read()).done, true);
});

test("reconnection resumes from Last-Event-ID and catches up without replaying duplicate updates", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let current = progress;
  const response = await caseEventStream(request("0:queued:0", undefined, caseProgressVersion(current)), "fixture", async () => current);
  const reader = response.body!.getReader();
  t.after(() => reader.cancel());
  await frame(reader);
  let emitted = false;
  const next = frame(reader).then((value) => { emitted = true; return value; });
  await advance(t);
  assert.equal(emitted, false, "Last-Event-ID overrides the original since query");
  current = { ...progress, seq: 4 };
  await advance(t);
  assert.match(await next, /id: 0:in_session:4/);
  const caughtUp = await caseEventStream(request("0:in_session:1"), "fixture", async () => current);
  const caughtUpReader = caughtUp.body!.getReader();
  t.after(() => caughtUpReader.cancel());
  await frame(caughtUpReader);
  assert.match(await frame(caughtUpReader), /id: 0:in_session:4/);
});

test("quiet streams send heartbeats and rotate before the serverless limit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const response = await caseEventStream(request(caseProgressVersion(progress)), "fixture", async () => progress);
  const reader = response.body!.getReader();
  await frame(reader);
  await advance(t, 15_000);
  assert.equal(await frame(reader), ": keep-alive\n\n");
  await advance(t, 35_000);
  assert.equal((await reader.read()).done, true);
});

test("tool invocations invalidate SSE even while no new court message has been committed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let current = { ...progress, activity: 0 };
  const response = await caseEventStream(request(caseProgressVersion(current)), "fixture", async () => current);
  const reader = response.body!.getReader();
  t.after(() => reader.cancel());
  await frame(reader);
  current = { ...current, activity: 1 };
  await advance(t);
  assert.match(await frame(reader), /"version":"0:in_session:1:tools:1","done":false/);
  current = { ...current, activity: 2 };
  await advance(t);
  assert.match(await frame(reader), /"version":"0:in_session:1:tools:2","done":false/);
  assert.equal(current.seq, 1);
});

for (const status of ["resolved", "failed"] as const) {
  test(`a ${status} case emits its terminal snapshot and closes even on a matching cursor`, async () => {
    const terminal = { ...progress, status };
    const response = await caseEventStream(request(caseProgressVersion(terminal)), "fixture", async () => terminal);
    const reader = response.body!.getReader();
    await frame(reader);
    assert.match(await frame(reader), /"done":true/);
    assert.equal((await reader.read()).done, true);
  });
}

test("request abort and consumer cancellation release timers/listeners and stop database reads", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const cancel of [false, true]) {
    const abort = new AbortController();
    const req = request(caseProgressVersion(progress), abort.signal);
    let reads = 0;
    const response = await caseEventStream(req, "fixture", async () => { reads++; return progress; });
    const reader = response.body!.getReader();
    await frame(reader);
    assert.equal(getEventListeners(req.signal, "abort").length, 1);
    if (cancel) await reader.cancel(); else abort.abort();
    await advance(t, 60_000);
    assert.equal(reads, 1);
    assert.equal(getEventListeners(req.signal, "abort").length, 0);
    assert.equal((await reader.read()).done, true);
  }
});

test("an already aborted request never starts the polling loop", async () => {
  const response = await caseEventStream(request("", AbortSignal.abort()), "fixture", async () => progress);
  assert.equal((await response.body!.getReader().read()).done, true);
});

test("missing cases and initial database failures do not expose storage errors", async () => {
  const missing = await caseEventStream(request(), "fixture", async () => undefined);
  assert.equal(missing.status, 404);
  const unavailable = await caseEventStream(request(), "fixture", async () => { throw new Error("PRIVATE CONNECTION STRING"); });
  assert.equal(unavailable.status, 503);
  assert.ok(!(await unavailable.text()).includes("PRIVATE"));
});

test("a case removed during the stream ends with a terminal invalidation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let current: CaseProgress | undefined = progress;
  const response = await caseEventStream(request(caseProgressVersion(progress)), "fixture", async () => current);
  const reader = response.body!.getReader();
  await frame(reader);
  current = undefined;
  await advance(t);
  assert.match(await frame(reader), /"version":"missing","done":true/);
  assert.equal((await reader.read()).done, true);
});

test("midstream read errors close cleanly so EventSource can reconnect, without emitting error details", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  const response = await caseEventStream(request(caseProgressVersion(progress)), "fixture", async () => {
    if (reads++) throw new Error("PRIVATE DATABASE ERROR");
    return progress;
  });
  const reader = response.body!.getReader();
  await frame(reader);
  await advance(t);
  assert.equal((await reader.read()).done, true);
});
