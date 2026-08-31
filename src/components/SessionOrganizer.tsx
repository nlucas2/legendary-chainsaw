import { useState } from "react";
import type { FormEvent } from "react";
import { Folder, Pin, Tags, X } from "lucide-react";
import type { SessionSummary } from "../lib/types";

interface SessionOrganizerProps {
  session: SessionSummary;
  onClose: () => void;
  onSave: (organization: {
    pinned: boolean;
    folder?: string;
    tags: string[];
  }) => Promise<void>;
}

export function SessionOrganizer({
  session,
  onClose,
  onSave,
}: SessionOrganizerProps) {
  const [pinned, setPinned] = useState(session.pinned);
  const [folder, setFolder] = useState(session.folder ?? "");
  const [tags, setTags] = useState(session.tags.join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSave({
        pinned,
        folder: folder.trim() || undefined,
        tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="organizer-backdrop" onMouseDown={onClose}>
      <form
        className="organizer-panel"
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span>Session organization</span>
            <h2>{session.title}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <label className="pin-setting">
          <span className="organizer-icon">
            <Pin size={16} />
          </span>
          <span>
            <strong>Pin this session</strong>
            <small>Keep it above unpinned sessions</small>
          </span>
          <input
            type="checkbox"
            checked={pinned}
            onChange={(event) => setPinned(event.currentTarget.checked)}
          />
        </label>
        <label className="organizer-field">
          <span>
            <Folder size={14} /> Folder
          </span>
          <input
            value={folder}
            onChange={(event) => setFolder(event.currentTarget.value)}
            placeholder="e.g. App Service / Linux"
          />
        </label>
        <label className="organizer-field">
          <span>
            <Tags size={14} /> Tags
          </span>
          <input
            value={tags}
            onChange={(event) => setTags(event.currentTarget.value)}
            placeholder="rollout, investigation, follow-up"
          />
          <small>Separate tags with commas.</small>
        </label>
        {error && <div className="organizer-error">{error}</div>}
        <footer>
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? "Saving…" : "Save organization"}
          </button>
        </footer>
      </form>
    </div>
  );
}
