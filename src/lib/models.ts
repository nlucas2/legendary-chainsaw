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
    if (!id || id.toLowerCase() === "auto") return [];
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

export function aggregateModelConfiguration(options: ModelOption[]): ModelOption {
  return {
    id: "auto",
    name: "Auto",
    description: "Copilot chooses a compatible model",
    unavailable: false,
    reasoningEfforts: [
      ...new Set(options.flatMap((option) => option.reasoningEfforts)),
    ],
    contextTiers: [
      ...new Set(options.flatMap((option) => option.contextTiers)),
    ],
  };
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
