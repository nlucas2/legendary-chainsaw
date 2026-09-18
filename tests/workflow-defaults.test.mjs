import test from "node:test";
import assert from "node:assert/strict";
import { isTerminalToggle, isTerminalCopy } from "../src/lib/shortcuts.ts";
import { readDeliveryDefault } from "../src/lib/deliveryPreference.ts";

test("terminal shortcuts retain reasoning and browser keys and avoid AltGr/composition", () => {
  const key = { key: "t", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false };
  assert.equal(isTerminalToggle({ ...key, altKey: true }), false);
  assert.equal(isTerminalToggle({ ...key, ctrlKey: true, shiftKey: true }), true);
  assert.equal(isTerminalToggle({ ...key, key: "T", metaKey: true, shiftKey: true }), true);
  for (const extra of [{}, { ctrlKey: true }, { metaKey: true }, { altKey: true, ctrlKey: true },
    { altKey: true, shiftKey: true }, { altKey: true, isComposing: true }, { altKey: true, key: "q" }]) {
    assert.equal(isTerminalToggle({ ...key, ...extra }), false);
  }
});

test("terminal Ctrl/Cmd+C copies only selected text and preserves interrupt without selection", () => {
  const key = { key: "c", altKey: false, ctrlKey: true, metaKey: false, shiftKey: false, isComposing: false };
  assert.equal(isTerminalCopy(key, true), true);
  assert.equal(isTerminalCopy(key, false), false);
  assert.equal(isTerminalCopy({ ...key, ctrlKey: false, metaKey: true }, true), true);
  for (const change of [{ altKey: true }, { ctrlKey: false }, { isComposing: true }, { key: "v" }]) {
    assert.equal(isTerminalCopy({ ...key, ...change }, true), false);
  }
});

test("delivery defaults keep queue as the safe fallback and reject malformed preferences", () => {
  assert.deepEqual(readDeliveryDefault(null), { value: "enqueue", error: "" });
  assert.deepEqual(readDeliveryDefault("enqueue"), { value: "enqueue", error: "" });
  assert.deepEqual(readDeliveryDefault("immediate"), { value: "immediate", error: "" });
  for (const value of ["", "true", "steer", '{"delivery":"immediate"}']) {
    assert.equal(readDeliveryDefault(value).value, "enqueue");
    assert.match(readDeliveryDefault(value).error, /invalid/);
  }
});
