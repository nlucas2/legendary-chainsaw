import test from "node:test";
import assert from "node:assert/strict";
import { processingActivity, sessionActivityIndicator, SessionActivityTracker } from "../src/lib/sessionActivity.ts";

const event = (type, data = {}, agentId) => ({ id: type, type, data, agentId, timestamp: "" });

test("only boolean snapshots establish working or idle; missing state is never assumed idle", () => {
  assert.equal(processingActivity(true).kind, "working");
  assert.equal(processingActivity(false).kind, "idle");
  for (const value of [null, undefined, 0, "", {}, { processing: false }]) assert.throws(() => processingActivity(value));
  assert.equal(sessionActivityIndicator(true, true).label, "Checking status");
  assert.equal(sessionActivityIndicator(false, true, { kind: "working" }).label, "Not attached");
  assert.equal(sessionActivityIndicator(true, false, { kind: "idle" }).label, "Status unavailable");
  assert.match(sessionActivityIndicator(true, true, { kind: "unknown", reason: "Unavailable: timeout" }).description, /timeout/);
});

test("live events update their own root session without treating child idle or model turn end as session idle", () => {
  const tracker = new SessionActivityTracker();
  tracker.accept("a", 0, processingActivity(false));
  tracker.accept("b", 0, processingActivity(false));
  assert.equal(tracker.observe("b", event("user.message", { content: "Start work" })), true);
  assert.equal(tracker.snapshot().b.kind, "working");
  assert.equal(tracker.snapshot().a.kind, "idle");
  assert.equal(tracker.observe("b", event("assistant.turn_end")), false);
  assert.equal(tracker.observe("b", event("session.idle", {}, "child")), false);
  assert.equal(tracker.observe("b", event("subagent.completed")), false);
  assert.equal(tracker.snapshot().b.kind, "working");
  assert.equal(tracker.observe("b", event("session.idle")), true);
  assert.equal(tracker.snapshot().b.kind, "idle");
});

test("stale poll values and errors cannot overwrite newer streamed activity", () => {
  const tracker = new SessionActivityTracker();
  const old = tracker.version("a");
  tracker.observe("a", event("assistant.turn_start"));
  assert.equal(tracker.accept("a", old, processingActivity(false)), false);
  assert.equal(tracker.accept("a", old, { kind: "unknown", reason: "old timeout" }), false);
  const streaming = tracker.version("a");
  assert.equal(tracker.observe("a", event("assistant.message_delta", { content: "More output" })), false);
  assert.ok(tracker.version("a") > streaming);
  assert.equal(tracker.accept("a", streaming, processingActivity(false)), false);
  const beforeIdle = tracker.version("a");
  tracker.observe("a", event("session.idle"));
  assert.equal(tracker.accept("a", beforeIdle, processingActivity(true)), false);
  assert.equal(tracker.snapshot().a.kind, "idle");
});

test("unrelated metadata does not invent activity and disconnect invalidation rejects old reads", () => {
  const tracker = new SessionActivityTracker();
  assert.equal(tracker.observe("a", event("session.model_change", { model: "m" })), false);
  assert.deepEqual(tracker.snapshot(), {});
  tracker.accept("a", 0, processingActivity(true));
  const old = tracker.version("a");
  tracker.invalidate("a");
  assert.equal(tracker.accept("a", old, processingActivity(false)), false);
  assert.deepEqual(tracker.snapshot(), {});
  tracker.observe("a", event("session.error", { message: "Runtime failed" }));
  assert.equal(tracker.snapshot().a.kind, "unknown");
  assert.equal(tracker.snapshot().a.reason, "Runtime failed");
});
