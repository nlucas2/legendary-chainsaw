import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TYPOGRAPHY,
  MONOSPACE_FONT_FAMILY,
  ORIGINAL_TERMINAL_FONT_FAMILY,
  SYSTEM_FONT_FAMILY,
  TYPOGRAPHY_STORAGE_KEY,
  chatFontFamily,
  normalizeTypography,
  parseTypographyPreferences,
  readTypographyPreferences,
  sanitizeCustomFontFamily,
  terminalTypography,
  typographyPreset,
  typographyVariables,
  writeTypographyPreferences,
} from "../src/lib/typography.ts";

test("absent, invalid, and unknown-schema preferences preserve original appearance", () => {
  for (const value of [null, undefined, [], "", false, 1, {}, { version: 2, fontSize: 20 }]) {
    assert.deepEqual(normalizeTypography(value), DEFAULT_TYPOGRAPHY);
  }
  assert.deepEqual(typographyVariables(DEFAULT_TYPOGRAPHY), {});
  assert.equal(chatFontFamily(DEFAULT_TYPOGRAPHY), SYSTEM_FONT_FAMILY);
  assert.deepEqual(terminalTypography(DEFAULT_TYPOGRAPHY), {
    fontFamily: ORIGINAL_TERMINAL_FONT_FAMILY, fontSize: 13, lineHeight: 1.18,
  });
  assert.deepEqual(typographyPreset("default"), DEFAULT_TYPOGRAPHY);
  assert.notEqual(typographyPreset("default"), DEFAULT_TYPOGRAPHY);
});

