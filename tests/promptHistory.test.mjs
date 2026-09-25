import test from "node:test";
import assert from "node:assert/strict";
import { PromptHistoryNavigation, recentPrompts } from "../src/lib/promptHistory.ts";
import { adjacentSession } from "../src/lib/shortcuts.ts";
import { matchesAction } from "../src/lib/keybindings.ts";

test("session cycling uses sidebar order, wraps, and requires the exact modifier combinations", () => {
  const sessionCycleDirection = (event, desktop) => matchesAction({}, "nextSession", event, desktop) ? 1
    : matchesAction({}, "previousSession", event, desktop) ? -1 : null;
  const entries = ["pinned", "folder", "unfiled"].map((sessionId) => ({ sessionId }));
  assert.equal(adjacentSession(entries, "pinned", -1).sessionId, "unfiled");
  assert.equal(adjacentSession(entries, "unfiled", 1).sessionId, "pinned");
  assert.equal(adjacentSession(entries, "absent", 1).sessionId, "pinned");
  assert.equal(adjacentSession(entries, "absent", -1).sessionId, "unfiled");
  assert.equal(adjacentSession([], null, 1), undefined);
  const key = { key: "Tab", ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, isComposing: false };
  assert.equal(sessionCycleDirection(key, true), 1);
  assert.equal(sessionCycleDirection({ ...key, shiftKey: true }, true), -1);
  assert.equal(sessionCycleDirection(key, false), null);
  assert.equal(sessionCycleDirection({ ...key, shiftKey: true }, false), null);
  for (const desktop of [true, false]) {
    assert.equal(sessionCycleDirection({ ...key, key: "ArrowDown", altKey: true }, desktop), 1);
    assert.equal(sessionCycleDirection({ ...key, key: "ArrowUp", altKey: true }, desktop), -1);
  }
  for (const change of [{ ctrlKey: false }, { metaKey: true }, { isComposing: true }, { altKey: true },
    { key: "ArrowUp" }, { key: "ArrowRight", altKey: true }, { key: "ArrowDown", altKey: true, shiftKey: true }]) {
    assert.equal(sessionCycleDirection({ ...key, ...change }, true), null);
  }
});

test("prompt navigation preserves an unfinished draft and edits, and does not wrap past oldest", () => {
  const navigation = new PromptHistoryNavigation();
  const history = ["old\nmultiline", "recent"];
  assert.equal(navigation.move(history, 1, "my draft"), null);
  assert.equal(navigation.move(history, -1, "my draft"), "recent");
  assert.equal(navigation.move(history, -1, "edited recent"), "old\nmultiline");
  assert.equal(navigation.move(history, -1, "old\nmultiline"), null);
  assert.equal(navigation.move(history, 1, "edited old"), "edited recent");
  assert.equal(navigation.move(history, 1, "edited recent"), "my draft");
  assert.equal(navigation.move(history, 1, "my draft"), null);
  assert.equal(navigation.move(history, -1, "new draft"), "recent");
  assert.equal(navigation.move(history, 1, "recent"), "new draft");
});

test("history traversal is stable when new messages arrive and reset discards only its cursor", () => {
  const navigation = new PromptHistoryNavigation();
  assert.equal(navigation.move([], -1, "keep me"), null);
  assert.equal(navigation.move(["older"], -1, ""), "older");
  assert.equal(navigation.move(["older", "new event"], 1, "older"), "");
  assert.equal(navigation.move(["older", "new event"], -1, "draft"), "new event");
  navigation.reset();
  assert.equal(navigation.move(["older"], 1, "untouched"), null);
});

test("history contains only human root prompts and bounds distinct texts without duplicating native/local entries", () => {
  const event = (content, extra = {}) => ({ id: content, type: "user.message", timestamp: "", data: { content }, ...extra });
  const events = [
    event("first"),
    event("skill instructions", { data: { content: "skill instructions", source: "skill-fixture" } }),
    event("scheduled input", { data: { content: "scheduled input", source: "schedule-1" } }),
    event("child instruction", { agentId: "child" }),
    event("assistant reply", { type: "assistant.message" }),
    event("second", { data: { content: "second", source: "user" } }),
  ];
  assert.deepEqual(recentPrompts(events, ["second", "queued"]), ["first", "second", "queued"]);
  const many = recentPrompts([], Array.from({ length: 105 }, (_, i) => String(i)));
  assert.equal(many.length, 100);
  assert.equal(many[0], "5");
});
