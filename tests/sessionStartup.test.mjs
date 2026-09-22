import test from "node:test";
import assert from "node:assert/strict";
import { SessionStartupIndex, startupSnapshot, startupStageLabel, validInitialization } from "../src/lib/sessionStartup.ts";

test("startup responses require an explicit phase, stage and correct session identity", () => {
  for (const phase of ["initializing", "ready", "failed"]) {
    const result = { sessionId: "a", initialization: { phase, stage: "tools" } };
    assert.equal(startupSnapshot(result, "a"), result);
  }
  for (const result of [
    null, {}, { sessionId: "b", initialization: { phase: "ready", stage: "ready" } },
    { sessionId: "a", initialization: { phase: "done", stage: "tools" } },
    { sessionId: "a", initialization: { phase: "ready" } },
    { sessionId: "a", initialization: { phase: "ready", stage: "ready" }, session: { sessionId: "b" } },
  ]) assert.throws(() => startupSnapshot(result, "a"));
  assert.equal(validInitialization({ phase: "failed", stage: "tools", error: 1 }), false);
});

test("startup UI distinguishes tool/model preparation from failure and readiness", () => {
  assert.match(startupStageLabel({ phase: "initializing", stage: "tools" }), /tools and MCP/);
  assert.match(startupStageLabel({ phase: "initializing", stage: "model" }), /model/);
  assert.match(startupStageLabel({ phase: "failed", stage: "tools" }), /failed/);
  assert.equal(startupStageLabel({ phase: "ready", stage: "ready" }), "Session is ready");
});

test("local real sessions survive missing native index and stale attachment reads", () => {
  const index = new SessionStartupIndex();
  const old = { sessionId: "old" };
  const fresh = { sessionId: "native-id", isActive: true, archived: true,
    initialization: { phase: "initializing", stage: "tools" } };
  index.add(fresh.sessionId);
  assert.deepEqual(index.reconcile([fresh, old], [old]), [fresh, old]);
  const stale = { ...fresh, isActive: false, initialization: undefined };
  assert.deepEqual(index.reconcile([fresh, old], [old, stale]), [fresh, old]);
  const disconnected = { ...fresh, isActive: false, initialization: { phase: "failed", stage: "tools", error: "Disconnected" } };
  assert.deepEqual(index.reconcile([fresh], [disconnected]), [disconnected]);
});

test("native publication cannot bury new rows and deletion cannot resurrect them", () => {
  const index = new SessionStartupIndex();
  const fresh = { sessionId: "native-id", initialization: { phase: "ready", stage: "ready" } };
  const indexed = Array.from({ length: 150 }, (_, i) => ({ sessionId: `old-${i}` }));
  index.add(fresh.sessionId);
  const result = index.reconcile([fresh, ...indexed], [...indexed, fresh]);
  assert.equal(result[0], fresh);
  index.remove(fresh.sessionId);
  assert.deepEqual(index.reconcile(result, [...indexed, fresh]), indexed);
  assert.deepEqual(index.reconcile(result, indexed), indexed);
});

test("initializing rows restored from reload survive a stale list without retaining unrelated rows", () => {
  const index = new SessionStartupIndex();
  const fresh = { sessionId: "native-id", initialization: { phase: "initializing", stage: "tools" } };
  assert.deepEqual(index.reconcile([fresh, { sessionId: "removed" }], []), [fresh]);
});