test("CLI-like is explicit, compact, and uses local monospace fallbacks", () => {
  const preset = typographyPreset("cli");
  assert.equal(preset.preset, "cli");
  assert.equal(chatFontFamily(preset), MONOSPACE_FONT_FAMILY);
  assert.equal(terminalTypography(preset).fontFamily, MONOSPACE_FONT_FAMILY);
  assert.equal(typographyVariables(preset)["--chat-font-size"], "14px");
  assert.equal(typographyVariables(preset)["--chat-line-height"], "1.4");
  assert.equal(typographyVariables(preset)["--chat-paragraph-spacing"], "6px");
  assert.equal(typographyVariables(preset)["--chat-turn-spacing"], "18px");
  assert.doesNotMatch(JSON.stringify(typographyVariables(preset)), /https?:|url\(/);
  assert.deepEqual(normalizeTypography(preset), preset);
});

test("each numeric preference is bounded and never coerces strings or non-finite values", () => {
  const normalized = normalizeTypography({
    ...DEFAULT_TYPOGRAPHY, fontSize: -100, lineHeight: 100, paragraphSpacing: 999,
    terminalFontSize: 999, terminalLineHeight: -1, ignored: "drop me",
  });
  assert.equal(normalized.fontSize, 12);
  assert.equal(normalized.lineHeight, 2.2);
  assert.equal(normalized.paragraphSpacing, 24);
  assert.equal(normalized.terminalFontSize, 24);
  assert.equal(normalized.terminalLineHeight, 1);
  assert.equal("ignored" in normalized, false);
  for (const invalid of [NaN, Infinity, -Infinity, "18", "", null, {}, true]) {
    const result = normalizeTypography({
      ...DEFAULT_TYPOGRAPHY, fontSize: invalid, lineHeight: invalid, paragraphSpacing: invalid,
      terminalFontSize: invalid, terminalLineHeight: invalid,
    });
    assert.deepEqual(result, DEFAULT_TYPOGRAPHY);
  }
  assert.deepEqual(normalizeTypography({
    ...DEFAULT_TYPOGRAPHY, preset: "bad", fontFamily: "bad", terminalFontFamily: "bad",
  }), DEFAULT_TYPOGRAPHY);
  assert.equal(normalizeTypography({ ...DEFAULT_TYPOGRAPHY, lineHeight: 1.4567 }).lineHeight, 1.46);
  assert.equal(normalizeTypography({ ...DEFAULT_TYPOGRAPHY, paragraphSpacing: -4 }).paragraphSpacing, 0);
});

test("custom local font names are safely quoted and CSS syntax is rejected", () => {
  const normalizedName = sanitizeCustomFontFamily(' "Cascadia Code" , \'Consolas\' ');
  assert.equal(normalizedName, "Cascadia Code, Consolas");
  assert.equal(sanitizeCustomFontFamily("ＭＳ ゴシック, Noto Sans"), "ＭＳ ゴシック, Noto Sans");
  const settings = { ...typographyPreset("cli"), fontFamily: "custom", customFontFamily: normalizedName };
  assert.equal(chatFontFamily(settings), `"Cascadia Code", "Consolas", ${SYSTEM_FONT_FAMILY}`);
  for (const invalid of [
    'serif; color:red', 'url("https://fonts.example/test")', "var(--font)", "x\nfont",
    '"unfinished', "font\\escape", "a,,b", "a,b,c,d,e,f,g", "x".repeat(201), null, 42,
  ]) {
    assert.equal(sanitizeCustomFontFamily(invalid), "");
    assert.equal(chatFontFamily({ ...settings, customFontFamily: invalid }), SYSTEM_FONT_FAMILY);
  }
  assert.equal(chatFontFamily({ ...settings, customFontFamily: "inherit" }), `"inherit", ${SYSTEM_FONT_FAMILY}`);
  assert.equal(normalizeTypography({ ...settings, customFontFamily: "Arial; color:red" }).customFontFamily, "");
});

test("terminal family, size and spacing remain independent unless sharing is selected", () => {
  const chatOnly = { ...DEFAULT_TYPOGRAPHY, preset: "custom", fontFamily: "mono", fontSize: 22, lineHeight: 2 };
  assert.deepEqual(terminalTypography(chatOnly), terminalTypography(DEFAULT_TYPOGRAPHY));
  const shared = { ...chatOnly, terminalFontFamily: "shared", terminalFontSize: 16, terminalLineHeight: 1.3 };
  assert.deepEqual(terminalTypography(shared), { fontFamily: MONOSPACE_FONT_FAMILY, fontSize: 16, lineHeight: 1.3 });
  assert.equal(terminalTypography({ ...shared, terminalFontFamily: "system" }).fontFamily, SYSTEM_FONT_FAMILY);
  assert.equal(terminalTypography({
    ...shared, terminalFontFamily: "custom", terminalCustomFontFamily: "Iosevka Term",
  }).fontFamily, `"Iosevka Term", ${MONOSPACE_FONT_FAMILY}`);
  assert.deepEqual(typographyVariables({ ...DEFAULT_TYPOGRAPHY, terminalFontSize: 20 }), {});
});

test("persisted preferences round-trip validated known keys without changing defaults", () => {
  const store = new Map();
  const storage = {
    getItem(key) { return store.get(key) ?? null; },
    setItem(key, value) { store.set(key, value); },
  };
  assert.deepEqual(readTypographyPreferences(storage), { settings: DEFAULT_TYPOGRAPHY, error: "" });
  assert.equal(writeTypographyPreferences(storage, { ...typographyPreset("cli"), unknown: true }), "");
  assert.deepEqual(readTypographyPreferences(storage), { settings: typographyPreset("cli"), error: "" });
  assert.equal(JSON.parse(store.get(TYPOGRAPHY_STORAGE_KEY)).unknown, undefined);
  assert.deepEqual(parseTypographyPreferences(null), { settings: DEFAULT_TYPOGRAPHY, error: "" });
  assert.deepEqual(parseTypographyPreferences('{"version":99}').settings, DEFAULT_TYPOGRAPHY);
  assert.deepEqual(parseTypographyPreferences("{broken").settings, DEFAULT_TYPOGRAPHY);
  assert.match(parseTypographyPreferences("{broken").error, /Could not load typography/);
});

test("storage permission and quota failures are returned for visible UI feedback", () => {
  const storage = {
    getItem() { throw new Error("storage access denied"); },
    setItem() { throw new Error("quota exceeded"); },
  };
  const result = readTypographyPreferences(storage);
  assert.deepEqual(result.settings, DEFAULT_TYPOGRAPHY);
  assert.match(result.error, /Could not load typography: Error: storage access denied/);
  assert.match(writeTypographyPreferences(storage, typographyPreset("cli")), /quota exceeded.*only to this window/);
});
