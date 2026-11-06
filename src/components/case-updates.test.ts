import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { watchCaseUpdates } from "./case-updates.tsx";

class FakeEventSource extends EventTarget {
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 1;
  onerror?: () => void;
  constructor(readonly url: string) { super(); FakeEventSource.instances.push(this); }
  close() { this.readyState = FakeEventSource.CLOSED; }
  update(value: unknown) { this.dispatchEvent(new MessageEvent("case-update", { data: typeof value === "string" ? value : JSON.stringify(value) })); }
}

function install(t: TestContext) {
  FakeEventSource.instances = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  Object.defineProperty(globalThis, "EventSource", { value: FakeEventSource, configurable: true });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "EventSource", original);
    else Reflect.deleteProperty(globalThis, "EventSource");
  });
}

test("SSE invalidations refresh only for new complete snapshots, not duplicate or malformed events", (t) => {
  install(t);
  let refreshes = 0;
  const close = watchCaseUpdates("case /?", "0:in_session:1", () => { refreshes++; });
  t.after(close);
  const source = FakeEventSource.instances[0];
  assert.equal(source.url, "/api/cases/case%20%2F%3F/events?since=0%3Ain_session%3A1");
  source.update({ version: "0:in_session:1", done: false });
  source.update("bad json");
  source.update(null);
  source.update({ version: 3, done: false });
  source.update({ version: "0:in_session:2", done: "false" });
  assert.equal(refreshes, 0);
  source.update({ version: "0:in_session:2", done: false });
  source.update({ version: "0:in_session:2", done: false });
  assert.equal(refreshes, 1);
  close();
  source.update({ version: "0:in_session:3", done: false });
  assert.equal(refreshes, 1, "unmounted components ignore queued events");
  assert.equal(source.readyState, FakeEventSource.CLOSED);
});

test("terminal results, failures and missing cases refresh once and close the subscription", (t) => {
  install(t);
  for (const version of ["1:resolved:10", "0:failed:5", "missing"]) {
    let refreshes = 0;
    const close = watchCaseUpdates("fixture", version, () => { refreshes++; });
    const source = FakeEventSource.instances.at(-1)!;
    source.update({ version, done: true });
    source.update({ version, done: true });
    assert.equal(refreshes, 1);
    assert.equal(source.readyState, FakeEventSource.CLOSED);
    close();
  }
});

test("native reconnects are preserved and permanently closed connections retry from the last received cursor", (t) => {
  install(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const close = watchCaseUpdates("fixture", "0:queued:0", () => {});
  t.after(close);
  const first = FakeEventSource.instances[0];
  first.update({ version: "0:in_session:4", done: false });
  first.readyState = 0;
  first.onerror?.();
  t.mock.timers.tick(1000);
  assert.equal(FakeEventSource.instances.length, 1, "do not duplicate the browser's own reconnect");
  first.close();
  first.onerror?.();
  first.onerror?.();
  t.mock.timers.tick(1000);
  assert.equal(FakeEventSource.instances.length, 2);
  assert.match(FakeEventSource.instances[1].url, /since=0%3Ain_session%3A4$/);
  first.onerror?.();
  t.mock.timers.tick(1000);
  assert.equal(FakeEventSource.instances.length, 2, "stale errors cannot replace a healthy reconnection");
  FakeEventSource.instances[1].close();
  FakeEventSource.instances[1].onerror?.();
  close();
  t.mock.timers.tick(1000);
  assert.equal(FakeEventSource.instances.length, 2, "unmount cancels pending retries");
});
