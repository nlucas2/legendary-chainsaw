import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { daemonInvoke } from "../lib/daemon";
import { DEFAULT_MODEL_SELECTION, modelSelectionError } from "../lib/models";
import { useModelCatalog } from "../lib/useModelCatalog";
import { ModelSelection } from "./ModelSelection";

interface ModelPickerProps {
  sessionId: string;
  preferredModelId?: string;
  onClose: () => void;
  onChanged: (modelId: string) => void;
}

export function ModelPicker(props: ModelPickerProps) {
  return <SessionModelPicker key={props.sessionId} {...props} />;
}

function SessionModelPicker({ sessionId, preferredModelId, onClose, onChanged }: ModelPickerProps) {
  const catalog = useModelCatalog(true, sessionId);
  const [value, setValue] = useState(DEFAULT_MODEL_SELECTION);
  const initialized = useRef(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (catalog.current && !initialized.current) {
      setValue(catalog.current);
      initialized.current = true;
    }
  }, [catalog.current]);
  useEffect(() => {
    const previous = document.activeElement;
    root.current?.querySelector<HTMLButtonElement>("header button")?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => { if (busy) root.current?.focus(); }, [busy]);
  const invalid = modelSelectionError(value, catalog.options, false);

  async function apply() {
    if (pending.current || catalog.loading || catalog.error || invalid) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = await daemonInvoke<{ modelId?: string; message?: string; status?: string; deferred?: boolean; persistenceError?: string }>(
        "switch_model", { sessionId, modelId: value.modelId, reasoningEffort: value.reasoningEffort || null,
          reasoningSummary: value.reasoningSummary, contextTier: value.contextTier || null },
      );
      if (result.deferred || result.status === "confirmation_required") {
        setNotice(result.message || (result.deferred ? "The runtime queued the model change; the active model has not changed yet."
          : "The runtime requires confirmation before changing this model."));
        return;
      }
      if (result.status && !["applied", "success", "switched"].includes(result.status)) {
        throw new Error(result.message || `Model change was not applied (${result.status}).`);
      }
      if (!result.modelId) throw new Error("The runtime did not confirm the selected model. Refresh the catalog to read the current configuration.");
      onChanged(result.modelId);
      if (result.persistenceError) { setError(`Model changed, but the runtime could not save it: ${result.persistenceError}`); return; }
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { pending.current = false; setBusy(false); }
  }

  return <div className="model-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !busy) onClose();
  }}>
    <section ref={root} tabIndex={-1} className="model-picker unified-model-picker" role="dialog" aria-modal="true" aria-label="Choose model"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); if (!busy) onClose(); }
        if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled)"))
            .filter((element) => !element.matches(":disabled") && element.getClientRects().length > 0);
          if (!controls.length) { event.preventDefault(); return; }
          if (event.shiftKey && (document.activeElement === controls[0] || document.activeElement === root.current)) { event.preventDefault(); controls[controls.length - 1]?.focus(); }
          else if (!event.shiftKey && document.activeElement === controls[controls.length - 1]) { event.preventDefault(); controls[0]?.focus(); }
        }
      }}>
      <header><div><span>Session model</span><h2>Choose a model</h2></div>
        <button type="button" className="icon-button" disabled={busy} onClick={onClose} aria-label="Close models"><X size={18} /></button></header>
      <div className="model-picker-content">
        <ModelSelection value={value} onChange={setValue} options={catalog.options} preferredModelId={preferredModelId}
          loading={catalog.loading} error={catalog.error} disabled={busy} onRefresh={catalog.refresh} />
        {error && <p role="alert" className="model-selection-error">{error}</p>}
        {notice && <p role="status">{notice}</p>}
      </div>
      <footer><span>Current: <strong>{catalog.current?.modelId || "Loading..."}</strong></span>
        <div><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="button primary" disabled={busy || catalog.loading || !!catalog.error || !!invalid}
            onClick={() => void apply()}>{busy ? "Applying..." : "Apply"}</button></div>
      </footer>
    </section>
  </div>;
}
