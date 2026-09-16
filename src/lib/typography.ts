export const TYPOGRAPHY_STORAGE_KEY = "copilot-sessions.typography";
export const SYSTEM_FONT_FAMILY =
  'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
export const MONOSPACE_FONT_FAMILY =
  '"Cascadia Code", "Cascadia Mono", Consolas, "SFMono-Regular", "Liberation Mono", monospace';
export const ORIGINAL_TERMINAL_FONT_FAMILY =
  "'Cascadia Code', 'SFMono-Regular', Consolas, monospace";

export type ChatFontFamily = "system" | "mono" | "custom";
export type TerminalFontFamily = ChatFontFamily | "default" | "shared";
export type ReasoningFontFamily = ChatFontFamily | "shared";
export type ReasoningTone = "original" | "normal" | "muted";
export interface TypographySettings {
  version: 1;
  preset: "default" | "cli" | "custom";
  fontFamily: ChatFontFamily;
  customFontFamily: string;
  fontSize: number;
  lineHeight: number;
  paragraphSpacing: number;
  reasoningCustom: boolean;
  reasoningFontFamily: ReasoningFontFamily;
  reasoningCustomFontFamily: string;
  reasoningFontSize: number;
  reasoningLineHeight: number;
  reasoningParagraphSpacing: number;
  reasoningItalic: boolean;
  reasoningTone: ReasoningTone;
  terminalFontFamily: TerminalFontFamily;
  terminalCustomFontFamily: string;
  terminalFontSize: number;
  terminalLineHeight: number;
}

export const TYPOGRAPHY_LIMITS = {
  fontSize: { min: 12, max: 24, step: 1 },
  lineHeight: { min: 1.2, max: 2.2, step: 0.05 },
  paragraphSpacing: { min: 0, max: 24, step: 1 },
  reasoningFontSize: { min: 12, max: 24, step: 1 },
  reasoningLineHeight: { min: 1.2, max: 2.2, step: 0.01 },
  reasoningParagraphSpacing: { min: 0, max: 24, step: 1 },
  terminalFontSize: { min: 10, max: 24, step: 1 },
  terminalLineHeight: { min: 1, max: 1.8, step: 0.01 },
} as const;

export const DEFAULT_TYPOGRAPHY: Readonly<TypographySettings> = Object.freeze({
  version: 1,
  preset: "default",
  fontFamily: "system",
  customFontFamily: "",
  fontSize: 15,
  lineHeight: 1.7,
  paragraphSpacing: 12,
  reasoningCustom: false,
  reasoningFontFamily: "shared",
  reasoningCustomFontFamily: "",
  reasoningFontSize: 14,
  reasoningLineHeight: 1.68,
  reasoningParagraphSpacing: 9,
  reasoningItalic: false,
  reasoningTone: "original",
  terminalFontFamily: "default",
  terminalCustomFontFamily: "",
  terminalFontSize: 13,
  terminalLineHeight: 1.18,
});

export function typographyPreset(
  preset: "default" | "cli",
  current: Readonly<TypographySettings> = DEFAULT_TYPOGRAPHY,
): TypographySettings {
  return preset === "cli"
    ? {
        ...DEFAULT_TYPOGRAPHY,
        preset: "cli",
        fontFamily: "mono",
        fontSize: 14,
        lineHeight: 1.4,
        paragraphSpacing: 6,
        terminalFontFamily: "mono",
        terminalLineHeight: 1.1,
        reasoningCustom: current.reasoningCustom,
        reasoningFontFamily: current.reasoningFontFamily,
        reasoningCustomFontFamily: current.reasoningCustomFontFamily,
        reasoningFontSize: current.reasoningFontSize,
        reasoningLineHeight: current.reasoningLineHeight,
        reasoningParagraphSpacing: current.reasoningParagraphSpacing,
        reasoningItalic: current.reasoningItalic,
        reasoningTone: current.reasoningTone,
      }
    : { ...DEFAULT_TYPOGRAPHY };
}

