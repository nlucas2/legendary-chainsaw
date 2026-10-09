import { useEffect, useState } from "react";
import { DEFAULT_MODEL_SELECTION, modelSelectionError, modelSelectionSummary } from "../lib/models";
import { useModelCatalog } from "../lib/useModelCatalog";
import type { ModelDefaultsController } from "../lib/useModelDefaults";
import { ModelSelection } from "./ModelSelection";

export function ModelDefaultsSettings({ defaults }: { defaults: ModelDefaultsController }) {
  const [open, setOpen] = useState(false);
  return <div className="settings-section">
    <details className="model-selection-disclosure" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary><strong>Default model for new sessions</strong>{defaults.value.modelId && <span>{modelSelectionSummary(defaults.value)}</span>}</summary>
      {open && <DefaultEditor defaults={defaults} />}
    </details>
    {!open && defaults.error && <p role="alert" className="model-selection-error">{defaults.error}</p>}
  </div>;
}

function DefaultEditor({ defaults }: { defaults: ModelDefaultsController }) {
  const catalog = useModelCatalog(true);
  const [value, setValue] = useState(defaults.value);
  const [notice, setNotice] = useState("");
  useEffect(() => { setValue(defaults.value); }, [defaults.value]);
  const invalid = modelSelectionError(value, catalog.options, false);
  return <>
    <p>Used the next time you open New session in this browser or desktop installation. Existing sessions, profiles, and scheduled tasks are not changed.</p>
    <ModelSelection value={value} onChange={(next) => { setValue(next); setNotice(""); }} options={catalog.options}
      preferredModelId={defaults.value.modelId} allowEmpty loading={catalog.loading} error={catalog.error} onRefresh={catalog.refresh} />
    {defaults.error && <p role="alert" className="model-selection-error">{defaults.error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="model-default-actions">
      <button type="button" disabled={catalog.loading || !!catalog.error || !!invalid} onClick={() => {
        if (defaults.save(value)) setNotice("Default saved. Existing sessions were not changed.");
      }}>Save new-session default</button>
      <button type="button" onClick={() => {
        if (defaults.reset()) { setValue({ ...DEFAULT_MODEL_SELECTION }); setNotice("Default cleared."); }
      }}>Clear default</button>
    </div>
  </>;
}
