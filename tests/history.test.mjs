import test from "node:test";
import assert from "node:assert/strict";
import { mergeHistoryEvents } from "../src/lib/history.ts";

const event = (id, timestamp = "2026-09-04T01:00:00Z") => ({ id, type: "test", data: {}, timestamp });
const ids = (events) => events.map((event) => event.id);
test("history preserves authoritative order across backwards timestamps", () => {
  const user = event("user", "2026-09-04T02:00:00Z");
  const assistant = event("assistant");
  assert.deepEqual(ids(mergeHistoryEvents([user, assistant], [])), ["user", "assistant"]);
});
test("older pages prepend and newer live events append without duplicates", () => {
  assert.deepEqual(ids(mergeHistoryEvents([event("a"), event("b")], [event("b"), event("c")])), ["a", "b", "c"]);
  assert.deepEqual(ids(mergeHistoryEvents([event("a")], [event("b"), event("c")])), ["a", "b", "c"]);
});
test("refresh windows retain an already-loaded older prefix", () => {
  assert.deepEqual(ids(mergeHistoryEvents([event("c"), event("d"), event("e")],
    [event("a"), event("b"), event("c"), event("d"), event("f")])), ["a", "b", "c", "d", "e", "f"]);
});
test("ephemeral reasoning stays between shared log anchors", () => {
  assert.deepEqual(ids(mergeHistoryEvents([event("user"), event("answer"), event("idle")],
    [event("user"), event("reasoning"), event("answer")])), ["user", "reasoning", "answer", "idle"]);
});
test("canonical order wins over a previously misordered shared prefix", () => {
  assert.deepEqual(ids(mergeHistoryEvents([event("a"), event("b"), event("c")],
    [event("b"), event("a"), event("c")])), ["a", "b", "c"]);
});