// Accept local family names, not arbitrary CSS (URLs, declarations or variables).
export function sanitizeCustomFontFamily(value: unknown): string {
  if (typeof value !== "string" || value.length > 200) return "";
  const families = value.trim().split(",");
  if (families.length > 6) return "";
  const names = families.map((family) => {
    let name = family.trim();
    if (/^(['"]).*\1$/u.test(name)) name = name.slice(1, -1).trim();
    return /^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u.test(name) ? name : "";
  });
  return names.every(Boolean) ? names.join(", ") : "";
}

function bounded(value: unknown, key: keyof typeof TYPOGRAPHY_LIMITS): number {
  const { min, max } = TYPOGRAPHY_LIMITS[key];
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(Math.min(max, Math.max(min, value)) * 100) / 100
    : DEFAULT_TYPOGRAPHY[key];
}

function oneOf<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  return choices.includes(value as T) ? (value as T) : fallback;
}

export function normalizeTypography(value: unknown): TypographySettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_TYPOGRAPHY };
  }
  const saved = value as Record<string, unknown>;
  if (saved.version !== 1) return { ...DEFAULT_TYPOGRAPHY };
  return {
    version: 1,
    preset: oneOf(saved.preset, ["default", "cli", "custom"], "default"),
    fontFamily: oneOf(saved.fontFamily, ["system", "mono", "custom"], "system"),
    customFontFamily: sanitizeCustomFontFamily(saved.customFontFamily),
    fontSize: bounded(saved.fontSize, "fontSize"),
    lineHeight: bounded(saved.lineHeight, "lineHeight"),
    paragraphSpacing: bounded(saved.paragraphSpacing, "paragraphSpacing"),
    reasoningCustom: saved.reasoningCustom === true,
    reasoningFontFamily: oneOf(saved.reasoningFontFamily, ["shared", "system", "mono", "custom"], "shared"),
    reasoningCustomFontFamily: sanitizeCustomFontFamily(saved.reasoningCustomFontFamily),
    reasoningFontSize: bounded(saved.reasoningFontSize, "reasoningFontSize"),
    reasoningLineHeight: bounded(saved.reasoningLineHeight, "reasoningLineHeight"),
    reasoningParagraphSpacing: bounded(saved.reasoningParagraphSpacing, "reasoningParagraphSpacing"),
    reasoningItalic: saved.reasoningItalic === true,
    reasoningTone: oneOf(saved.reasoningTone, ["original", "normal", "muted"], "original"),
    terminalFontFamily: oneOf(
      saved.terminalFontFamily, ["default", "system", "mono", "custom", "shared"], "default",
    ),
    terminalCustomFontFamily: sanitizeCustomFontFamily(saved.terminalCustomFontFamily),
    terminalFontSize: bounded(saved.terminalFontSize, "terminalFontSize"),
    terminalLineHeight: bounded(saved.terminalLineHeight, "terminalLineHeight"),
  };
}

function customFamily(value: string, fallback: string): string {
  const names = sanitizeCustomFontFamily(value);
  return names ? `${names.split(", ").map((name) => `"${name}"`).join(", ")}, ${fallback}` : fallback;
}

export function chatFontFamily(settings: TypographySettings): string {
  if (settings.preset === "default" || settings.fontFamily === "system") return SYSTEM_FONT_FAMILY;
  return settings.fontFamily === "mono"
    ? MONOSPACE_FONT_FAMILY
    : customFamily(settings.customFontFamily, SYSTEM_FONT_FAMILY);
}

