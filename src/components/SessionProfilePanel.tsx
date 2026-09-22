import { useEffect, useRef, useState } from "react";
import { daemonInvoke } from "../lib/daemon";
import { errorMessage } from "../lib/context";
import {
  DEFAULT_PROFILE_CHOICE, normalizeProfileLibrary, normalizeProfilePreview, normalizeSessionProfile,
  type NewSessionProfileChoice, type ProfileLibrary, type ProfilePreview, type SessionProfileStatus,
} from "../lib/profiles";
import "./profiles.css";

function useProfileLibrary() {
  const [library, setLibrary] = useState<ProfileLibrary | null>(null);
  const [error, setError] = useState("");
  const [revision, refresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void daemonInvoke("get_profile_library", {}, controller.signal)
      .then((value) => { if (!controller.signal.aborted) { setLibrary(normalizeProfileLibrary(value)); setError(""); } })
      .catch((cause) => { if (!controller.signal.aborted) setError(errorMessage(cause)); });
    return () => controller.abort();
  }, [revision]);
  return { library, error, refresh: () => refresh((value) => value + 1) };
}

export function ProfilePreviewCard({ preview }: { preview: ProfilePreview }) {
  return <section className="profile-preview" aria-label="Resolved profile preview">
    <strong>{preview.profileName}</strong>
    <p>{preview.groupNames.join(" + ") || "No additional groups"} + automatic repository discovery</p>
    {preview.mcpServers.length > 0 && <details><summary>{preview.mcpServers.length} additional MCP definitions</summary>
      {preview.mcpServers.map((server) => <p key={server.name}><strong>{server.name}</strong><code>{server.sourceFile}</code></p>)}
    </details>}
    {preview.skillDirectories.length > 0 && <details><summary>{preview.skillDirectories.length} skill directories</summary>
      {preview.skillDirectories.map((directory) => <code key={directory}>{directory}</code>)}
    </details>}
    {preview.addedServers.length > 0 && <p>Added: {preview.addedServers.join(", ")}</p>}
    {preview.removedServers.length > 0 && <p>Removed from profile: {preview.removedServers.join(", ")}</p>}
    {preview.warnings.map((warning, index) => <p className="profile-help" key={index}>{warning}</p>)}
    {preview.requiresReconnect && <p className="profile-help">This change reconnects this session at a safe idle point. Its conversation, draft, and terminal stay in place. Previous instructions remain in the conversation.</p>}
  </section>;
}

export function NewSessionProfilePicker({ cwd, disabled, onChange }: {
  cwd: string; disabled: boolean; onChange: (choice: NewSessionProfileChoice) => void;
}) {
  const { library, error, refresh } = useProfileLibrary();
  const [selected, setSelected] = useState("");
  const [preview, setPreview] = useState<ProfilePreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  useEffect(() => {
    setPreview(null); setPreviewError("");
    if (!selected) { onChange(DEFAULT_PROFILE_CHOICE); return; }
    const controller = new AbortController();
    onChange({ profileId: selected, pending: true });
    void daemonInvoke("preview_session_profile", { profileId: selected, cwd }, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        const next = normalizeProfilePreview(value);
        if (next.profileId !== selected) throw new Error("The preview returned a different profile.");
        setPreview(next); onChange({ profileId: selected, revision: next.revision, pending: false });
      }).catch((cause) => {
        if (controller.signal.aborted) return;
        const message = errorMessage(cause); setPreviewError(message);
        onChange({ profileId: selected, pending: false, error: message });
      });
    return () => controller.abort();
  }, [selected, cwd, library?.revision, onChange]);
  return <div className="new-profile-picker">
    <label>Session profile<select aria-label="Session profile" value={selected} disabled={disabled} onChange={(event) => setSelected(event.target.value)}>
      <option value="">Default - automatic discovery</option>
      {library?.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
    </select></label>
    {error && <p className="profile-error" role="alert">Profiles unavailable: {error} <button type="button" disabled={disabled} onClick={refresh}>Retry profiles</button></p>}
    {previewError && <p className="profile-error" role="alert">{previewError}</p>}
    {preview && <ProfilePreviewCard preview={preview} />}
    <small className="profile-help">Manage reusable groups and profiles in Settings. Profile selection does not bypass normal permissions.</small>
  </div>;
}

