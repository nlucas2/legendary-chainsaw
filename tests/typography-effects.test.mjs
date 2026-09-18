import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { build } from "esbuild";
import { DEFAULT_TYPOGRAPHY, TYPOGRAPHY_STORAGE_KEY, typographyPreset } from "../src/lib/typography.ts";

// Exercise effect dependencies and storage/terminal lifecycles without a browser or PTY.
const mocks = {
  react: `
    export const useState = (...args) => globalThis.__typographyTestRuntime.useState(...args);
    export const useRef = (...args) => globalThis.__typographyTestRuntime.useRef(...args);
    export const useEffect = (...args) => globalThis.__typographyTestRuntime.useEffect(...args);
    export const useCallback = (...args) => globalThis.__typographyTestRuntime.useCallback(...args);
  `,
  "react/jsx-runtime": `export const jsx = (type, props) => ({type, props}); export const jsxs = jsx;`,
  "@xterm/xterm": `export const Terminal = class {
    constructor(options) { this.options = options; this.cols = 80; this.rows = 24; this.disposed = false;
      globalThis.__typographyTestRuntime.terminals.push(this); }
    loadAddon(addon) { addon.terminal = this; }
    open() {}
    attachCustomKeyEventHandler() {}
    hasSelection() { return false; }
    focus() { this.focused = true; }
    onSelectionChange() { return { dispose() {} }; }
    onData() { return { dispose() {} }; }
    onResize(callback) { this.resize = callback; return { dispose() {} }; }
    refresh() {}
    dispose() { this.disposed = true; }
  };`,
  "@xterm/addon-fit": `export const FitAddon = class {
    fit() {
      const terminal = this.terminal;
      const cols = Math.floor(800 / terminal.options.fontSize);
      const rows = Math.floor(400 / (terminal.options.fontSize * terminal.options.lineHeight));
      if (cols !== terminal.cols || rows !== terminal.rows) {
        terminal.cols = cols; terminal.rows = rows;
        terminal.resize?.({ cols, rows });
      }
    }
  };`,
  "lucide-react": `export const ChevronDown = "icon", Copy = "icon", Link2 = "icon", LockKeyhole = "icon",
    Power = "icon", Unlink = "icon", Users = "icon", X = "icon";`,
  "../lib/daemon": `export const daemonClientId = () => "client";
    export const daemonWebSocketUrl = () => "ws://localhost/api/terminal";`,
};
const compiled = await build({
  stdin: {
    contents: 'export { useTypography } from "./src/lib/useTypography"; export { TerminalPane } from "./src/components/TerminalPane";',
    resolveDir: path.resolve(), loader: "tsx",
  },
  bundle: true, write: false, format: "esm", platform: "node", jsx: "automatic",
  plugins: [{
    name: "mock-effect-environment",
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) => args.path in mocks || args.path.endsWith(".css")
        ? { path: args.path, namespace: "mock" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "mock" },
        (args) => ({ contents: mocks[args.path] ?? "", loader: "js" }));
    },
  }],
});
const { useTypography, TerminalPane } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);

function environment() {
  const originals = new Map();
  const slots = [];
  const effects = [];
  const listeners = new Map();
  const variables = new Map();
  const attributes = new Map();
  const frames = new Map();
  const stored = new Map();
  let index = 0;
  let frameId = 0;
  let writes = 0;
  const same = (left, right) => left && right && left.length === right.length && left.every((value, i) => Object.is(value, right[i]));
  const storage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem(key, value) { writes++; stored.set(key, value); },
    removeItem(key) { writes++; stored.delete(key); },
  };
  const runtime = {
    terminals: [], sockets: [], slots, variables, attributes, storage,
    get writes() { return writes; },
    useState(initial) {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = typeof initial === "function" ? initial() : initial;
      return [slots[slot], (value) => { slots[slot] = typeof value === "function" ? value(slots[slot]) : value; }];
    },
    useRef(initial) {
      const slot = index++;
      return slots[slot] ??= { current: initial };
    },
    useCallback(callback, dependencies) {
      const slot = index++;
      if (!same(slots[slot]?.dependencies, dependencies)) slots[slot] = { callback, dependencies };
      return slots[slot].callback;
    },
    useEffect(effect, dependencies) {
      const slot = index++;
      if (!same(slots[slot]?.dependencies, dependencies)) {
        effects.push(() => {
          slots[slot]?.cleanup?.();
          slots[slot] = { dependencies, cleanup: effect() };
        });
      }
    },
    render(component, props) { index = 0; return component(props); },
    commit() {
      while (effects.length) effects.shift()();
      for (const [id, callback] of frames) { frames.delete(id); callback(); }
    },
    storageEvent(newValue, key = TYPOGRAPHY_STORAGE_KEY, storageArea = storage) {
      for (const callback of listeners.get("storage") ?? []) callback({ key, newValue, storageArea });
    },
    close() {
      for (const slot of slots) slot?.cleanup?.();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
  const root = {
    dataset: {},
    getAttribute: (key) => attributes.get(key) ?? null,
    setAttribute: (key, value) => attributes.set(key, value),
    removeAttribute: (key) => attributes.delete(key),
    style: {
      getPropertyValue: (key) => variables.get(key) ?? "",
      setProperty: (key, value) => variables.set(key, value),
      removeProperty: (key) => variables.delete(key),
    },
  };
  const replacements = {
    __typographyTestRuntime: runtime,
    window: {
      localStorage: storage,
      addEventListener(type, callback) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(callback);
      },
      removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    },
    document: { documentElement: root },
    getComputedStyle: () => root.style,
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (callback) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id) => frames.delete(id),
    WebSocket: class {
      static OPEN = 1;
      readyState = 1;
      sent = [];
      closed = false;
      constructor(url) { this.url = url; runtime.sockets.push(this); }
      send(message) { this.sent.push(JSON.parse(message)); }
      close() { this.closed = true; }
    },
  };
  for (const [key, value] of Object.entries(replacements)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  return runtime;
}

