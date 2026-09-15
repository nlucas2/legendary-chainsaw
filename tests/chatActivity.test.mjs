import test from "node:test";
import assert from "node:assert/strict";
import { activityFromEvent, activityIsProcessing, activityTimings, emptyActivity, submittedActivity, isTranscriptEvent } from "../src/lib/chatActivity.ts";

const event = (type, data = {}, agentId) => ({ type, data, agentId, id: type, timestamp: "2026-09-04T00:00:00Z" });

test("model turn boundaries do not finish the agent interaction", () => {
  let state = submittedActivity(100);
  state = activityFromEvent(state, event("user.message"), 120);
  state = activityFromEvent(state, event("assistant.turn_start"), 130);
  state = activityFromEvent(state, event("assistant.turn_end"), 150);
  assert.equal(activityIsProcessing(state), true);
  state = activityFromEvent(state, event("tool.execution_start"), 160);
  assert.equal(activityIsProcessing(state), true);
  state = activityFromEvent(state, event("session.idle"), 200);
  assert.equal(activityIsProcessing(state), false);
});

test("subagent idle must not finish root turn", () => {
  const state = submittedActivity(100);
  assert.equal(activityFromEvent(state, event("session.idle", {}, "child"), 200), state);
});

test("replayed or externally sent user messages do not invent local acceptance latency", () => {
  const state = activityFromEvent(emptyActivity(), event("user.message"), 200);
  assert.equal(state.phase, "working");
  assert.equal(activityTimings(state), "");
});

test("first output timing stops changing across token deltas", () => {
  let state = activityFromEvent(submittedActivity(100), event("user.message"), 110);
  state = activityFromEvent(state, event("model.call_start"), 200);
  state = activityFromEvent(state, event("assistant.reasoning_delta", { deltaContent: "Summary" }), 1200);
  const first = state;
  state = activityFromEvent(state, event("assistant.message_delta", { deltaContent: "Answer" }), 1400);
  assert.equal(state, first);
  assert.match(activityTimings(state), /Accepted 10 ms.*Model started 100 ms.*First output 1.1 s/);
});

test("HTTP acceptance before user.message does not lose the submission clock", () => {
  const acknowledged = { ...submittedActivity(100), phase: "working", acceptedAt: 105 };
  const delivered = activityFromEvent(acknowledged, event("user.message"), 110);
  assert.equal(delivered.submittedAt, 100);
  assert.equal(delivered.acceptedAt, 105);
  assert.equal(delivered.awaitingUserEvent, false);
  const next = activityFromEvent(delivered, event("user.message"), 500);
  assert.equal(next.submittedAt, undefined);
});

test("diagnostic metadata never invalidates transcript", () => {
  for (const type of ["model.messages_snapshot", "system.message", "assistant.streaming_delta", "assistant.usage"]) {
    assert.equal(isTranscriptEvent(event(type)), false, type);
  }
  assert.equal(isTranscriptEvent(event("assistant.reasoning_delta")), true);
  assert.equal(isTranscriptEvent(event("tool.execution_partial_result")), true);
  assert.equal(activityFromEvent(emptyActivity(), event("model.messages_snapshot"), 100).phase, "idle");
});
