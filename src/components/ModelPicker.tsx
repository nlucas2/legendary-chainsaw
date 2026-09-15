import { useEffect, useMemo, useState } from "react";
import { Brain, Check, Cpu, Maximize2, Search, X } from "lucide-react";
import { daemonInvoke } from "../lib/daemon";
import {
  labelModelValue,
  normalizeModelOptions,
  type ModelOption,
} from "../lib/models";
import type { ModelInfo, ReasoningSummary } from "../lib/types";

interface ModelPickerProps {
  sessionId: string;
  onClose: () => void;
  onChanged: (modelId: string) => void;
}

export function ModelPicker({ sessionId, onClose, onChanged }: ModelPickerProps) {
  const [info, setInfo] = useState<ModelInfo | null>(null);
  const [query, setQuery] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [reasoningSummary, setReasoningSummary] =
    useState<ReasoningSummary>("detailed");
  const [contextTier, setContextTier] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void daemonInvoke<ModelInfo>("model_info", { sessionId })
      .then((next) => {
        setInfo(next);
        setSelectedModel(next.current.modelId ?? "");
        setReasoningEffort(next.current.reasoningEffort ?? "");
        setReasoningSummary(next.current.reasoningSummary ?? "detailed");
        setContextTier(next.current.contextTier ?? "");
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [sessionId]);

  const options = useMemo(
    () => normalizeModelOptions(info?.available.list),
    [info],
  );
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
    setReasoningSummary(model.reasoningEfforts.length > 0 ? "detailed" : "none");
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
          reasoningSummary,
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
                  {labelModelValue(effort)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>
              <Brain size={13} /> Visible summary
            </span>
            <select
              value={reasoningSummary}
              onChange={(event) =>
                setReasoningSummary(event.currentTarget.value as ReasoningSummary)
              }
              disabled={!selectedOption || selectedOption.reasoningEfforts.length === 0}
            >
              <option value="detailed">Detailed</option>
              <option value="concise">Concise</option>
              <option value="none">Off</option>
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
                  {labelModelValue(tier)}
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