export function terminalTypography(settings: TypographySettings) {
  let fontFamily = ORIGINAL_TERMINAL_FONT_FAMILY;
  switch (settings.terminalFontFamily) {
    case "system": fontFamily = SYSTEM_FONT_FAMILY; break;
    case "mono": fontFamily = MONOSPACE_FONT_FAMILY; break;
    case "shared": fontFamily = chatFontFamily(settings); break;
    case "custom": fontFamily = customFamily(settings.terminalCustomFontFamily, MONOSPACE_FONT_FAMILY); break;
  }
  return { fontFamily, fontSize: settings.terminalFontSize, lineHeight: settings.terminalLineHeight };
}

export function reasoningTypography(settings: TypographySettings) {
  let fontFamily = chatFontFamily(settings);
  switch (settings.reasoningFontFamily) {
    case "system": fontFamily = SYSTEM_FONT_FAMILY; break;
    case "mono": fontFamily = MONOSPACE_FONT_FAMILY; break;
    case "custom": fontFamily = customFamily(settings.reasoningCustomFontFamily, SYSTEM_FONT_FAMILY); break;
  }
  return {
    fontFamily,
    fontSize: settings.reasoningFontSize,
    lineHeight: settings.reasoningLineHeight,
    paragraphSpacing: settings.reasoningParagraphSpacing,
    fontStyle: settings.reasoningItalic ? "italic" : "normal",
  } as const;
}

export function typographyAttributes(settings: TypographySettings): Record<string, string> {
  const attributes: Record<string, string> = {};
  if (settings.preset !== "default") attributes["data-typography"] = "custom";
  if (settings.reasoningCustom) {
    attributes["data-reasoning-typography"] = "custom";
    if (settings.reasoningTone !== "original") attributes["data-reasoning-tone"] = settings.reasoningTone;
  }
  return attributes;
}

export function typographyVariables(settings: TypographySettings): Record<string, string> {
  const variables: Record<string, string> = settings.preset === "default" ? {} : {
    "--chat-font-family": chatFontFamily(settings),
    "--chat-code-font-family": MONOSPACE_FONT_FAMILY,
    "--chat-font-size": `${settings.fontSize}px`,
    "--chat-line-height": String(settings.lineHeight),
    "--chat-paragraph-spacing": `${settings.paragraphSpacing}px`,
    "--chat-turn-spacing": `${settings.paragraphSpacing + 12}px`,
  };
  if (settings.reasoningCustom) {
    const reasoning = reasoningTypography(settings);
    Object.assign(variables, {
      "--reasoning-font-family": reasoning.fontFamily,
      "--reasoning-code-font-family": MONOSPACE_FONT_FAMILY,
      "--reasoning-font-size": `${reasoning.fontSize}px`,
      "--reasoning-line-height": String(reasoning.lineHeight),
      "--reasoning-paragraph-spacing": `${reasoning.paragraphSpacing}px`,
      "--reasoning-font-style": reasoning.fontStyle,
    });
  }
  return variables;
}

export interface TypographyLoadResult {
  settings: TypographySettings;
  error: string;
}

export function parseTypographyPreferences(raw: string | null): TypographyLoadResult {
  try {
    return { settings: normalizeTypography(raw === null ? null : JSON.parse(raw)), error: "" };
  } catch {
    return { settings: { ...DEFAULT_TYPOGRAPHY }, error: "Could not load typography: saved preferences are not valid JSON." };
  }
}

export function readTypographyPreferences(storage: Pick<Storage, "getItem">): TypographyLoadResult {
  try {
    return parseTypographyPreferences(storage.getItem(TYPOGRAPHY_STORAGE_KEY));
  } catch (cause) {
    return { settings: { ...DEFAULT_TYPOGRAPHY }, error: `Could not load typography: ${String(cause)}` };
  }
}

export function writeTypographyPreferences(
  storage: Pick<Storage, "setItem">,
  settings: TypographySettings,
): string {
  try {
    storage.setItem(TYPOGRAPHY_STORAGE_KEY, JSON.stringify(normalizeTypography(settings)));
    return "";
  } catch (cause) {
    return `Could not save typography: ${String(cause)}. Changes apply only to this window.`;
  }
}
