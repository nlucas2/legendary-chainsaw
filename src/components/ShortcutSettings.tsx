import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { actionBindings, binding, bindingWarning, eventBinding, formatBinding, SHORTCUT_ACTIONS, type KeyBinding, type ShortcutAction } from "../lib/keybindings";
import type { KeybindingsController } from "../lib/useKeybindings";
import "./shortcut-settings.css";

export function ShortcutSettings({ controller, onClose }: { controller: KeybindingsController; onClose: () => void }) {
  const root = useRef<HTMLElement>(null);
  const recorder = useRef<HTMLDivElement>(null);
  const recordingTrigger = useRef<HTMLElement | null>(null);
  const [recording, setRecording] = useState<{ action: ShortcutAction; add: boolean } | null>(null);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const previous = document.activeElement;
    const panel = root.current;
    panel?.querySelector<HTMLButtonElement>("header button")?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected &&
          (document.activeElement === document.body || panel?.contains(document.activeElement))) previous.focus();
    };
  }, []);
  useEffect(() => {
    if (recording) recorder.current?.focus();
    else if (recordingTrigger.current) {
      if (recordingTrigger.current.isConnected) recordingTrigger.current.focus();
      recordingTrigger.current = null;
    }
  }, [recording]);

  function startRecording(action: ShortcutAction, add: boolean) {
    recordingTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setNotice("");
    setRecording({ action, add });
  }

  function capture(key: KeyBinding) {
    if (!recording) return;
    const keys = recording.add ? [...actionBindings(controller.overrides, recording.action), key] : [key];
    if (controller.setBindings(recording.action, keys)) {
      setNotice(`Saved ${SHORTCUT_ACTIONS.find((action) => action.id === recording.action)!.label}: ${keys.map(formatBinding).join(" / ")}`);
      setRecording(null);
    }
  }
  const actions = SHORTCUT_ACTIONS.filter((action) =>
    `${action.label} ${action.description} ${action.group}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="shortcut-settings-backdrop">
    <section ref={root} className="shortcut-settings-panel" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          if (recording) setRecording(null); else onClose();
          return;
        }
        if (recording && event.target === recorder.current) {
          event.preventDefault();
          if (!event.repeat) {
            const key = eventBinding(event.nativeEvent);
            if (key) capture(key);
          }
          return;
        }
        if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input:not(:disabled),[tabindex='0']",
          )).filter((element) => element.getClientRects().length > 0);
          if (event.shiftKey && document.activeElement === controls[0]) {
            event.preventDefault(); controls[controls.length - 1]?.focus();
          } else if (!event.shiftKey && document.activeElement === controls[controls.length - 1]) {
            event.preventDefault(); controls[0]?.focus();
          }
        }
      }}>
      <header><h2>Keyboard shortcuts</h2><button type="button" className="icon-button" aria-label="Close" onClick={onClose}><X size={18} /></button></header>
      <div className="shortcut-settings-content">
        <p>Saved for this browser or desktop installation. <strong>Clear</strong> means Unbound, even after restarting. <strong>Reset</strong> restores defaults.</p>
        <p>Dialog Escape/Tab, Enter-to-open previews, plain Enter/Shift Enter, and ordinary caret movement are not app shortcuts.
          Terminal Ctrl C / Cmd C copy selected text; Ctrl C without a selection interrupts the shell.
          Ctrl Tab is desktop-only; the web app never handles it.</p>
        <label className="shortcut-search">Search shortcuts<input value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        {controller.error && <p className="shortcut-error" role="alert">{controller.error}</p>}
        {notice && <p role="status">{notice}</p>}
        {recording && <div className="shortcut-recorder" role="group" aria-label="Record shortcut">
          <div ref={recorder} tabIndex={0} role="textbox" aria-readonly="true" aria-label="Press shortcut keys">
            Press a combination for <strong>{SHORTCUT_ACTIONS.find((action) => action.id === recording.action)!.label}</strong>.
            Escape cancels; no action runs while recording.
          </div>
          <button type="button" onClick={() => capture(binding("Escape"))}>Use Escape</button>
          <button type="button" onClick={() => setRecording(null)}>Cancel recording</button>
        </div>}
        {actions.map((action) => {
          const keys = actionBindings(controller.overrides, action.id);
          return <section className="shortcut-setting" key={action.id} aria-label={action.label}>
            <div><strong>{action.label}</strong><small>{action.description}</small></div>
            <div className="shortcut-binding-list">
              {keys.length ? keys.map((key, index) => <span className="shortcut-binding" key={index}>
                <kbd>{formatBinding(key)}</kbd>
                <button type="button" disabled={!!recording} aria-label={`Remove ${formatBinding(key)} from ${action.label}`}
                  onClick={() => controller.setBindings(action.id, keys.filter((_, i) => i !== index))}><X size={12} /></button>
              </span>) : <strong className="shortcut-unbound">Unbound</strong>}
            </div>
            {keys.map(bindingWarning).filter((warning, index, all) => warning && all.indexOf(warning) === index)
              .map((warning) => <small className="shortcut-warning" key={warning}>{warning}</small>)}
            <div className="shortcut-setting-actions">
              <button type="button" disabled={!!recording} onClick={() => startRecording(action.id, false)}>Change</button>
              <button type="button" disabled={!!recording || keys.length >= 4} onClick={() => startRecording(action.id, true)}>Add binding</button>
              <button type="button" disabled={!!recording || !keys.length} onClick={() => controller.setBindings(action.id, [])}>Clear</button>
              <button type="button" disabled={!!recording || controller.overrides[action.id] === undefined} onClick={() => controller.reset(action.id)}>Reset</button>
            </div>
          </section>;
        })}
        {!actions.length && <p>No matching shortcuts.</p>}
      </div>
      <footer><button type="button" disabled={!!recording || (!Object.keys(controller.overrides).length && !controller.error)}
        onClick={() => { controller.resetAll(); setNotice(""); }}>Reset all shortcuts</button></footer>
    </section>
  </div>;
}
