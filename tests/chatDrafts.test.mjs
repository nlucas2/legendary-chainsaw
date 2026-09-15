import test from "node:test";
import assert from "node:assert/strict";
import { chatDraftReducer, EMPTY_SESSION_DRAFTS } from "../src/lib/chatDrafts.ts";
import { SessionOperations } from "../src/lib/sessionOperations.ts";

const first = { text: "Read this file", attachments: [{ id: "file-a", displayName: "a.txt" }] };
const second = { text: "Another prompt", attachments: [{ id: "file-b", displayName: "b.txt" }] };
const edit = (state, sessionId, draft) => chatDraftReducer(state, { type: "edit", sessionId, update: () => draft });
const fail = (state) => chatDraftReducer(state, { type: "failed", sessionId: "a", id: "failed-a", draft: first, error: "Network error" });

test("session drafts keep text and files together without crossing sessions", () => {
  const state = edit(edit({}, "a", first), "b", second);
  assert.deepEqual(state.a.current, first);
  assert.deepEqual(state.b.current, second);
  assert.deepEqual(EMPTY_SESSION_DRAFTS.current, { text: "", attachments: [] });
});

test("a send failure restores the originating session after switching away", () => {
  let state = edit(edit({}, "a", first), "b", second);
  state = chatDraftReducer(state, { type: "submitted", sessionId: "a" });
  state = fail(state);
  assert.deepEqual(state.a.current, first);
  assert.equal(state.a.error, "Network error");
  assert.deepEqual(state.b.current, second);
});

test("failed sends never combine their files with a newer prompt", () => {
  let state = fail(edit({}, "a", second));
  assert.deepEqual(state.a.current, second);
  assert.deepEqual(state.a.saved[0].draft, first);
  state = chatDraftReducer(state, { type: "restore", sessionId: "a", id: "failed-a" });
  assert.deepEqual(state.a.current, first);
  assert.deepEqual(state.a.saved[0].draft, second);
  state = chatDraftReducer(state, { type: "restore", sessionId: "a", id: "failed-a" });
  assert.deepEqual(state.a.current, second);
  assert.deepEqual(state.a.saved[0].draft, first);
});

test("attachment-only drafts are not replaced by failed messages", () => {
  const draft = { text: "", attachments: second.attachments };
  const state = fail(edit({}, "a", draft));
  assert.deepEqual(state.a.current, draft);
  assert.deepEqual(state.a.saved[0].draft, first);
});

test("late file reads update only the originating draft", () => {
  const state = chatDraftReducer(edit({}, "b", second), {
    type: "edit", sessionId: "a", update: (draft) => ({ ...draft, attachments: first.attachments }),
  });
  assert.deepEqual(state.a.current.attachments, first.attachments);
  assert.deepEqual(state.b.current, second);
});

test("stashing swaps complete drafts independently per session", () => {
  let state = edit(edit({}, "a", first), "b", second);
  state = chatDraftReducer(state, { type: "stash", sessionId: "a" });
  assert.deepEqual(state.a.current, EMPTY_SESSION_DRAFTS.current);
  assert.deepEqual(state.b.current, second);
  state = chatDraftReducer(state, { type: "stash", sessionId: "a" });
  assert.deepEqual(state.a.current, first);
});

test("busy state is session keyed and an old completion cannot clear a newer request", () => {
  const operations = new SessionOperations();
  const firstA = operations.start("a", "plan");
  assert.equal(operations.get("b"), undefined);
  const firstB = operations.start("b", "autopilot");
  assert.equal(operations.start("a", "interactive"), undefined);
  assert.equal(operations.finish("a", firstA), true);
  assert.equal(operations.get("b"), "autopilot");
  const nextA = operations.start("a", "interactive");
  assert.equal(operations.finish("a", firstA), false);
  assert.equal(operations.get("a"), "interactive");
  assert.equal(operations.finish("a", nextA), true);
  assert.equal(operations.finish("b", firstB), true);
});
