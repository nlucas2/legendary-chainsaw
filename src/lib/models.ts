import type { ReasoningSummary } from "./types.ts";

export interface ModelOption {
  id: string;
  name: string;
  description: string;
  unavailable: boolean;
  reasoningEfforts: string[];
  contextTiers: string[];
  defaultReasoningEffort?: string;
}

export function normalizeModelOptions(values: unknown[] | undefined): ModelOption[] {
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const model = value as Record<string, unknown>;
    const id =
      stringValue(model.id) ||
      stringValue(model.modelId) ||
      stringValue(model.model_id);
    if (!id) return [];
    const capabilities = objectValue(model.capabilities);
    const supports = objectValue(capabilities.supports);
    return [
      {
        id,
        name:
          stringValue(model.displayName) ||
          stringValue(model.display_name) ||
          stringValue(model.name) ||
          stringValue(model.modelName) ||
          stringValue(model.model_name) ||
          id,
        description:
          stringValue(model.description) ||
          stringValue(model.previewLabel) ||
          stringValue(model.preview_label) ||
          "Available to this session",
        unavailable:
          model.available === false ||
          model.enabled === false ||
          model.selectable === false ||
          model.model_picker_enabled === false,
        reasoningEfforts: stringArray(
          model.supportedReasoningEfforts ??
            model.supported_reasoning_efforts ??
            supports.reasoningEffort ??
            supports.reasoning_effort,
        ),
        contextTiers: contextTiers(model),
        defaultReasoningEffort:
          stringValue(model.defaultReasoningEffort) ||
          stringValue(model.default_reasoning_effort) ||
          undefined,
      },
    ];
  });
}

export function labelModelValue(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export interface ModelSelectionValue {
  modelId: string;
  reasoningEffort: string;
  reasoningSummary: ReasoningSummary;
  contextTier: string;
}

export const DEFAULT_MODEL_SELECTION: ModelSelectionValue = {
  modelId: "", reasoningEffort: "", reasoningSummary: "detailed", contextTier: "",
};

export function selectedModelOption(options: ModelOption[], modelId: string): ModelOption | undefined {
  return options.find((option) => option.id === modelId);
}

export function preferredModelOptions(options: ModelOption[], preferredModelId?: string): ModelOption[] {
  const preferred = options.find((option) => option.id === preferredModelId);
  return preferred ? [preferred, ...options.filter((option) => option.id !== preferredModelId)] : options;
}

export function selectModel(current: ModelSelectionValue, option: ModelOption): ModelSelectionValue {
  const reasoning = option.reasoningEfforts.length > 0;
  return {
    modelId: option.id,
    reasoningEffort: option.reasoningEfforts.includes(current.reasoningEffort) ? current.reasoningEffort
      : option.defaultReasoningEffort && option.reasoningEfforts.includes(option.defaultReasoningEffort) ? option.defaultReasoningEffort : "",
    reasoningSummary: reasoning ? current.reasoningSummary : "none",
    contextTier: option.contextTiers.includes(current.contextTier) ? current.contextTier : "",
  };
}

export function modelSelectionError(value: ModelSelectionValue, options: ModelOption[], allowEmpty: boolean): string {
  if (!value.modelId) return allowEmpty ? "" : "Choose a model.";
  const selected = selectedModelOption(options, value.modelId);
  if (!selected) return `Model "${value.modelId}" is not in the current catalog. Choose an available model.`;
  if (selected.unavailable) return `Model "${selected.name}" is unavailable. Choose an available model.`;
  if (value.reasoningEffort && !selected.reasoningEfforts.includes(value.reasoningEffort)) {
    return `Reasoning effort "${value.reasoningEffort}" is not supported by this model. Choose a supported value or Model default.`;
  }
  if (value.contextTier && !selected.contextTiers.includes(value.contextTier)) {
    return `Context window "${value.contextTier}" is not supported by this model. Choose a supported value or Model default.`;
  }
  return "";
}

export function modelSelectionSummary(value: ModelSelectionValue, options: ModelOption[] = []): string {
  if (!value.modelId) return "";
  const name = options.find((option) => option.id === value.modelId)?.name ?? value.modelId;
  return `${name} · Reasoning: ${value.reasoningEffort ? labelModelValue(value.reasoningEffort) : "model default"} · Summary: ${
    value.reasoningSummary === "none" ? "off" : value.reasoningSummary} · Context: ${value.contextTier ? labelModelValue(value.contextTier) : "model default"}`;
}

function contextTiers(model: Record<string, unknown>): string[] {
  const explicit = stringArray(
    model.supportedContextTiers ?? model.supported_context_tiers,
  ).filter(
    (tier) => tier !== "default",
  );
  if (explicit.length > 0) return explicit;

  const billing = objectValue(model.billing);
  const tokenPrices = objectValue(billing.tokenPrices ?? billing.token_prices);
  return objectValue(tokenPrices.longContext ?? tokenPrices.long_context) !== EMPTY_OBJECT
    ? ["long_context"]
    : [];
}

const EMPTY_OBJECT: Record<string, unknown> = {};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : EMPTY_OBJECT;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