export function SessionProfilePanel({ sessionId, cwd, status, statusError, onStatus, onRefresh, onManage }: {
  sessionId: string; cwd: string; status: SessionProfileStatus | null; statusError: string;
  onStatus: (status: SessionProfileStatus) => void; onRefresh: () => void; onManage: () => void;
}) {
  const { library, error, refresh } = useProfileLibrary();
  const [selected, setSelected] = useState<string>("");
  const [preview, setPreview] = useState<ProfilePreview | null>(null);
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const initialized = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    if (!initialized.current && status) { setSelected(status.profile?.id ?? ""); initialized.current = true; }
  }, [status]);
  useEffect(() => { generation.current++; setPreview(null); }, [cwd, selected, library?.revision]);
  useEffect(() => () => { generation.current++; }, []);
  const blocked = status?.applying === true;

  async function inspect() {
    if (busy) return;
    setBusy(true); setActionError("");
    const current = generation.current;
    try {
      const next = normalizeProfilePreview(await daemonInvoke("preview_session_profile", { sessionId, profileId: selected || null, cwd }));
      if (current !== generation.current) return;
      if (next.profileId !== (selected || null)) throw new Error("The preview returned a different profile.");
      setPreview(next);
    } catch (cause) { if (current === generation.current) setActionError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function apply() {
    if (!preview || busy) return;
    setBusy(true); setActionError("");
    const current = generation.current;
    try {
      const next = normalizeSessionProfile(await daemonInvoke("set_session_profile", {
        sessionId, profileId: preview.profileId, revision: preview.revision,
      }), sessionId);
      if (current !== generation.current) return;
      onStatus(next); setPreview(null);
    } catch (cause) { if (current === generation.current) setActionError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <div className="session-profile-panel">
    <p><strong>{status ? `Current profile: ${status.profile?.name ?? "Default"}` : "Reading current session profile..."}</strong></p>
    <p className="profile-help">A profile stacks reusable capability groups on top of automatic discovery. Changing it affects only this session. Runtime permissions and existing conversation context are not reset.</p>
    <button type="button" onClick={onManage}>Manage profiles and groups</button>
    {statusError && <p className="profile-error" role="alert">{statusError} <button type="button" onClick={onRefresh}>Retry session profile</button></p>}
    {error && <p className="profile-error" role="alert">{error} <button type="button" onClick={refresh}>Retry library</button></p>}
    <label>Choose profile<select aria-label="Choose profile" value={selected} disabled={busy || blocked || !library} onChange={(event) => setSelected(event.target.value)}>
      <option value="">Default - automatic discovery</option>
      {library?.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
      {selected && library && !library.profiles.some((profile) => profile.id === selected) && <option value={selected}>Profile unavailable in this library</option>}
    </select></label>
    <button type="button" disabled={busy || blocked || !status || !library || !cwd}
      onClick={() => void inspect()}>{busy && !preview ? "Resolving profile..." : "Preview profile change"}</button>
    {blocked && <p className="profile-help">Applying this session's profile. The composer draft and terminal stay in place.</p>}
    {status?.error && <p className="profile-error" role="alert">{status.error}</p>}
    {status?.requiresReconnect && <p className="profile-help">Reconnect the saved session before retrying; the previous runtime response was not confirmed.</p>}
    {preview && <>
      <ProfilePreviewCard preview={preview} />
      <p className="profile-help">Apply now requires the session, subagents, and existing queued work to be idle. If busy, let the work finish or use the existing Stop action, then try again. This change is never queued automatically.</p>
      <div className="profile-actions">
        <button type="button" disabled={busy || blocked || status?.requiresReconnect}
          onClick={() => void apply()}>{busy ? "Applying profile..." : "Apply profile now"}</button>
        <button type="button" disabled={busy} onClick={() => setPreview(null)}>Cancel preview</button>
      </div>
    </>}
    {actionError && <p role="alert" className="profile-error">{actionError}</p>}
  </div>;
}

export function ProfileConfigurationNotice({ status, error, onRefresh }: {
  status: SessionProfileStatus | null; error: string;
  onRefresh: () => void;
}) {
  if (!status || (!status.applying && !status.error)) return null;
  return <section className="profile-state" aria-label="Profile change status" aria-live="polite">
    <strong>{status.applying ? "Applying profile - your draft is preserved" : "Profile change needs attention"}</strong>
    {status.error && <p className="profile-error" role="alert">{status.error}</p>}
    {error && <p className="profile-error" role="alert">{error}</p>}
    <button type="button" onClick={onRefresh}>Refresh profile status</button>
  </section>;
}
