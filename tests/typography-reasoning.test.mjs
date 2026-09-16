import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_TYPOGRAPHY,
  MONOSPACE_FONT_FAMILY,
  SYSTEM_FONT_FAMILY,
  TYPOGRAPHY_STORAGE_KEY,
  normalizeTypography,
  parseTypographyPreferences,
  readTypographyPreferences,
  reasoningTypography,
  terminalTypography,
  typographyAttributes,
  typographyPreset,
  typographyVariables,
  writeTypographyPreferences,
} from "../src/lib/typography.ts";

const reasoningKeys = (settings) =>
  Object.fromEntries(Object.entries(settings).filter(([key]) => key.startsWith("reasoning")));
const chatVariables = (settings) =>
  Object.fromEntries(Object.entries(typographyVariables(settings)).filter(([key]) => key.startsWith("--chat-")));
const customized = {
  ...DEFAULT_TYPOGRAPHY,
  reasoningCustom: true,
  reasoningFontFamily: "custom",
  reasoningCustomFontFamily: "Georgia",
  reasoningFontSize: 18,
  reasoningLineHeight: 1.9,
  reasoningParagraphSpacing: 16,
  reasoningItalic: true,
  reasoningTone: "muted",
};

test("existing v1 preferences migrate additive reasoning defaults without activating styling", () => {
  for (const current of [DEFAULT_TYPOGRAPHY, typographyPreset("cli"), { ...typographyPreset("cli"), preset: "custom", fontSize: 22 }]) {
    const old = Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith("reasoning")));
    const result = parseTypographyPreferences(JSON.stringify(old));
    assert.equal(result.error, "");
    assert.deepEqual(result.settings, current);
    assert.deepEqual(reasoningKeys(result.settings), reasoningKeys(DEFAULT_TYPOGRAPHY));
    assert.deepEqual(typographyVariables(result.settings), chatVariables(current));
    assert.deepEqual(typographyAttributes(result.settings), current.preset === "default" ? {} : { "data-typography": "custom" });
  }
  assert.deepEqual(parseTypographyPreferences(null).settings, DEFAULT_TYPOGRAPHY);
});

test("only an explicit true flag enables independent reasoning, even with saved custom choices", () => {
  for (const flag of [undefined, null, false, "true", 1, {}]) {
    const settings = normalizeTypography({ ...customized, reasoningCustom: flag });
    assert.equal(settings.reasoningCustom, false);
    assert.deepEqual(typographyVariables(settings), {});
    assert.deepEqual(typographyAttributes(settings), {});
    assert.equal(settings.reasoningCustomFontFamily, "Georgia");
  }
});

test("independent reasoning generates only its own attributes and variables with original chat", () => {
  assert.deepEqual(typographyAttributes(customized), {
    "data-reasoning-typography": "custom", "data-reasoning-tone": "muted",
  });
  assert.deepEqual(typographyVariables(customized), {
    "--reasoning-font-family": `"Georgia", ${SYSTEM_FONT_FAMILY}`,
    "--reasoning-code-font-family": MONOSPACE_FONT_FAMILY,
    "--reasoning-font-size": "18px",
    "--reasoning-line-height": "1.9",
    "--reasoning-paragraph-spacing": "16px",
    "--reasoning-font-style": "italic",
  });
  assert.deepEqual(terminalTypography(customized), terminalTypography(DEFAULT_TYPOGRAPHY));
  assert.deepEqual(typographyAttributes({ ...customized, reasoningTone: "original" }), {
    "data-reasoning-typography": "custom",
  });
  assert.equal(typographyAttributes({ ...customized, reasoningTone: "normal" })["data-reasoning-tone"], "normal");
});

test("independent reasoning leaves customized chat and terminal settings unchanged", () => {
  const chat = { ...typographyPreset("cli"), preset: "custom", fontSize: 22, terminalFontSize: 16 };
  const settings = { ...chat, ...reasoningKeys(customized) };
  assert.deepEqual(chatVariables(settings), typographyVariables(chat));
  assert.deepEqual(terminalTypography(settings), terminalTypography(chat));
  assert.equal(settings.preset, "custom");
  assert.deepEqual(typographyVariables({ ...settings, reasoningCustom: false }), typographyVariables(chat));
  assert.deepEqual(typographyAttributes({ ...settings, reasoningCustom: false }), { "data-typography": "custom" });
});

test("custom reasoning family and metrics survive main font and CLI-like preset changes", () => {
  for (const fontFamily of ["system", "mono", "custom"]) {
    const changedChat = { ...customized, preset: "custom", fontFamily, customFontFamily: "Arial", fontSize: 24, lineHeight: 2.2 };
    assert.deepEqual(reasoningTypography(changedChat), reasoningTypography(customized));
    assert.deepEqual(reasoningKeys(typographyPreset("cli", changedChat)), reasoningKeys(customized));
  }
  const shared = { ...customized, preset: "custom", fontFamily: "mono", reasoningFontFamily: "shared" };
  assert.equal(reasoningTypography(shared).fontFamily, MONOSPACE_FONT_FAMILY);
  assert.equal(reasoningTypography(shared).fontSize, 18);
  assert.equal(reasoningTypography({ ...shared, fontFamily: "system" }).fontFamily, SYSTEM_FONT_FAMILY);
  assert.equal(reasoningTypography({ ...shared, reasoningFontFamily: "system" }).fontFamily, SYSTEM_FONT_FAMILY);
  assert.equal(reasoningTypography({ ...shared, fontFamily: "system", reasoningFontFamily: "mono" }).fontFamily, MONOSPACE_FONT_FAMILY);
});