test("hook preserves defaults, applies only opt-in root variables, and resets persistence", () => {
  const env = environment();
  try {
    let controller = env.render(useTypography);
    env.commit();
    assert.deepEqual(controller.settings, DEFAULT_TYPOGRAPHY);
    assert.equal(env.variables.size, 0);
    assert.equal(env.attributes.size, 0);
    assert.equal(env.writes, 0);
    controller.setSettings(typographyPreset("cli"));
    controller = env.render(useTypography);
    env.commit();
    assert.equal(env.variables.get("--chat-font-size"), "14px");
    assert.equal(env.attributes.get("data-typography"), "custom");
    assert.equal(env.writes, 1);
    controller.reset();
    controller = env.render(useTypography);
    env.commit();
    assert.deepEqual(controller.settings, DEFAULT_TYPOGRAPHY);
    assert.equal(env.variables.size, 0);
    assert.equal(env.attributes.size, 0);
    assert.equal(env.storage.getItem(TYPOGRAPHY_STORAGE_KEY), null);
  } finally { env.close(); }
});

test("cross-window storage changes, removal and clear apply without echo writes", () => {
  const env = environment();
  try {
    env.render(useTypography);
    env.commit();
    env.storageEvent(JSON.stringify(typographyPreset("cli")));
    let controller = env.render(useTypography);
    env.commit();
    assert.deepEqual(controller.settings, typographyPreset("cli"));
    assert.equal(env.writes, 0);
    env.storageEvent(JSON.stringify(DEFAULT_TYPOGRAPHY), "unrelated");
    env.storageEvent(JSON.stringify(DEFAULT_TYPOGRAPHY), TYPOGRAPHY_STORAGE_KEY, {});
    assert.deepEqual(env.render(useTypography).settings, typographyPreset("cli"));
    env.storageEvent(null);
    controller = env.render(useTypography);
    env.commit();
    assert.deepEqual(controller.settings, DEFAULT_TYPOGRAPHY);
    env.storageEvent(JSON.stringify(typographyPreset("cli")));
    env.render(useTypography);
    env.commit();
    env.storageEvent(null, null);
    controller = env.render(useTypography);
    env.commit();
    assert.deepEqual(controller.settings, DEFAULT_TYPOGRAPHY);
    assert.equal(env.variables.size, 0);
    assert.equal(env.writes, 0);
  } finally { env.close(); }
});

test("hook exposes read, write and reset failures without losing usable in-window settings", () => {
  const env = environment();
  try {
    env.storage.getItem = () => { throw new Error("read denied"); };
    env.storage.setItem = () => { throw new Error("quota exceeded"); };
    env.storage.removeItem = () => { throw new Error("reset denied"); };
    let controller = env.render(useTypography);
    env.commit();
    assert.match(controller.error, /read denied/);
    controller.setSettings(typographyPreset("cli"));
    controller = env.render(useTypography);
    env.commit();
    assert.match(controller.error, /quota exceeded/);
    assert.equal(controller.settings.preset, "cli");
    controller.reset();
    controller = env.render(useTypography);
    env.commit();
    assert.match(controller.error, /reset denied/);
    assert.deepEqual(controller.settings, DEFAULT_TYPOGRAPHY);
  } finally { env.close(); }
});

