import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TERMINAL_LAYOUT, normalizeTerminalLayout, resizedTerminal, terminalSizeLimits,
  normalizeSidebarWidth, sidebarSize, sidebarSizeLimits,
} from "../src/lib/workspaceLayout.ts";

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

test("sidebar widths retain responsive defaults and bound saved preferences", () => {
  for (const raw of [null, undefined, "400", NaN, Infinity, {}]) assert.equal(normalizeSidebarWidth(raw), null);
  assert.equal(normalizeSidebarWidth(99999), 560);
  assert.equal(normalizeSidebarWidth(-5), 200);
  assert.equal(sidebarSize(null, 1440, false), 272);
  assert.equal(sidebarSize(null, 1000, false), 230);
  assert.equal(sidebarSize(480, 1440, false), 480);
  assert.equal(sidebarSize(480, 821, false), 401);
  assert.equal(sidebarSize(480, 1440, false), 480);
});

test("sidebar and terminal share the remaining width without overflowing desktop viewports", () => {
  for (const width of [821, 900, 1000, 1120, 1121, 1440, 1920]) {
    for (const preferred of [null, 200, 400, 560]) {
      const sidebar = sidebarSize(preferred, width, true);
      const { min, max } = sidebarSizeLimits(width, true);
      assert.ok(sidebar >= min && sidebar <= max);
      const terminal = resizedTerminal("right", 1800, 0, width, 900, sidebar);
      const chatMin = width <= 1120 ? 330 : 380;
      assert.ok(terminal >= 240);
      assert.ok(sidebar + terminal + chatMin + 5 <= width, `overflow at ${width}px`);
      assert.equal(terminalSizeLimits("top", width, 900, sidebar).max, terminalSizeLimits("top", width, 900).max);
    }
  }
});
