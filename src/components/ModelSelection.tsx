import { useState } from "react";
import { Check, Cpu, Search } from "lucide-react";
import { labelModelValue, modelSelectionError, preferredModelOptions, selectModel, selectedModelOption, type ModelOption, type ModelSelectionValue } from "../lib/models";
import "./model-selection.css";

export function ModelSelection({ value, onChange, options, preferredModelId, allowEmpty = false, loading, error, disabled = false, onRefresh }: {
  value: ModelSelectionValue;
  onChange: (value: ModelSelectionValue) => void;
  options: ModelOption[];
  preferredModelId?: string;
  allowEmpty?: boolean;
  loading: boolean;
  error: string;
  disabled?: boolean;
  onRefresh: () => void;
}) {
  const [query, setQuery] = useState("");
  const selected = selectedModelOption(options, value.modelId);
  const choices = preferredModelOptions(options, preferredModelId);
  const needle = query.trim().toLowerCase();
  const visible = choices.filter((option) => `${option.id} ${option.name} ${option.description}`.toLowerCase().includes(needle));
  const unavailable = loading || disabled || !!error;
  const invalid = !loading && !error ? modelSelectionError(value, options, allowEmpty) : "";
  return <section className="model-selection" aria-label="Model selection" aria-busy={loading}>
    <div className="model-selection-toolbar">
      <label className="model-search"><Search size={15} aria-hidden="true" /><input aria-label="Search models"
        value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search models" disabled={disabled} /></label>
      <button type="button" disabled={disabled || loading} onClick={onRefresh}>{error ? "Retry models" : "Refresh models"}</button>
    </div>
    {loading && <p role="status">Loading models...</p>}
    {error && <p className="model-selection-error" role="alert">{error}</p>}
    {invalid && <p className="model-selection-error" role="alert">{invalid}</p>}
    <div className="model-selection-list" role="group" aria-label="Available models">
      {visible.map((option) => <button type="button" key={option.id} aria-label={`Select ${option.name}`}
        aria-pressed={value.modelId === option.id} disabled={unavailable || option.unavailable}
        className={`model-option${value.modelId === option.id ? " selected" : ""}`}
        onClick={() => onChange(selectModel(value, option))}>
        <Cpu size={16} aria-hidden="true" />
        <span><strong>{option.name}{option.id === preferredModelId && <em className="model-default-label">Default</em>}{option.unavailable ? " (unavailable)" : ""}</strong><small>{option.description}</small>
          {option.id && <code>{option.id}</code>}</span>
        {value.modelId === option.id && <Check size={16} aria-hidden="true" />}
      </button>)}
      {!loading && !error && !visible.length && <p>No matching models.</p>}
    </div>
    {value.modelId && <fieldset className="model-selection-configuration" disabled={unavailable}>
      <label>Reasoning effort<select aria-label="Reasoning effort" value={value.reasoningEffort}
        disabled={!value.reasoningEffort && !selected?.reasoningEfforts.length}
        onChange={(event) => onChange({ ...value, reasoningEffort: event.target.value })}>
        <option value="">Model default</option>
        {value.reasoningEffort && !selected?.reasoningEfforts.includes(value.reasoningEffort) &&
          <option value={value.reasoningEffort} disabled>{value.reasoningEffort} (unsupported)</option>}
        {selected?.reasoningEfforts.map((effort) => <option key={effort} value={effort}>{labelModelValue(effort)}</option>)}
      </select></label>
      <label>Visible reasoning<select aria-label="Visible reasoning" value={value.reasoningSummary}
        disabled={!!selected && !selected.reasoningEfforts.length}
        onChange={(event) => onChange({ ...value, reasoningSummary: event.target.value === "none" ? "none" : event.target.value === "concise" ? "concise" : "detailed" })}>
        <option value="detailed">Detailed</option><option value="concise">Concise</option><option value="none">Off</option>
      </select></label>
      <label>Context window<select aria-label="Context window" value={value.contextTier}
        disabled={!value.contextTier && !selected?.contextTiers.length}
        onChange={(event) => onChange({ ...value, contextTier: event.target.value })}>
        <option value="">Model default</option>
        {value.contextTier && !selected?.contextTiers.includes(value.contextTier) &&
          <option value={value.contextTier} disabled>{value.contextTier} (unsupported)</option>}
        {selected?.contextTiers.map((tier) => <option key={tier} value={tier}>{labelModelValue(tier)}</option>)}
      </select></label>
    </fieldset>}
  </section>;
}
