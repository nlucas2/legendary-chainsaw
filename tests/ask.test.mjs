import test from "node:test";
import assert from "node:assert/strict";
import { AskRequests, normalizeAskResult, ingestAskEvent, subscribeAskEvents } from "../src/lib/ask.ts";

const event = (sessionId, requestId, phase, data = {}) => ({
  type: "session_event", sessionId,
  event: { type: "ui.ephemeral_query", data: { requestId, phase, ...data } },
});

test("ask accepts only the response from its own RPC session", () => {
  assert.deepEqual(normalizeAskResult({ sessionId: "a", answer: "" }, "a"), { sessionId: "a", answer: "" });
  assert.throws(() => normalizeAskResult({ sessionId: "b", answer: "other answer" }, "a"));
  assert.throws(() => normalizeAskResult({ sessionId: "a", error: "failed" }, "a"));
  assert.throws(() => normalizeAskResult(null, "a"));
});

test("one ask per session; errors and stale completion never release a newer query", () => {
  const queries = new AskRequests();
  assert.throws(() => queries.start("a", " \n "));
  const a = queries.start("a", "question");
  const b = queries.start("b", "same question");
  assert.throws(() => queries.start("a", "other question"));
  assert.equal(queries.finish("b", a), false);
  assert.equal(queries.finish("a", a), true);
  const next = queries.start("a", "next");
  assert.equal(queries.finish("a", a), false);
  assert.throws(() => queries.start("a", "still busy"));
  assert.equal(queries.finish("b", b), true);
  assert.equal(queries.finish("a", next), true);
});

test("unbound native events cannot claim a pending ask even for identical questions", () => {
  const queries = new AskRequests();
  queries.start("a", "shared question");
  assert.equal(ingestAskEvent(event("a", "other-client", "started", { question: "shared question" })), false);
  assert.equal(ingestAskEvent(event("a", "other-client", "completed", { answer: "not ours" })), false);
});

test("event hub requires exact parent and native request IDs and preserves order", () => {
  const received = [];
  const unsubscribe = subscribeAskEvents("a:b", "c", (value) => received.push(value));
  assert.equal(ingestAskEvent(event("a", "b:c", "chunk", { chunk: "wrong" })), false);
  assert.equal(ingestAskEvent(event("a:b", "other", "chunk", { chunk: "wrong" })), false);
  assert.equal(ingestAskEvent(event("a:b", "c", "started")), true);
  assert.equal(ingestAskEvent(event("a:b", "c", "chunk", { chunk: "one" })), true);
  assert.equal(ingestAskEvent(event("a:b", "c", "chunk", { chunk: "two" })), true);
  assert.equal(ingestAskEvent(event("a:b", "c", "completed", { answer: "onetwo" })), true);
  assert.deepEqual(received.map((value) => value.phase), ["started", "chunk", "chunk", "completed"]);
  assert.deepEqual(received.filter((value) => value.chunk).map((value) => value.chunk), ["one", "two"]);
  unsubscribe();
  assert.equal(ingestAskEvent(event("a:b", "c", "aborted")), false);
});

test("malformed or unrelated events are not forwarded as query output", () => {
  const received = [];
  const unsubscribe = subscribeAskEvents("a", "q", (value) => received.push(value));
  for (const input of [null, {}, event("a", "q", "chunk"), event("a", "q", "failed"),
    event("a", "q", "completed", { answer: 42 }), event("a", "q", "unexpected"), event("a", "q", ["started"]),
    { type: "session_event", sessionId: "a", event: { type: "assistant.message", data: { requestId: "q" } } },
    { type: "session_event", sessionId: "a", event: { type: "ui.ephemeral_query", data: { queryId: "q", phase: "started" } } },
  ]) assert.equal(ingestAskEvent(input), false);
  assert.equal(received.length, 0);
  unsubscribe();
});
