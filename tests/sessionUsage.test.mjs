import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSessionUsage, formatAiCredits, isSessionUsageEvent } from "../src/lib/sessionUsage.ts";

test("session AI credits use only the authoritative native total, not request or model costs", () => {
  const metrics = {
    totalNanoAiu: 2_345_678_900,
    totalPremiumRequestCost: 100,
    modelMetrics: { example: { totalNanoAiu: 2_345_678_900, requests: { cost: 100 } } },
    agentMetrics: { main: { totalNanoAiu: 1_000_000_000 }, child: { totalNanoAiu: 1_345_678_900 } },
  };
  assert.deepEqual(normalizeSessionUsage(metrics), { totalNanoAiu: 2_345_678_900 });
  assert.equal(formatAiCredits(normalizeSessionUsage(metrics).totalNanoAiu), "2.345679");
  assert.deepEqual(normalizeSessionUsage({ ...metrics, totalNanoAiu: undefined }), { totalNanoAiu: null });
  assert.deepEqual(normalizeSessionUsage({ cost: 2, copilotUsage: { totalNanoAiu: 1_000_000_000 } }), { totalNanoAiu: null });
});

test("missing, invalid and unavailable credits are distinct from a reported zero", () => {
  for (const value of [undefined, null, {}, [], "10", { totalNanoAiu: null },
    { totalNanoAiu: -1 }, { totalNanoAiu: "1" }, { totalNanoAiu: Infinity }, { totalNanoAiu: NaN }]) {
    assert.deepEqual(normalizeSessionUsage(value), { totalNanoAiu: null });
  }
  assert.deepEqual(normalizeSessionUsage({ totalNanoAiu: 0 }), { totalNanoAiu: 0 });
  assert.equal(formatAiCredits(null), "Unavailable");
  assert.equal(formatAiCredits(-1), "Unavailable");
  assert.equal(formatAiCredits(Infinity), "Unavailable");
  assert.equal(formatAiCredits(0), "0");
  assert.equal(formatAiCredits(1), "<0.000001");
  assert.equal(formatAiCredits(999), "<0.000001");
  assert.equal(formatAiCredits(1000), "0.000001");
});

test("snapshot replacements permit native accounting corrections without summing duplicates", () => {
  const snapshots = [3_000_000_000, 3_000_000_000, 2_000_000_000, 0, undefined];
  assert.deepEqual(snapshots.map((totalNanoAiu) => normalizeSessionUsage({ totalNanoAiu }).totalNanoAiu),
    [3_000_000_000, 3_000_000_000, 2_000_000_000, 0, null]);
});

test("usage refreshes include subagents and durable checkpoints without transcript traffic", () => {
  for (const type of ["assistant.usage", "assistant.idle", "session.usage_checkpoint", "session.shutdown",
    "subagent.completed", "subagent.failed"]) {
    assert.equal(isSessionUsageEvent({ type, agentId: "child" }), true, type);
  }
  for (const type of ["assistant.message_delta", "model.call_start", "session.usage_info"]) {
    assert.equal(isSessionUsageEvent({ type }), false, type);
  }
});