test("terminal font changes update options and resize without reconnecting or disposing", () => {
  const env = environment();
  try {
    const props = {
      sessionId: "session", cwd: "Q:\\workspace", followCwd: false,
      onFollowCwdChange() {}, onCwdChange() {}, onClose() {},
    };
    env.render(TerminalPane, props);
    env.slots[0].current = {};
    env.commit();
    const terminal = env.terminals[0];
    const socket = env.sockets[0];
    env.render(TerminalPane, {
      ...props, typography: { ...typographyPreset("cli"), terminalFontSize: 20, terminalLineHeight: 1.5 },
    });
    env.commit();
    assert.equal(env.terminals.length, 1);
    assert.equal(env.sockets.length, 1);
    assert.equal(terminal.disposed, false);
    assert.equal(socket.closed, false);
    assert.equal(terminal.options.fontSize, 20);
    assert.equal(terminal.options.lineHeight, 1.5);
    assert.match(terminal.options.fontFamily, /Cascadia Mono/);
    assert.deepEqual(socket.sent.at(-1), { type: "resize", cols: 40, rows: 13 });
    assert.ok(socket.sent.every((message) => message.type === "resize"));
    env.render(TerminalPane, { ...props, typography: DEFAULT_TYPOGRAPHY });
    env.commit();
    assert.equal(terminal.options.fontSize, 13);
    assert.equal(terminal.options.lineHeight, 1.18);
    assert.equal(env.sockets.length, 1);
  } finally { env.close(); }
});

test("independent reasoning applies with original chat, preserves saved choices when disabled, and resets", () => {
  const env = environment();
  try {
    let controller = env.render(useTypography);
    env.commit();
    controller.setSettings((current) => ({
      ...current, reasoningCustom: true, reasoningFontFamily: "custom", reasoningCustomFontFamily: "Georgia",
      reasoningFontSize: 18, reasoningLineHeight: 1.9, reasoningParagraphSpacing: 16,
      reasoningItalic: true, reasoningTone: "muted",
    }));
    controller = env.render(useTypography);
    env.commit();
    assert.equal(env.attributes.get("data-typography"), undefined);
    assert.equal(env.attributes.get("data-reasoning-typography"), "custom");
    assert.equal(env.attributes.get("data-reasoning-tone"), "muted");
    assert.equal(env.variables.get("--reasoning-font-size"), "18px");
    assert.equal(env.variables.get("--reasoning-font-style"), "italic");
    assert.ok([...env.variables.keys()].every((key) => key.startsWith("--reasoning-")));
    assert.equal(controller.settings.preset, "default");
    assert.equal(controller.settings.fontSize, 15);
    assert.equal(controller.settings.terminalFontSize, 13);
    assert.equal(JSON.parse(env.storage.getItem(TYPOGRAPHY_STORAGE_KEY)).reasoningCustom, true);
    controller.setSettings((current) => ({ ...current, reasoningCustom: false }));
    controller = env.render(useTypography);
    env.commit();
    assert.equal(env.variables.size, 0);
    assert.equal(env.attributes.size, 0);
    assert.equal(controller.settings.reasoningCustomFontFamily, "Georgia");
    controller.setSettings((current) => ({ ...current, reasoningCustom: true }));
    controller = env.render(useTypography);
    env.commit();
    assert.equal(env.variables.get("--reasoning-font-size"), "18px");
    controller.reset();
    controller = env.render(useTypography);
    env.commit();
    assert.equal(env.variables.size, 0);
    assert.equal(env.attributes.size, 0);
    assert.equal(env.storage.getItem(TYPOGRAPHY_STORAGE_KEY), null);
    assert.deepEqual(controller.settings, DEFAULT_TYPOGRAPHY);
  } finally { env.close(); }
});

