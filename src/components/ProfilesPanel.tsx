import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Layers, Plus, X } from "lucide-react";
import { daemonInvoke } from "../lib/daemon";
import { errorMessage } from "../lib/context";
import { normalizeProfileLibrary, sourcePaths, type ProfileGroup, type ProfileLibrary, type SessionProfile } from "../lib/profiles";
import { PluginExclusions } from "./PluginExclusions";
import "./profiles.css";

export function ProfilesPanel({ onClose }: { onClose: () => void }) {
  const [library, setLibrary] = useState<ProfileLibrary | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [directory, setDirectory] = useState("");
  const [editing, setEditing] = useState<{ kind: "group"; item?: ProfileGroup } | { kind: "profile"; item?: SessionProfile } | null>(null);
  const pending = useRef(false);
  const root = useRef<HTMLElement>(null);
  const mounted = useRef(false);

  async function read() {
    setLoading(true);
    try {
      const next = normalizeProfileLibrary(await daemonInvoke("get_profile_library"));
      if (!mounted.current) return;
      setLibrary(next); setDirectory(next.directory); setError("");
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { if (mounted.current) setLoading(false); }
  }
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement;
    root.current?.querySelector<HTMLButtonElement>("header button")?.focus();
    void read();
    return () => { mounted.current = false; if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);

  async function mutate(command: string, args: Record<string, unknown>, message: string) {
    if (pending.current || !library) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const next = normalizeProfileLibrary(await daemonInvoke(command, { ...args, expectedRevision: library.revision }));
      if (!mounted.current) return;
      setLibrary(next); setDirectory(next.directory); setEditing(null); setNotice(message);
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }

  return <div className="profiles-backdrop">
    <section ref={root} className="profiles-panel" role="dialog" aria-modal="true" aria-label="Profiles and groups"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); if (!busy) onClose(); }
        if (event.key === "Tab") {
          const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary",
          )).filter((control) => control.getClientRects().length > 0);
          if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls[controls.length - 1]?.focus(); }
          if (!event.shiftKey && document.activeElement === controls[controls.length - 1]) { event.preventDefault(); controls[0]?.focus(); }
        }
      }}>
      <header><h2><Layers size={19} />Profiles and groups</h2>
        <button type="button" disabled={busy} aria-label="Close profiles" onClick={onClose}><X size={18} /></button></header>
      <div className="profiles-content">
        <p className="profile-help">Groups link MCP configuration files and skill directories on the daemon's computer. Profiles stack groups in order. Repository discovery remains automatic; profiles do not grant permission or enable autopilot.</p>
        <div className="profile-actions">
          <button type="button" disabled={!library || busy || !!editing} onClick={() => setEditing({ kind: "group" })}><Plus size={15} />New group</button>
          <button type="button" disabled={!library || busy || !!editing} onClick={() => setEditing({ kind: "profile" })}><Plus size={15} />New profile</button>
          <button type="button" disabled={busy || loading} onClick={() => void read()}>Refresh library</button>
        </div>
        {loading && !library && <p role="status">Loading profile library...</p>}
        {error && <p className="profile-error" role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {library && <details className="profile-location"><summary>Profile library location</summary>
          <p className="profile-help">This is separate from Copilot's own configuration and session storage. Existing source files are not moved, rewritten, or regenerated.</p>
          <label>Library directory on daemon<input value={directory} onChange={(event) => setDirectory(event.target.value)} disabled={busy} /></label>
          <button type="button" disabled={busy || !!editing || !directory.trim() || directory === library.directory} onClick={() => {
            if (window.confirm("Switch to this profile library? Existing files will not be moved or overwritten.")) {
              void mutate("set_profile_library_directory", { directory: directory.trim() }, "Profile library location changed.");
            }
          }}>Use this library directory</button>
        </details>}
        {library && editing?.kind === "group" && <GroupEditor key={editing.item?.id ?? "new-group"} library={library} group={editing.item}
          busy={busy} onBusyChange={setBusy} onCancel={() => setEditing(null)}
          onSave={(input) => mutate("save_profile_group", input, "Group saved. Running sessions were not changed.")} />}
        {library && editing?.kind === "profile" && <ProfileEditor key={editing.item?.id ?? "new-profile"} library={library} profile={editing.item}
          busy={busy} onCancel={() => setEditing(null)}
          onSave={(input) => mutate("save_profile", input, "Profile saved. Select it for a new session or apply it from Context.")} />}
        {library && !editing && <>
          <h3>Profiles</h3>
          {!library.profiles.length && <p className="profile-help">No profiles yet. Create reusable groups, then combine them into a profile.</p>}
          {library.profiles.map((profile) => <article className="profile-card" key={profile.id} aria-label={`Profile ${profile.name}`}>
            <div className="profile-card-summary">
              <h4>{profile.name}</h4>{" "}
              <p>{profile.groupIds.map((id) => library.groups.find((group) => group.id === id)!.name).join(" + ") || "Automatic discovery only"}</p>
            </div>
            <div className="profile-actions">
              <button type="button" aria-label="Edit profile" disabled={busy} onClick={() => setEditing({ kind: "profile", item: profile })}>Edit</button>
              <button type="button" aria-label="Delete profile" disabled={busy} onClick={() => {
                if (window.confirm(`Delete profile "${profile.name}" from this library? This does not stop its sessions or delete linked files.`)) {
                  void mutate("delete_profile", { id: profile.id }, "Profile removed from the library.");
                }
              }}>Delete</button>
            </div>
          </article>)}
          <h3>Reusable groups</h3>
          {!library.groups.length && <p className="profile-help">No groups are preconfigured. Link existing sources or create your own.</p>}
          {library.groups.map((group) => <article className="profile-card" key={group.id} aria-label={`Group ${group.name}`}>
            <div className="profile-card-summary">
              <h4>{group.name}</h4>{" "}
              <p>{group.mcpConfigFiles.length} MCP files · {group.skillDirectories.length} skill directories</p>
            </div>
            <div className="profile-actions">
              <button type="button" aria-label="Edit group" disabled={busy} onClick={() => setEditing({ kind: "group", item: group })}>Edit</button>
              <button type="button" aria-label="Delete group" disabled={busy} onClick={() => {
                if (window.confirm(`Delete group "${group.name}"? Linked files are not deleted. Groups used by a profile must be removed from that profile first.`)) {
                  void mutate("delete_profile_group", { id: group.id }, "Group removed from the library.");
                }
              }}>Delete</button>
            </div>
          </article>)}
        </>}
      </div>
    </section>
  </div>;
}

