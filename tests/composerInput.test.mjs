import test from "node:test";
import assert from "node:assert/strict";
import { submitsComposer } from "../src/lib/composerInput.ts";

const enter = { key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false };
test("mobile Enter inserts a newline; explicit hardware shortcuts and desktop Enter still send", () => {
  assert.equal(submitsComposer(enter, true), false);
  assert.equal(submitsComposer(enter, false), true);
  for (const mobile of [true, false]) {
    assert.equal(submitsComposer({ ...enter, ctrlKey: true }, mobile), true);
    assert.equal(submitsComposer({ ...enter, metaKey: true }, mobile), true);
    assert.equal(submitsComposer({ ...enter, shiftKey: true }, mobile), false);
    assert.equal(submitsComposer({ ...enter, isComposing: true }, mobile), false);
    assert.equal(submitsComposer({ ...enter, key: "a" }, mobile), false);
  }
});
