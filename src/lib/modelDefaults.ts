import { DEFAULT_MODEL_SELECTION, type ModelSelectionValue } from "./models.ts";

export const MODEL_DEFAULTS_KEY = "copilot-sessions.new-session-model";

export function readModelDefaults(raw: string | null): { value: ModelSelectionValue; error: string } {
  if (raw === null) return { value: { ...DEFAULT_MODEL_SELECTION }, error: "" };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !("version" in parsed) || parsed.version !== 1 ||
        !("selection" in parsed) || !parsed.selection || typeof parsed.selection !== "object") {
      throw new Error("Invalid model preference format.");
    }
    const value = parsed.selection;
    if (!("modelId" in value) || typeof value.modelId !== "string" ||
        !("reasoningEffort" in value) || typeof value.reasoningEffort !== "string" ||
        !("contextTier" in value) || typeof value.contextTier !== "string" ||
        !("reasoningSummary" in value) || typeof value.reasoningSummary !== "string" || !["none", "concise", "detailed"].includes(value.reasoningSummary) ||
        [value.modelId, value.reasoningEffort, value.contextTier].some((text) => text.length > 256 || /[\r\n\0]/.test(text))) {
      throw new Error("Invalid model preference values.");
    }
    return { value: { modelId: value.modelId, reasoningEffort: value.reasoningEffort, contextTier: value.contextTier,
      reasoningSummary: value.reasoningSummary === "none" ? "none" : value.reasoningSummary === "concise" ? "concise" : "detailed" }, error: "" };
  } catch (cause) {
    return { value: { ...DEFAULT_MODEL_SELECTION }, error: `Could not load the new-session model default: ${String(cause)}. Choose a model or reset the default in Settings.` };
  }
}
