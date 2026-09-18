import test from "node:test";
import assert from "node:assert/strict";
import { startupSnapshot, startupStageLabel, validInitialization } from "../src/lib/sessionStartup.ts";

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