function GroupEditor({ library, group, busy, onBusyChange, onSave, onCancel }: {
  library: ProfileLibrary; group?: ProfileGroup; busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onSave: (input: Record<string, unknown>) => Promise<void>; onCancel: () => void;
}) {
  const [name, setName] = useState(group?.name ?? "");
  const [mcp, setMcp] = useState(group?.mcpConfigFiles.join("\n") ?? "");
  const [skills, setSkills] = useState(group?.skillDirectories.join("\n") ?? "");
  const [sourceKind, setSourceKind] = useState<"mcp" | "skills">("mcp");
  const [sourceName, setSourceName] = useState("");
  const [content, setContent] = useState('{\n  "mcpServers": {}\n}');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState("");
  return <form className="profile-editor" aria-label="Group editor" onSubmit={(event) => {
    event.preventDefault();
    if (!name.trim()) { setError("Enter a group name."); return; }
    void onSave({ ...(group ? { id: group.id } : {}), name: name.trim(),
      mcpConfigFiles: sourcePaths(mcp), skillDirectories: sourcePaths(skills) });
  }}>
    <h3>{group ? "Edit group" : "New group"}</h3>
    <fieldset disabled={busy || creating}>
      <label>Group name<input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} autoFocus /></label>
      <label>MCP configuration files (one per line)<textarea value={mcp} rows={3} onChange={(event) => setMcp(event.target.value)} /></label>
      <label>Skill directories (one per line)<textarea value={skills} rows={3} onChange={(event) => setSkills(event.target.value)} /></label>
      <p className="profile-help">Use existing CLI MCP files with an mcpServers object. Absolute paths point to the daemon computer; relative paths are resolved from the library directory. Linking never edits the source. For generated configs, link the generated file rather than an unresolved template.</p>
      <details><summary>Create a new managed source</summary>
        <label>Source type<select aria-label="Source type" value={sourceKind} onChange={(event) => setSourceKind(event.target.value === "skills" ? "skills" : "mcp")}>
          <option value="mcp">MCP configuration file</option><option value="skills">Skills directory</option>
        </select></label>
        <label>Source name<input value={sourceName} onChange={(event) => setSourceName(event.target.value)} /></label>
        {sourceKind === "mcp" && <label>MCP configuration JSON<textarea value={content} rows={6} onChange={(event) => setContent(event.target.value)} spellCheck={false} /></label>}
        <p className="profile-help">Creates a new source inside this library, never overwriting existing files. Prefer environment-based credentials; do not put secrets in shareable configuration.</p>
        <button type="button" disabled={!sourceName.trim()} onClick={async () => {
          setCreating(true); onBusyChange(true); setError(""); setCreated("");
          try {
            const result = await daemonInvoke<{ path?: unknown }>("create_profile_source", {
              kind: sourceKind, name: sourceName.trim(), ...(sourceKind === "mcp" ? { content } : {}),
              expectedRevision: library.revision,
            });
            if (typeof result.path !== "string" || !result.path) throw new Error("The daemon did not return the created source path.");
            const append = (current: string) => [...sourcePaths(current), result.path].join("\n");
            if (sourceKind === "mcp") setMcp(append); else setSkills(append);
            setCreated(`Created ${result.path}. Save the group to keep this reference.`);
          } catch (cause) { setError(errorMessage(cause)); }
          finally { setCreating(false); onBusyChange(false); }
        }}>Create source</button>
      </details>
      {error && <p role="alert" className="profile-error">{error}</p>}
      {created && <p role="status">{created}</p>}
      <div className="profile-actions"><button type="submit">Save group</button><button type="button" onClick={onCancel}>Cancel edit</button></div>
    </fieldset>
  </form>;
}

