import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TERMINAL_LAYOUT, normalizeTerminalLayout, resizedTerminal, terminalSizeLimits } from "../src/lib/workspaceLayout.ts";

test("terminal layout defaults above chat while preserving saved placement", () => {
  assert.deepEqual(normalizeTerminalLayout(null), DEFAULT_TERMINAL_LAYOUT);
  assert.equal(DEFAULT_TERMINAL_LAYOUT.dock, "top");
  assert.deepEqual(normalizeTerminalLayout({ dock: "sideways", width: NaN, height: Infinity }), DEFAULT_TERMINAL_LAYOUT);
  for (const dock of ["right", "top", "bottom"]) assert.equal(normalizeTerminalLayout({ dock }).dock, dock);
});
test("saved bottom layout and dimensions are bounded", () => {
  assert.deepEqual(normalizeTerminalLayout({ dock: "bottom", width: -1, height: 999999 }), { dock: "bottom", width: 180, height: 1800 });
});
test("divider direction follows the top, bottom or right panel and preserves room for chat", () => {
  const limits = terminalSizeLimits("bottom", 1440, 900);
  assert.equal(resizedTerminal("bottom", 320, 40, 1440, 900), 280);
  assert.equal(resizedTerminal("bottom", 320, -9999, 1440, 900), limits.max);
  assert.equal(resizedTerminal("right", 520, 40, 1440, 900), 480);
  assert.equal(resizedTerminal("right", 520, 9999, 1440, 900), 240);
  assert.equal(resizedTerminal("top", 320, 40, 1440, 900), 360);
  assert.equal(resizedTerminal("top", 320, -40, 1440, 900), 280);
  assert.equal(resizedTerminal("top", 320, 9999, 1440, 900), limits.max);
  assert.equal(resizedTerminal("top", 320, -9999, 1440, 900), limits.min);
});
