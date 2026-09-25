import test from "node:test";
import assert from "node:assert/strict";
import { SHORTCUT_ACTIONS, actionBindings, ariaBindings, binding, eventBinding, formatBinding,
  matchesAction, readKeybindings, validateBindings } from "../src/lib/keybindings.ts";

const ctrl = (key) => binding(key, { ctrlKey: true });
const saved = (bindings) => JSON.stringify({ version: 1, bindings });

test("defaults form a valid registry with exact modifier matching", () => {
  assert.equal(validateBindings({}), null);
  for (const action of SHORTCUT_ACTIONS) {
    for (const key of action.defaults) assert.equal(matchesAction({}, action.id, key, true), true, action.id);
  }
  assert.equal(matchesAction({}, "toggleReasoning", binding("t", { ctrlKey: true, shiftKey: true }), true), false);
  assert.equal(eventBinding({ ...ctrl("t"), isComposing: true }), null);
  assert.equal(eventBinding({ ...ctrl("t"), getModifierState: (name) => name === "AltGraph" }), null);
});

test("an explicit empty list remains unbound after serialization and never inherits defaults", () => {
  const overrides = Object.fromEntries(SHORTCUT_ACTIONS.map((action) => [action.id, []]));
  const read = readKeybindings(saved(overrides));
  assert.equal(read.error, "");
  for (const action of SHORTCUT_ACTIONS) {
    assert.deepEqual(actionBindings(read.overrides, action.id), []);
    for (const key of action.defaults) assert.equal(matchesAction(read.overrides, action.id, key, true), false);
  }
  assert.equal(ariaBindings(read.overrides, "stopTurn"), undefined);
  delete read.overrides.nextSession;
  assert.equal(matchesAction(read.overrides, "nextSession", ctrl("Tab"), true), true);
});

test("custom bindings replace defaults and conflict checks use effective assignments", () => {
  const custom = { toggleTerminal: [binding("F8")] };
  assert.equal(validateBindings(custom), null);
  assert.equal(matchesAction(custom, "toggleTerminal", binding("F8"), true), true);
  assert.equal(matchesAction(custom, "toggleTerminal", binding("t", { ctrlKey: true, shiftKey: true }), true), false);
  assert.match(validateBindings({ ...custom, newSession: [binding("F8")] }), /already assigned/);
  assert.match(validateBindings({ nextSession: [ctrl("t")] }), /already assigned/);
  assert.equal(validateBindings({ toggleReasoning: [], nextSession: [ctrl("t")] }), null);
  assert.match(validateBindings({ newSession: [binding("F8"), binding("F8")] }), /already assigned/);
});

test("browser Ctrl Tab safety applies even after rebinding it to another action", () => {
  const overrides = { nextSession: [], toggleTerminal: [ctrl("Tab")] };
  assert.equal(validateBindings(overrides), null);
  assert.equal(matchesAction(overrides, "toggleTerminal", ctrl("Tab"), false), false);
  assert.equal(matchesAction(overrides, "toggleTerminal", ctrl("Tab"), true), true);
});

test("native editing keys are protected and malformed persisted preferences report fallback explicitly", () => {
  for (const key of [binding("a"), binding("Enter"), binding("Tab"), ctrl("v"), ctrl("z"), binding("ArrowLeft")]) {
    assert.ok(validateBindings({ nextSession: [key] }));
  }
  for (const raw of ["{", "[]", saved({ unknownAction: [] }), saved({ nextSession: null }),
    saved({ nextSession: [{ key: "F8" }] }), saved({ nextSession: [ctrl("t")] })]) {
    const read = readKeybindings(raw);
    assert.ok(read.error);
    assert.deepEqual(read.overrides, {});
  }
  assert.deepEqual(readKeybindings(null), { overrides: {}, error: "" });
  assert.equal(formatBinding(binding("ArrowDown", { ctrlKey: true, altKey: true })), "Ctrl Alt Down");
  assert.equal(ariaBindings({ nextSession: [binding("F8")] }, "nextSession"), "F8");
});
