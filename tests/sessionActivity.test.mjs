import test from "node:test";
import assert from "node:assert/strict";
import { processingActivity, sessionActivityIndicator, SessionActivityTracker, subagentActivity } from "../src/lib/sessionActivity.ts";

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

test("idle parents with running subagents have a distinct display, without changing root processing", () => {
  const activity = { kind: "idle", runningSubagents: 2 };
  const indicator = sessionActivityIndicator(true, true, activity);
  assert.equal(indicator.kind, "delegating");
  assert.equal(indicator.label, "2 subagents working");
  assert.match(indicator.description, /parent is idle/i);
  assert.equal(activity.kind, "idle");
  assert.equal(subagentActivity({ ...activity, kind: "working" }), null);
  assert.equal(subagentActivity({ kind: "idle", runningSubagents: 0 }), null);
  assert.equal(sessionActivityIndicator(true, false, activity).label, "Status unavailable");
  assert.equal(sessionActivityIndicator(false, true, activity).label, "Not attached");
  assert.equal(sessionActivityIndicator(true, true, { ...activity, kind: "working" }).label, "Working");
  assert.equal(subagentActivity({ kind: "idle", subagentError: "Unavailable" }).state, "unknown");
});

test("subagent lifecycle signals invalidate stale counts and root idle retains last known child work", () => {
  const tracker = new SessionActivityTracker();
  tracker.accept("a", 0, { kind: "working", runningSubagents: 1 });
  tracker.observe("a", event("session.idle"));
  assert.equal(subagentActivity(tracker.snapshot().a).label, "1 subagent working");
  const before = tracker.version("a");
  tracker.observe("a", event("subagent.started", { toolCallId: "call" }, "different-agent-id"));
  assert.equal(tracker.accept("a", before, { kind: "idle", runningSubagents: 0 }), false);
  tracker.accept("a", tracker.version("a"), { kind: "idle", runningSubagents: 2 });
  const beforeCompletion = tracker.version("a");
  tracker.observe("a", event("subagent.completed", { toolCallId: "call" }, "different-agent-id"));
  assert.equal(tracker.accept("a", beforeCompletion, { kind: "idle", runningSubagents: 2 }), false);
  tracker.accept("a", tracker.version("a"), { kind: "idle", runningSubagents: 0 });
  assert.equal(subagentActivity(tracker.snapshot().a), null);
  tracker.invalidate("a");
  assert.equal(subagentActivity(tracker.snapshot().a), null);
});