test("changing chat font preserves independent reasoning and disabling it restores chat-only overrides", () => {
  const env = environment();
  try {
    let controller = env.render(useTypography);
    env.commit();
    controller.setSettings({
      ...typographyPreset("cli"), reasoningCustom: true, reasoningFontFamily: "custom",
      reasoningCustomFontFamily: "Georgia", reasoningFontSize: 18, reasoningTone: "normal",
    });
    controller = env.render(useTypography);
    env.commit();
    const reasoning = [...env.variables].filter(([key]) => key.startsWith("--reasoning-"));
    controller.setSettings((current) => ({ ...current, preset: "custom", fontFamily: "system", fontSize: 24 }));
    controller = env.render(useTypography);
    env.commit();
    assert.deepEqual([...env.variables].filter(([key]) => key.startsWith("--reasoning-")), reasoning);
    assert.equal(env.variables.get("--chat-font-size"), "24px");
    assert.equal(env.attributes.get("data-typography"), "custom");
    assert.equal(env.attributes.get("data-reasoning-tone"), "normal");
    const chat = [...env.variables].filter(([key]) => key.startsWith("--chat-"));
    controller.setSettings((current) => ({ ...current, reasoningCustom: false }));
    env.render(useTypography);
    env.commit();
    assert.deepEqual([...env.variables], chat);
    assert.deepEqual([...env.attributes], [["data-typography", "custom"]]);
  } finally { env.close(); }
});

test("old v1 loading and cross-window reasoning changes migrate without writes and clean up on removal", () => {
  const env = environment();
  try {
    const old = Object.fromEntries(Object.entries(typographyPreset("cli")).filter(([key]) => !key.startsWith("reasoning")));
    env.storage.setItem(TYPOGRAPHY_STORAGE_KEY, JSON.stringify(old));
    let controller = env.render(useTypography);
    env.commit();
    assert.deepEqual(controller.settings, typographyPreset("cli"));
    assert.equal(env.attributes.get("data-reasoning-typography"), undefined);
    const writes = env.writes;
    const customized = { ...DEFAULT_TYPOGRAPHY, reasoningCustom: true, reasoningFontSize: 19, reasoningTone: "muted" };
    env.storageEvent(JSON.stringify(customized));
    controller = env.render(useTypography);
    env.commit();
    assert.deepEqual(controller.settings, customized);
    assert.equal(env.variables.get("--reasoning-font-size"), "19px");
    assert.equal(env.attributes.get("data-typography"), undefined);
    assert.equal(env.attributes.get("data-reasoning-tone"), "muted");
    env.storageEvent(JSON.stringify(old));
    controller = env.render(useTypography);
    env.commit();
    assert.deepEqual(controller.settings, typographyPreset("cli"));
    assert.equal(env.attributes.get("data-reasoning-typography"), undefined);
    assert.equal(env.variables.get("--reasoning-font-size"), undefined);
    env.storageEvent(JSON.stringify(customized));
    env.render(useTypography);
    env.commit();
    env.storageEvent(null, null);
    controller = env.render(useTypography);
    env.commit();
    assert.deepEqual(controller.settings, DEFAULT_TYPOGRAPHY);
    assert.equal(env.variables.size, 0);
    assert.equal(env.attributes.size, 0);
    assert.equal(env.writes, writes);
  } finally { env.close(); }
});

test("reasoning effect cleanup restores pre-existing attributes and variables on unmount", () => {
  const env = environment();
  env.attributes.set("data-reasoning-typography", "existing");
  env.attributes.set("data-reasoning-tone", "existing-tone");
  env.variables.set("--reasoning-font-size", "21px");
  try {
    let controller = env.render(useTypography);
    env.commit();
    controller.setSettings({ ...DEFAULT_TYPOGRAPHY, reasoningCustom: true, reasoningTone: "muted" });
    controller = env.render(useTypography);
    env.commit();
    assert.equal(env.attributes.get("data-reasoning-typography"), "custom");
    assert.equal(env.variables.get("--reasoning-font-size"), "14px");
  } finally { env.close(); }
  assert.deepEqual([...env.attributes], [
    ["data-reasoning-typography", "existing"], ["data-reasoning-tone", "existing-tone"],
  ]);
  assert.deepEqual([...env.variables], [["--reasoning-font-size", "21px"]]);
});

test("reasoning storage failures stay visible while settings apply and reset in-window", () => {
  const env = environment();
  try {
    env.storage.setItem = () => { throw new Error("quota exceeded"); };
    env.storage.removeItem = () => { throw new Error("reset denied"); };
    let controller = env.render(useTypography);
    env.commit();
    controller.setSettings({ ...DEFAULT_TYPOGRAPHY, reasoningCustom: true, reasoningFontSize: 18 });
    controller = env.render(useTypography);
    env.commit();
    assert.match(controller.error, /quota exceeded.*only to this window/);
    assert.equal(env.variables.get("--reasoning-font-size"), "18px");
    controller.reset();
    controller = env.render(useTypography);
    env.commit();
    assert.match(controller.error, /reset denied/);
    assert.equal(env.variables.size, 0);
    assert.equal(env.attributes.size, 0);
  } finally { env.close(); }
});
