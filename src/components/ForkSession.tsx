import { useState } from "react";
import { daemonInvoke } from "../lib/daemon";
import type { SessionSummary } from "../lib/types";
import "./workspace-actions.css";

export function ForkSession({ session, onForked, onClose, initialName }: {
  session: SessionSummary;
  onForked: (session: SessionSummary) => void;
  onClose: () => void;
  initialName?: string;
}) {
  const [name, setName] = useState(initialName ?? `${session.title.slice(0, 93)} (fork)`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <div className="modal-backdrop" role="presentation">
    <form className="session-action-modal" role="dialog" aria-modal="true" aria-label="Fork conversation"
      onKeyDown={(event) => { if (busy && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); } }}
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || !name.trim()) return;
        setBusy(true);
        setError("");
        try {
          const fork = await daemonInvoke<SessionSummary>("fork_session", { sessionId: session.sessionId, name: name.trim() });
          if (!fork.sessionId || fork.sessionId === session.sessionId) throw new Error("The runtime did not create a separate session.");
          onForked(fork);
        } catch (cause) { setError(String(cause)); }
        finally { setBusy(false); }
      }}>
      <h2>Fork conversation</h2>
      <p>Create a separate conversation using this session's current history. The parent stays unchanged.</p>
      <p>This does not create a Git branch or duplicate terminal processes. Unsent drafts stay with their original conversation.</p>
      <label>New session name<input autoFocus value={name} maxLength={100} disabled={busy}
        onChange={(event) => setName(event.currentTarget.value)} /></label>
      {error && <p role="alert">{error}</p>}
      <footer>
        <button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="submit" className="button primary" disabled={busy || !name.trim()}>{busy ? "Forking..." : "Create fork"}</button>
      </footer>
    </form>
  </div>;
}