function ProfileEditor({ library, profile, busy, onSave, onCancel }: {
  library: ProfileLibrary; profile?: SessionProfile; busy: boolean;
  onSave: (input: Record<string, unknown>) => Promise<void>; onCancel: () => void;
}) {
  const [name, setName] = useState(profile?.name ?? "");
  const [groups, setGroups] = useState(profile?.groupIds ?? []);
  const [excludedSkillPlugins, setExcludedSkillPlugins] = useState(profile?.excludedSkillPlugins ?? []);
  const [excludedMcpPlugins, setExcludedMcpPlugins] = useState(profile?.excludedMcpPlugins ?? []);
  const [add, setAdd] = useState("");
  const remaining = library.groups.filter((group) => !groups.includes(group.id));
  const move = (index: number, step: number) => setGroups((current) => {
    const next = [...current]; [next[index], next[index + step]] = [next[index + step], next[index]]; return next;
  });
  return <form className="profile-editor" aria-label="Profile editor" onSubmit={(event) => {
    event.preventDefault();
    if (name.trim()) void onSave({ ...(profile ? { id: profile.id } : {}), name: name.trim(), groupIds: groups,
      excludedSkillPlugins, excludedMcpPlugins });
  }}>
    <h3>{profile ? "Edit profile" : "New profile"}</h3>
    <fieldset disabled={busy}>
      <label>Profile name<input value={name} required maxLength={100} onChange={(event) => setName(event.target.value)} autoFocus /></label>
      <p className="profile-help">Groups are combined in the displayed order. MCP definition conflicts and source origins are shown before application. Saving does not change active sessions.</p>
      <ol className="profile-stack">{groups.map((id, index) => {
        const group = library.groups.find((item) => item.id === id);
        return <li key={id}><span>{group?.name ?? `Missing group ${id}`}</span>
          <button type="button" aria-label={`Move ${group?.name} earlier`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={15} /></button>
          <button type="button" aria-label={`Move ${group?.name} later`} disabled={index === groups.length - 1} onClick={() => move(index, 1)}><ArrowDown size={15} /></button>
          <button type="button" aria-label={`Remove ${group?.name} from profile`} onClick={() => setGroups((current) => current.filter((value) => value !== id))}><X size={15} /></button>
        </li>;
      })}</ol>
      <label>Add a group<select aria-label="Add a group" value={add} onChange={(event) => setAdd(event.target.value)}>
        <option value="">Select a group</option>{remaining.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
      </select></label>
      <button type="button" disabled={!remaining.some((group) => group.id === add)} onClick={() => { setGroups((current) => [...current, add]); setAdd(""); }}>Add group</button>
      <PluginExclusions skills={excludedSkillPlugins} mcp={excludedMcpPlugins}
        onSkillsChange={setExcludedSkillPlugins} onMcpChange={setExcludedMcpPlugins} />
      <p className="profile-help">Plugin-only server names are disabled for this session. Same-named profile definitions take precedence; independent base definitions are retained explicitly. The preview explains each decision and blocks unknown source precedence. Link a repository MCP file in a group to choose it explicitly. Plugins remain installed; agents, hooks, and previous instructions are not excluded.</p>
      <div className="profile-actions"><button type="submit">Save profile</button><button type="button" onClick={onCancel}>Cancel edit</button></div>
    </fieldset>
  </form>;
}
