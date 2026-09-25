import { useEffect, useState } from "react";
import { daemonInvoke } from "../lib/daemon";
import { errorMessage } from "../lib/context";
import { normalizeInstalledPlugins, type InstalledPlugin } from "../lib/profiles";

export function PluginExclusions({ skills, mcp, onSkillsChange, onMcpChange }: {
  skills: string[];
  mcp: string[];
  onSkillsChange: (names: string[]) => void;
  onMcpChange: (names: string[]) => void;
}) {
  const [plugins, setPlugins] = useState<InstalledPlugin[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, refresh] = useState(0);
  const [customNames, setCustomNames] = useState<string[]>([]);
  const [writeIn, setWriteIn] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    void daemonInvoke("get_installed_plugins", {}, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setPlugins(normalizeInstalledPlugins(value)); })
      .catch((cause) => { if (!controller.signal.aborted) setError(errorMessage(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);

  const names = [...new Set([...(plugins ?? []).map((plugin) => plugin.name), ...skills, ...mcp, ...customNames])].sort();
  const toggle = (selected: string[], name: string, checked: boolean) =>
    checked ? [...new Set([...selected, name])] : selected.filter((value) => value !== name);
  const addName = () => {
    const name = writeIn.trim();
    if (!name) return;
    setCustomNames((current) => [...new Set([...current, name])]); setWriteIn("");
  };

  return <section className="plugin-exclusions" aria-label="Plugin exclusions">
    <div className="plugin-exclusions-header">
      <h4>Plugin exclusions</h4>
      <button type="button" disabled={loading} onClick={() => refresh((value) => value + 1)}>
        {error ? "Retry installed plugins" : "Refresh installed plugins"}
      </button>
    </div>
    <p className="profile-help">Installed plugins on the daemon. Check a box to exclude that capability from this profile, not to uninstall or disable the plugin globally.</p>
    {loading && <p role="status">Reading installed plugins...</p>}
    {error && <p className="profile-error" role="alert">Installed plugins unavailable: {error}. Saved selections and write-ins are still editable.</p>}
    {plugins?.length === 0 && !loading && !error && <p className="profile-help">No installed plugins reported by the runtime.</p>}
    {names.length > 0 && <div className="plugin-exclusion-list">
      <div className="plugin-exclusion-columns" aria-hidden="true"><span>Plugin</span><span>Exclude<br />skills</span><span>Exclude<br />MCP</span></div>
      {names.map((name) => {
        const sources = plugins?.filter((plugin) => plugin.name === name) ?? [];
        return <div className="plugin-exclusion-row" key={name}>
          <div className="plugin-exclusion-name"><strong>{name}</strong>
            {sources.length ? sources.map((plugin, index) => <small key={index}>
              {plugin.marketplace || "Direct install"}{plugin.version ? ` · v${plugin.version}` : ""} · {plugin.enabled ? "Enabled" : "Disabled globally"}
            </small>) : <small>{loading || error || !plugins ? "Saved / custom name; installation unconfirmed" : "Not in installed inventory / custom name"}</small>}
          </div>
          <label className="plugin-exclusion-toggle">
            <input type="checkbox" aria-label={`Exclude skills from ${name}`} checked={skills.includes(name)}
              onChange={(event) => onSkillsChange(toggle(skills, name, event.target.checked))} />
          </label>
          <label className="plugin-exclusion-toggle">
            <input type="checkbox" aria-label={`Exclude MCP servers from ${name}`} checked={mcp.includes(name)}
              onChange={(event) => onMcpChange(toggle(mcp, name, event.target.checked))} />
          </label>
        </div>;
      })}
    </div>}
    <details>
      <summary>Add a plugin name manually</summary>
      <p className="profile-help">For plugins not reported here. Names match exactly; same-named installations share these selections.</p>
      <div className="plugin-write-in">
        <label>Plugin name<input value={writeIn} maxLength={100} onChange={(event) => setWriteIn(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); addName(); }
          }} /></label>
        <button type="button" disabled={!writeIn.trim()} onClick={addName}>Add plugin name</button>
      </div>
    </details>
    <p className="profile-help">Skill and MCP exclusions are independent. Removing an exclusion restores capabilities disabled by the profile; pre-existing disabled choices stay disabled. The preview checks MCP source conflicts before applying.</p>
  </section>;
}
