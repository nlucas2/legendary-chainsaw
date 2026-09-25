import { useEffect, useId, useRef } from "react";
import { X, type LucideIcon } from "lucide-react";
import "./workspace-options.css";

export interface WorkspaceOption {
  label: string;
  description: string;
  icon: LucideIcon;
  disabledReason?: string;
  onSelect: () => void;
}

export function WorkspaceOptions({ actions, diagnostics, diagnosticsDisabled, onDiagnosticsChange, onClose }: {
  actions: WorkspaceOption[];
  diagnostics: boolean;
  diagnosticsDisabled: boolean;
  onDiagnosticsChange: (enabled: boolean) => void;
  onClose: () => void;
}) {
  const root = useRef<HTMLElement>(null);
  const id = useId();
  useEffect(() => {
    const previous = document.activeElement;
    const panel = root.current;
    panel?.querySelector<HTMLButtonElement>("header button")?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected &&
          (document.activeElement === document.body || panel?.contains(document.activeElement))) previous.focus();
    };
  }, []);

  return <div className="workspace-options-backdrop" onClick={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section ref={root} className="workspace-options-panel" role="dialog" aria-modal="true"
      aria-label="Additional options" onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); onClose(); }
        if (event.key === "Tab") {
          const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input:not(:disabled),summary",
          )).filter((element) => {
            const collapsed = element.closest("details:not([open])");
            return element.getClientRects().length > 0 &&
              (!collapsed || (element.tagName === "SUMMARY" && element.parentElement === collapsed));
          });
          if (event.shiftKey && document.activeElement === controls[0]) {
            event.preventDefault(); controls[controls.length - 1]?.focus();
          } else if (!event.shiftKey && document.activeElement === controls[controls.length - 1]) {
            event.preventDefault(); controls[0]?.focus();
          }
        }
      }}>
      <header><h2>Additional options</h2><button type="button" className="icon-button"
        aria-label="Close additional options" onClick={onClose}><X size={18} /></button></header>
      <div className="workspace-options-content">
        <p>Conversation actions and app settings. Context, Git, and Terminal stay on the toolbar.</p>
        {actions.map((action, index) => {
          const Icon = action.icon;
          return <button type="button" className="workspace-option" key={action.label}
            aria-label={action.label} aria-describedby={`${id}-${index}`} disabled={!!action.disabledReason}
            onClick={() => { onClose(); action.onSelect(); }}>
            <Icon size={19} aria-hidden="true" />
            <span><strong>{action.label}</strong>
              <small id={`${id}-${index}`}>{action.description}{action.disabledReason && <em>{action.disabledReason}</em>}</small>
            </span>
          </button>;
        })}
        <details className="workspace-options-advanced">
          <summary>Advanced{diagnostics && <span>Raw diagnostics on</span>}</summary>
          <label className="workspace-diagnostics-option">
            <input type="checkbox" checked={diagnostics} disabled={diagnosticsDisabled}
              aria-label="Raw diagnostics" aria-describedby={`${id}-diagnostics`}
              onChange={(event) => onDiagnosticsChange(event.target.checked)} />
            <span><strong>Raw diagnostics <b>{diagnostics ? "On" : "Off"}</b></strong>
              <small id={`${id}-diagnostics`}>Show the latest 100 live session events as JSON, including extra model, cache, and streaming telemetry. Adds browser traffic; model request/response bodies are omitted. Normal chat streaming and Context usage work with this off.</small>
            </span>
          </label>
        </details>
      </div>
    </section>
  </div>;
}
