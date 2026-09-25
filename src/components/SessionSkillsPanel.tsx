import { useEffect, useRef, useState } from "react";
import { Ban } from "lucide-react";
import { daemonInvoke } from "../lib/daemon";
import { createSingleflightReader, errorMessage, paginate } from "../lib/context";
import { normalizeSessionSkills, normalizeSkillPreview, type SessionSkills, type SessionSkillPreview } from "../lib/sessionSkills";
import "./context-tools.css";
import "./session-skills.css";

export function SessionSkillsPanel({ sessionId, cwd, query, revision = 0, refreshToken = 0, onInsert }: {
  sessionId: string;
  cwd?: string;
  query: string;
  revision?: number;
  refreshToken?: number;
  onInsert: (text: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<SessionSkills | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<SessionSkillPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [limit, setLimit] = useState(30);
  const [showDisabled, setShowDisabled] = useState(false);
  const reader = useRef<ReturnType<typeof createSingleflightReader<SessionSkills>> | null>(null);
  const mutation = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setSnapshot(null);
    setNotice("");
    setPreview(null);
    setError("");
    const request = createSingleflightReader(async (signal) =>
      normalizeSessionSkills(await daemonInvoke("session_skills", { sessionId }, signal), sessionId), {
      loading: () => setLoading(true),
      value: (value) => { setSnapshot(value); setLoading(false); setError(""); },
      error: (cause) => { setLoading(false); setError(errorMessage(cause)); },
    });
    reader.current = request;
    void request.refresh();
    return () => { generation.current++; request.dispose(); };
  }, [sessionId, cwd]);
  useEffect(() => {
    const timer = setTimeout(() => { if (!mutation.current) void reader.current?.refresh(); }, 250);
    return () => clearTimeout(timer);
  }, [revision, refreshToken]);
  useEffect(() => setLimit(30), [query, sessionId, showDisabled]);

  async function inspect() {
    if (mutation.current || !snapshot?.cwd || snapshot.cwd !== cwd) return;
    mutation.current = true;
    setPreviewing(true);
    setError("");
    setNotice("");
    const current = generation.current;
    try {
      const next = normalizeSkillPreview(await daemonInvoke("preview_session_skills", { sessionId, cwd: snapshot.cwd }), sessionId);
      if (current !== generation.current) return;
      if (next.cwd !== cwd) throw new Error("The working directory changed. Preview again before loading.");
      setPreview(next);
    } catch (cause) {
      if (current === generation.current) setError(errorMessage(cause));
    } finally {
      mutation.current = false;
      setPreviewing(false);
    }
  }

  async function reload() {
    if (mutation.current || !preview || preview.cwd !== cwd) return;
    mutation.current = true;
    setReloading(true);
    setError("");
    setNotice("");
    const current = generation.current;
    try {
      const next = normalizeSessionSkills(await daemonInvoke("reload_session_skills", {
        sessionId, cwd: preview.cwd,
      }), sessionId);
      if (current !== generation.current) return;
      reader.current?.replace(next);
      setPreview(null);
      setNotice(next.errors.length ? "Skill reload completed with errors. Review the diagnostics below."
        : `Reloaded skills for ${next.cwd}. ${next.skills.filter((skill) => skill.enabled).length} enabled in this session.`);
    } catch (cause) {
      if (current === generation.current) setError(errorMessage(cause));
    } finally {
      mutation.current = false;
      setReloading(false);
    }
  }

  const needle = query.trim().toLocaleLowerCase();
  const matching = snapshot?.skills.filter((skill) => [skill.name, skill.description, skill.path ?? "", skill.source, skill.pluginName ?? ""]
    .some((text) => text.toLocaleLowerCase().includes(needle))) ?? [];
  const visible = matching.filter((skill) => showDisabled || skill.enabled);
  const page = paginate(visible, limit);
  const enabledCount = snapshot?.skills.filter((skill) => skill.enabled).length ?? 0;
  const disabledCount = (snapshot?.skills.length ?? 0) - enabledCount;
  const hiddenMatches = showDisabled ? 0 : matching.length - visible.length;
  const cwdPending = snapshot && snapshot.cwd !== cwd;
  return <div className="context-tools-panel session-skills-panel">
    <p className="ct-scope"><strong>Session skills</strong> · Enabled skills are shown by default. Showing disabled skills does not enable them.</p>
    <section className="ct-status">
      <strong>Current working directory</strong>
      <code className="skills-cwd">{cwd || snapshot?.cwd || "No working directory"}</code>
      <p>Preview discovery from this directory after changing folders or editing skill files, then explicitly apply. Normal CLI-style discovery also includes supported user/repository instructions, agents, and plugin sources. No configuration files are edited.</p>
      <p>Only load skills from repositories you trust. This updates definitions for future use; it does not run a skill or remove instructions already in the conversation. The session and its background work must be idle.</p>
      <button type="button" disabled={reloading || previewing || loading || !snapshot?.cwd || !!cwdPending}
        onClick={() => void inspect()}>{previewing ? "Previewing discovery..." : "Load skills from current directory"}</button>
      {cwdPending && <span role="status">Waiting for the daemon to confirm this directory. Refresh the list after CWD tracking finishes.</span>}
    </section>
    {preview && <section className="ct-status" aria-label="Skill discovery preview">
      <strong>Review discovery before applying</strong>
      <span>{preview.discovered.length} discoverable skills · {preview.added.length} new names · {preview.changed.length} changed definitions or sources</span>
      {preview.added.length > 0 && <p>New: {preview.added.join(", ")}</p>}
      {preview.changed.length > 0 && <p>Changed: {preview.changed.join(", ")}</p>}
      {preview.notDiscovered.length > 0 && <p>Not found by this scan: {preview.notDiscovered.join(", ")}. These may remain available from session-specific sources.</p>}
      <p>This previews discoverable skill metadata, not a complete diff of instructions or plugins. Disabled-skill choices and explicit session sources are preserved. Files can change before applying; the resulting session list is authoritative.</p>
      {preview.errors.map((message, index) => <p role="alert" className="ct-inline-error" key={index}>{message}</p>)}
      <button type="button" disabled={reloading || previewing}
        onClick={() => void reload()}>{reloading ? "Loading skills..." : "Apply discovery and reload"}</button>
      <button type="button" disabled={reloading} onClick={() => setPreview(null)}>Cancel</button>
    </section>}
    {loading && <p role="status">Reading session skills...</p>}
    {error && <p className="ct-inline-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {snapshot?.errors.map((message, index) => <p className="ct-inline-error" role="alert" key={`error-${index}`}>{message}</p>)}
    {snapshot?.warnings.map((message, index) => <p className="ct-help" key={`warning-${index}`}>{message}</p>)}
    <button type="button" className="ct-load-more" disabled={loading || reloading || previewing}
      onClick={() => void reader.current?.refresh()}>Refresh skill list</button>
    {snapshot && <div className="skills-visibility">
      <p className="ct-help" role="status">{snapshot.skills.length} session skills · {enabledCount} enabled · {disabledCount} disabled{showDisabled ? "" : " (hidden)"}</p>
      <label className="skills-show-disabled"><input type="checkbox" checked={showDisabled}
        onChange={(event) => setShowDisabled(event.target.checked)} />Show disabled skills</label>
    </div>}
    {needle && hiddenMatches > 0 && <p className="ct-help">{hiddenMatches} disabled {hiddenMatches === 1 ? "skill matches" : "skills match"} this search. Select "Show disabled skills" to view {hiddenMatches === 1 ? "it" : "them"}.</p>}
    {page.items.map((skill) => <details className={`reference-item${skill.enabled ? "" : " skill-disabled"}`} key={skill.name}>
      <summary><span className="skill-summary-text"><strong>{skill.name}</strong><small>{skill.enabled ? "Enabled" : "Not available"} · {skill.source}{skill.pluginName ? ` · ${skill.pluginName}` : ""}</small></span>
        {!skill.enabled && <span className="skill-disabled-badge"><Ban size={14} aria-hidden="true" />Disabled</span>}
      </summary>
      <div className="reference-detail">
        {!skill.enabled && <p className="ct-help">Disabled for this session. This skill is not available for use; its definition is shown for reference only.</p>}
        <p>{skill.description}</p>
        {skill.path && <code className="skills-cwd">{skill.path}</code>}
        <button type="button" className="ct-load-more" disabled={!skill.enabled}
          onClick={() => onInsert(`Use the ${skill.name} skill to `)}>Reference skill in chat</button>
      </div>
    </details>)}
    {!loading && snapshot && visible.length === 0 && <p className="ct-help">{needle
      ? showDisabled ? "No matching session skills." : "No matching enabled skills."
      : snapshot.skills.length === 0 ? "The runtime reports no skills in this session." : "No enabled skills in this session. Select \"Show disabled skills\" to inspect the disabled definitions."}</p>}
    {page.remaining > 0 && <button type="button" className="ct-load-more" onClick={() => setLimit(page.nextLimit)}>Load more ({page.remaining} remaining)</button>}
  </div>;
}
