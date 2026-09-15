import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_TYPOGRAPHY, typographyPreset } from "../src/lib/typography.ts";

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: {
    contents: 'export { SettingsPanel } from "./SettingsPanel.tsx";',
    resolveDir: path.resolve("src", "components"),
    loader: "tsx",
  },
  bundle: true, write: false, format: "esm", platform: "node", jsx: "automatic",
  plugins: [{
    name: "shared-react-and-packages",
    setup(builder) {
      builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
      builder.onResolve({ filter: /^(react(?:\/.*)?|lucide-react)$/ },
        (args) => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
    },
  }],
});
const { SettingsPanel } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const render = (settings = DEFAULT_TYPOGRAPHY, error = "") => renderToStaticMarkup(createElement(SettingsPanel, {
  themePreference: "auto", onThemePreferenceChange() {}, onClose() {}, onOpenRuntime() {},
  typography: { settings, error, setSettings() {}, reset() {} },
}));

test("settings render original selected with labelled controls and live preview", () => {
  const html = render();
  assert.match(html, /aria-pressed="true">Original/);
  assert.match(html, /aria-pressed="false">CLI-like/);
  assert.match(html, /aria-label="Live typography preview"/);
  for (const label of ["Chat font", "Chat font size", "Chat line spacing", "Paragraph spacing", "Terminal font", "Terminal font size", "Terminal line spacing"]) {
    assert.ok(html.includes(label), label);
  }
  assert.equal((html.match(/type="range"/g) ?? []).length, 5);
  assert.equal((html.match(/aria-valuetext=/g) ?? []).length, 5);
  assert.match(html, /Reset font &amp; spacing/);
  assert.doesNotMatch(html, /role="alert"/);
});

test("CLI-like preview shows compact settings and selected preset", () => {
  const html = render(typographyPreset("cli"));
  assert.match(html, /aria-pressed="true">CLI-like/);
  assert.match(html, /font-size:14px;line-height:1.4/);
  assert.match(html, /margin:0 0 6px/);
  assert.match(html, /Cascadia Mono/);
  assert.match(html, /font-size:13px;line-height:1.1/);
});

test("custom fonts expose labelled inputs, explicit apply, and a local-only explanation", () => {
  const html = render({
    ...typographyPreset("cli"), fontFamily: "custom", customFontFamily: "Iosevka",
    terminalFontFamily: "custom", terminalCustomFontFamily: "Fira Code",
  });
  assert.match(html, /Custom chat font families/);
  assert.match(html, /Custom terminal font families/);
  assert.match(html, /value="Iosevka"/);
  assert.match(html, /value="Fira Code"/);
  assert.equal((html.match(/>Apply font<\/button>/g) ?? []).length, 2);
  assert.equal((html.match(/aria-describedby=/g) ?? []).length, 2);
  assert.match(html, /Installed font names only/);
});

test("storage failures are visible and announced without hiding controls", () => {
  const html = render(DEFAULT_TYPOGRAPHY, "Could not save typography: storage denied.");
  assert.match(html, /role="alert">Could not save typography: storage denied/);
  assert.match(html, /Reset font &amp; spacing/);
});