test("reasoning custom local fonts use existing validation and safe fallbacks", () => {
  assert.equal(reasoningTypography({
    ...customized, reasoningCustomFontFamily: ' "Cascadia Code" , \'Consolas\' ',
  }).fontFamily, `"Cascadia Code", "Consolas", ${SYSTEM_FONT_FAMILY}`);
  for (const invalid of [
    'serif; color:red', 'url("https://fonts.example/test")', "var(--font)", "x\nfont",
    '"unfinished', "font\\escape", "a,,b", "a,b,c,d,e,f,g", "x".repeat(201), null, 42,
  ]) {
    const settings = normalizeTypography({ ...customized, reasoningCustomFontFamily: invalid });
    assert.equal(settings.reasoningCustomFontFamily, "");
    assert.equal(reasoningTypography(settings).fontFamily, SYSTEM_FONT_FAMILY);
    assert.equal(reasoningTypography({ ...customized, reasoningCustomFontFamily: invalid }).fontFamily, SYSTEM_FONT_FAMILY);
    assert.doesNotMatch(JSON.stringify(typographyVariables(settings)), /https?:|url\(/);
  }
});

test("reasoning settings validate enums and booleans and reuse bounded numeric ranges", () => {
  const bounded = normalizeTypography({
    ...customized, reasoningFontSize: -1, reasoningLineHeight: 99, reasoningParagraphSpacing: 99,
    reasoningFontFamily: "unknown", reasoningTone: "red", reasoningItalic: "true",
  });
  assert.equal(bounded.reasoningFontSize, 12);
  assert.equal(bounded.reasoningLineHeight, 2.2);
  assert.equal(bounded.reasoningParagraphSpacing, 24);
  assert.equal(bounded.reasoningFontFamily, "shared");
  assert.equal(bounded.reasoningTone, "original");
  assert.equal(bounded.reasoningItalic, false);
  const opposite = normalizeTypography({
    ...customized, reasoningFontSize: 99, reasoningLineHeight: -1, reasoningParagraphSpacing: -1,
  });
  assert.equal(opposite.reasoningFontSize, 24);
  assert.equal(opposite.reasoningLineHeight, 1.2);
  assert.equal(opposite.reasoningParagraphSpacing, 0);
  for (const invalid of [NaN, Infinity, -Infinity, "18", "", null, {}, true]) {
    assert.deepEqual(normalizeTypography({
      ...DEFAULT_TYPOGRAPHY, reasoningFontSize: invalid, reasoningLineHeight: invalid,
      reasoningParagraphSpacing: invalid,
    }), DEFAULT_TYPOGRAPHY);
  }
  assert.equal(normalizeTypography({ ...customized, reasoningLineHeight: 1.4567 }).reasoningLineHeight, 1.46);
});

test("reasoning choices persist locally, round-trip and reset with typography", () => {
  const store = new Map();
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  assert.equal(writeTypographyPreferences(storage, customized), "");
  assert.deepEqual(readTypographyPreferences(storage), { settings: customized, error: "" });
  assert.equal(JSON.parse(store.get(TYPOGRAPHY_STORAGE_KEY)).version, 1);
  assert.deepEqual(typographyPreset("default", customized), DEFAULT_TYPOGRAPHY);
  assert.deepEqual(typographyVariables(typographyPreset("default", customized)), {});
});

test("reasoning CSS is opt-in and scoped, preserves theme links and tables, and keeps code monospace", () => {
  const css = readFileSync(new URL("../src/typography.css", import.meta.url), "utf8");
  const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([_, selector]) => selector.includes("data-reasoning-typography"));
  assert.ok(blocks.length >= 7);
  for (const [, selectors, declarations] of blocks) {
    assert.match(selectors, /:root\[data-reasoning-typography="custom"\]/);
    assert.doesNotMatch(selectors, /\.message-content|\.composer|\.terminal|:is\(th|:is\(td|a:any-link/);
    if (declarations.includes("color:")) {
      assert.match(selectors, /\[data-reasoning-tone="(?:normal|muted)"\] \.reasoning-content\s*$/);
      assert.match(declarations, /color: var\(--(?:text|muted)\)/);
    }
  }
  assert.match(css, /\.reasoning-content code\s*\{[^}]*font-family: var\(--reasoning-code-font-family\);[^}]*font-style: normal/);
  assert.match(css, /data-reasoning-typography="custom"\] \.reasoning-content \.markdown-body > :last-child\s*\{\s*margin-bottom: 0/);
});
