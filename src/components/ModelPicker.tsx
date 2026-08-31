import { useEffect, useMemo, useState } from "react";
import { Brain, Check, Cpu, Maximize2, Search, X } from "lucide-react";
import { daemonInvoke } from "../lib/daemon";
import type { ModelInfo } from "../lib/types";

interface ModelPickerProps {
  sessionId: string;
  onClose: () => void;
  onChanged: (modelId: string) => void;
}

interface ModelOption {
  id: string;
  name: string;
  description: string;
  unavailable: boolean;
  reasoningEfforts: string[];
  contextTiers: string[];
  defaultReasoningEffort?: string;
}

export function ModelPicker({ sessionId, onClose, onChanged }: ModelPickerProps) {
  const [info, setInfo] = useState<ModelInfo | null>(null);
  const [query, setQuery] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [contextTier, setContextTier] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void daemonInvoke<ModelInfo>("model_info", { sessionId })
      .then((next) => {
        setInfo(next);
        setSelectedModel(next.current.modelId ?? "");
        setReasoningEffort(next.current.reasoningEffort ?? "");
        setContextTier(next.current.contextTier ?? "");
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [sessionId]);

  const options = useMemo(() => normalizeModels(info), [info]);
  const visible = options.filter((model) => {
    const needle = query.trim().toLowerCase();
    return (
      !needle ||
      model.id.toLowerCase().includes(needle) ||
      model.name.toLowerCase().includes(needle) ||
      model.description.toLowerCase().includes(needle)
    );
  });
  const selectedOption = options.find((model) => model.id === selectedModel);

  function select(model: ModelOption) {
    setSelectedModel(model.id);
    setReasoningEffort((current) =>
      current && model.reasoningEfforts.includes(current)
        ? current
        : model.defaultReasoningEffort ?? "",
    );
    setContextTier((current) =>
      current && model.contextTiers.includes(current) ? current : "",
    );
  }

  async function apply() {
    if (!selectedModel || selectedOption?.unavailable) return;
    setBusy(true);
    setError("");
    try {
      const result = await daemonInvoke<{ modelId?: string; message?: string }>(
        "switch_model",
        {
          sessionId,
          modelId: selectedModel,
          reasoningEffort: reasoningEffort || null,
          contextTier: contextTier || null,
        },
      );
      onChanged(result.modelId || selectedModel);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="model-backdrop" onMouseDown={onClose}>
      <section
        className="model-picker"
        aria-label="Choose model"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span>Session model</span>
            <h2>Choose a model</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close models">
            <X size={18} />
          </button>
        </header>
        <label className="model-search">
          <Search size={15} />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search available models"
          />
        </label>
        <div className="model-list">
          {!info && !error && <div className="model-placeholder">Resolving models…</div>}
          {visible.map((model) => {
            const selected = selectedModel === model.id;
            return (
              <button
                key={model.id}
                disabled={busy || model.unavailable}
                className={selected ? "model-option selected" : "model-option"}
                onClick={() => select(model)}
              >
                <span className="model-icon">
                  <Cpu size={15} />
                </span>
                <span>
                  <strong>{model.name}</strong>
                  <small>{model.description}</small>
                  <code>{model.id}</code>
                </span>
                {selected && <Check size={16} />}
              </button>
            );
          })}
          {info && visible.length === 0 && (
            <div className="model-placeholder">No matching models.</div>
          )}
          {error && <div className="model-error">{error}</div>}
        </div>
        <div className="model-configuration">
          <label>
            <span>
              <Brain size={13} /> Reasoning
            </span>
            <select
              value={reasoningEffort}
              onChange={(event) => setReasoningEffort(event.currentTarget.value)}
              disabled={!selectedOption || selectedOption.reasoningEfforts.length === 0}
            >
              <option value="">Model default</option>
              {selectedOption?.reasoningEfforts.map((effort) => (
                <option value={effort} key={effort}>
                  {labelValue(effort)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>
              <Maximize2 size={13} /> Context
            </span>
            <select
              value={contextTier}
              onChange={(event) => setContextTier(event.currentTarget.value)}
              disabled={!selectedOption || selectedOption.contextTiers.length === 0}
            >
              <option value="">Model default</option>
              {selectedOption?.contextTiers.map((tier) => (
                <option value={tier} key={tier}>
                  {labelValue(tier)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <footer>
          <span>
            Current: <strong>{info?.current.modelId || "resolving…"}</strong>
          </span>
          <div>
            <button className="button secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              className="button primary"
              disabled={busy || !selectedModel}
              onClick={() => void apply()}
            >
              {busy ? <i className="model-spinner" /> : null}
              Apply
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function normalizeModels(info: ModelInfo | null): ModelOption[] {
  if (!info || !Array.isArray(info.available.list)) return [];
  return info.available.list.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const model = value as Record<string, unknown>;
    const id = stringValue(model.id) || stringValue(model.modelId);
    if (!id) return [];
    return [
      {
        id,
        name:
          stringValue(model.displayName) ||
          stringValue(model.name) ||
          stringValue(model.modelName) ||
          id,
        description:
          stringValue(model.description) ||
          stringValue(model.previewLabel) ||
          "Available to this session",
        unavailable:
          model.available === false || model.enabled === false || model.selectable === false,
        reasoningEfforts: stringArray(model.supportedReasoningEfforts),
        contextTiers: stringArray(model.supportedContextTiers),
        defaultReasoningEffort: stringValue(model.defaultReasoningEffort) || undefined,
      },
    ];
  });
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function labelValue(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
