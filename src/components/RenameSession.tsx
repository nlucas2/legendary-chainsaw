import { useEffect, useRef, useState } from "react";
import { daemonInvoke } from "../lib/daemon";
import type { SessionSummary } from "../lib/types";
import "./workspace-actions.css";

export function RenameSession({ session, onSaved, onClose }: {
  session: SessionSummary;
  onSaved: (session: SessionSummary) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(session.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  return <div className="modal-backdrop" role="presentation">
    <form className="session-action-modal" role="dialog" aria-modal="true" aria-label="Rename session"
      onKeyDown={(event) => { if (busy && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); } }}
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || !name.trim()) return;
        setBusy(true);
        setError("");
        try {
          const updated = await daemonInvoke<SessionSummary>("rename_session", { sessionId: session.sessionId, name: name.trim() });
          if (updated.sessionId !== session.sessionId) throw new Error("The runtime renamed a different session.");
          onSaved(updated);
        } catch (cause) { setError(String(cause)); }
        finally { setBusy(false); }
      }}>
      <h2>Rename session</h2>
      <label>Session name<input ref={input} value={name} maxLength={100} disabled={busy}
        onChange={(event) => setName(event.currentTarget.value)} /></label>
      {error && <p role="alert">{error}</p>}
      <footer>
        <button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="submit" className="button primary" disabled={busy || !name.trim()}>{busy ? "Saving..." : "Save name"}</button>
      </footer>
    </form>
  </div>;
}
