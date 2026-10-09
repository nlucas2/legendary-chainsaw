import { useEffect, useMemo, useRef, useState } from "react";
import { daemonInvoke } from "../lib/daemon";
import {
  contextBudget,
  contextCategoryLabel,
  correlateToolTokenCounts,
  createSingleflightReader,
  errorMessage,
  normalizeContext,
  paginate,
  toolTokenCounts,
  type ContextAttribution,
} from "../lib/context";
import {
  filterTools,
  normalizeToolControls,
  serverControlState,
  serverMutationArgs,
  toolAvailability,
  toolAdoptionArgs,
  toolControlChecked,
  toolControlDisabledReason,
  toolMutationArgs,
  type SessionTool,
  type ToolControlsSnapshot,
  type ToolSource,
} from "../lib/toolControls";
import "./context-tools.css";

export interface ContextToolsPanelProps {
  sessionId?: string;
  revision?: number;
  tab: "context" | "tools";
  query: string;
  refreshToken?: number;
}

interface ResourceState<T> {
  sessionId?: string;
  data: T | null;
  loading: boolean;
  error: string | null;
}

const contextSnapshots = new Map<string, ContextAttribution>();
const toolSnapshots = new Map<string, ToolControlsSnapshot>();

function useSessionResource<T>(
  sessionId: string | undefined,
  command: string,
  normalize: (value: unknown) => T,
  active: boolean,
  revision: number,
  refreshToken: number,
  cache: Map<string, T>,
) {
  const [state, setState] = useState<ResourceState<T>>(() => ({
    sessionId, data: sessionId ? cache.get(sessionId) ?? null : null, loading: active, error: null,
  }));
  const reader = useRef<ReturnType<typeof createSingleflightReader<T>> | null>(null);
  const lastRevision = useRef({ revision, refreshToken });
  const refreshInventory = useRef(false);

  useEffect(() => {
    if (!active || !sessionId) return;
    lastRevision.current = { revision, refreshToken };
    setState((current) => ({ sessionId, data: current.sessionId === sessionId ? current.data : cache.get(sessionId) ?? null, loading: true, error: null }));
    const current = createSingleflightReader(
      async (signal) => {
        const force = refreshInventory.current;
        refreshInventory.current = false;
        return normalize(await daemonInvoke<unknown>(command, {
          sessionId, ...(command === "tool_controls" && force ? { refreshInventory: true } : {}),
        }, signal));
      },
      {
        loading: () => setState((previous) => ({ ...previous, loading: true, error: null })),
        value: (data) => {
          cache.delete(sessionId);
          cache.set(sessionId, data);
          while (cache.size > 5) cache.delete(cache.keys().next().value!);
          setState({ sessionId, data, loading: false, error: null });
        },
        error: (error) => setState((previous) => ({ ...previous, loading: false, error: errorMessage(error) })),
      },
    );
    reader.current = current;
    void current.refresh();
    return () => {
      current.dispose();
      if (reader.current === current) reader.current = null;
    };
    // Revisions are deliberately debounced below rather than aborting every read.
  }, [active, cache, command, normalize, sessionId]);

  useEffect(() => {
    if (!active || !sessionId || (lastRevision.current.revision === revision && lastRevision.current.refreshToken === refreshToken)) return;
    const manual = lastRevision.current.refreshToken !== refreshToken;
    const timer = setTimeout(() => {
      lastRevision.current = { revision, refreshToken };
      if (manual) refreshInventory.current = true;
      void reader.current?.refresh();
    }, manual ? 0 : 350);
    return () => clearTimeout(timer);
  }, [active, refreshToken, revision, sessionId]);

  const visible = state.sessionId === sessionId
    ? state
    : { sessionId, data: sessionId ? cache.get(sessionId) ?? null : null, loading: active, error: null };
  return {
    ...visible,
    refresh: () => { refreshInventory.current = true; void reader.current?.refresh(); },
    replace: (data: T) => reader.current?.replace(data),
  };
}

const formatTokens = (value: number | null) => value === null ? "Unavailable" : Math.round(value).toLocaleString();

export function ContextToolsPanel({
  sessionId,
  revision = 0,
  tab,
  query,
  refreshToken = 0,
}: ContextToolsPanelProps) {
  const context = useSessionResource(sessionId, "context_attribution", normalizeContext, true, revision, refreshToken, contextSnapshots);
  const tools = useSessionResource(sessionId, "tool_controls", normalizeToolControls, tab === "tools", revision, refreshToken, toolSnapshots);
  const [source, setSource] = useState<ToolSource | "all">("all");
  const [limit, setLimit] = useState(30);
  const [serverLimit, setServerLimit] = useState(12);
  const [busy, setBusy] = useState<string | null>(null);
  const [mutationErrors, setMutationErrors] = useState<Record<string, string>>({});
  const [announcement, setAnnouncement] = useState("");
  const mutationController = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const tokenCounts = useMemo(() => toolTokenCounts(context.data), [context.data]);
  const toolCosts = useMemo(() => correlateToolTokenCounts(tools.data?.tools ?? [], tokenCounts), [tools.data, tokenCounts]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; mutationController.current?.abort(); };
  }, []);
  useEffect(() => { setLimit(30); setServerLimit(12); }, [query, source, tab]);

  async function mutate(key: string, command: string, args: Record<string, unknown>, label: string) {
    if (!sessionId || mutationController.current) return;
    const controller = new AbortController();
    mutationController.current = controller;
    setBusy(key);
    setMutationErrors((previous) => {
      const next = { ...previous };
      delete next[key];
      return next;
    });
    setAnnouncement("");
    try {
      const snapshot = normalizeToolControls(await daemonInvoke<unknown>(command, args, controller.signal));
      if (!mounted.current || controller.signal.aborted) return;
      tools.replace(snapshot);
      setAnnouncement(`${label} updated for this session.`);
      // Context can lag the configuration event, but never represents fabricated
      // token savings immediately after a switch.
      context.refresh();
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return;
      setMutationErrors((previous) => ({ ...previous, [key]: errorMessage(error) }));
      tools.refresh();
    } finally {
      if (mutationController.current === controller) mutationController.current = null;
      if (mounted.current) setBusy(null);
    }
  }

  if (!sessionId) {
    return <div className="ct-status" role="status">Select a session to read its context and tool controls.</div>;
  }

  if (tab === "context") {
    return <div className="context-tools-panel">
      <ReadStatus name="context attribution" loading={context.loading} error={context.error} hasData={context.data !== null} retry={context.refresh} />
      {context.data?.status === "unavailable" && <div className="ct-status" role="status">{context.data.reason} Send a message or refresh after the runtime reports usage.</div>}
      {context.data?.status === "available" && <ContextSummary context={context.data} query={query} limit={limit} onLoadMore={() => setLimit((current) => current + 30)} />}
    </div>;
  }

  const matching = tools.data ? filterTools(tools.data, query, source) : [];
  const page = paginate(matching, limit);
  const counts = tools.data ? tools.data.tools.reduce((counts, tool) => {
    counts[toolAvailability(tool)]++;
    return counts;
  }, { offered: 0, enabled: 0, deferred: 0, off: 0 }) : null;
  const queryText = query.trim().toLocaleLowerCase();
  const servers = tools.data?.servers.filter((server) =>
    (source === "all" || source === "mcp") && (!queryText || server.name.toLocaleLowerCase().includes(queryText) ||
      matching.some((tool) => tool.serverName === server.name)),
  ) ?? [];
  const serverPage = paginate(servers, serverLimit, 12);

  return <div className="context-tools-panel">
    <p className="ct-scope"><strong>This session</strong> · Turning a tool off hides it from future model requests, not active calls. These controls do not change other sessions.</p>
    <ReadStatus name="session tools" loading={tools.loading} error={tools.error} hasData={tools.data !== null} retry={tools.refresh} />
    {tools.data && <>
      <div className="ct-inventory" aria-label="Session tool inventory">
        <strong>{tools.data.tools.length.toLocaleString()} known tools</strong>
        {tools.data.metadataAvailable
          ? <span>{counts!.offered} offered · {counts!.deferred} deferred · {counts!.off} not offered{counts!.enabled > 0 ? ` · ${counts!.enabled} enabled (offer state unavailable)` : ""}</span>
          : <span>Catalog entries · runtime availability unknown</span>}
        {tools.data.filterOwnership === "app" && <span>{tools.data.excludedTools.length} saved app exclusions{Array.isArray(tools.data.availableTools) ? ` · ${tools.data.availableTools.length} tools in the app-owned selection` : ""}</span>}
      </div>
      {tools.data.inventoryLoading && <p className="ct-help" role="status">
        Discovering additional MCP tools in the background.
      </p>}
      {!tools.data.metadataAvailable && <section className="ct-status" role="status">
        <strong>{tools.data.metadataLoading ? "Initializing this session's tools..." : "Current tool availability is not exposed by this session yet."}</strong>
        <span>The known catalog and MCP connection controls remain available. Individual tool changes and adoption are paused rather than guessing which tools the runtime offers.</span>
        {!tools.data.metadataLoading && <button type="button" onClick={tools.refresh}>Initialize tools again</button>}
      </section>}
      {tools.data.requiresAdoption && <section className="ct-status" aria-label="Manage existing session tool selection">
        <strong>Tool selection is not managed by this app yet.</strong>
        <span>Opt in for this attachment only. This replaces its existing native tool filters with the current effective selection, including deferred tools, and clears native exclusions as part of that replacement. Catalog-only and future tools stay unselected. Reattaching or restarting requires fresh consent; saved adopted preferences are not automatically reapplied. The session must be idle.</span>
        <button type="button" disabled={Boolean(busy) || tools.loading || Boolean(tools.error) || !tools.data.metadataAvailable}
          onClick={() => { void mutate("adoption", "adopt_tool_controls", toolAdoptionArgs(sessionId), "App-managed tool selection"); }}>
          {busy === "adoption" ? "Saving tool selection…" : "Manage this session’s tool selection"}
        </button>
        {mutationErrors.adoption && <p className="ct-inline-error" role="alert">{mutationErrors.adoption}</p>}
      </section>}
      {tools.data.filterOwnership === "app" && <p className="ct-help"><strong>App-managed tool selection.</strong> Switches edit this app's declared selection; Allowed does not guarantee that the runtime offers the tool or override external restrictions. Adopted existing sessions require fresh consent after reattach or restart, and saved adopted preferences are not automatically reapplied. Only app-created sessions can automatically restore their initialized managed settings.</p>}
      <p className="ct-help">Not offered does not necessarily mean user-disabled: connection, model support, or policy can also restrict a tool. Deferred tools are discoverable, not yet offered. Token counts are unambiguous, best-effort identity matches to the last reported definitions, not predicted savings.</p>
      {context.loading && !context.data && <p className="ct-help" role="status">Reading context token counts…</p>}
      {context.error && <div className="ct-inline-error" role="alert">Token counts unavailable: {context.error} <button type="button" onClick={context.refresh}>Retry context</button></div>}
      {!context.loading && !context.error && context.data?.status === "unavailable" && <p className="ct-help">Token counts unavailable: {context.data.reason}</p>}
      {tools.data.disabledReason && <p className="ct-status">{tools.data.disabledReason}</p>}
      {(!tools.data.filterStateKnown || tools.data.warnings.length > 0) && <div className="ct-status" role="status">
        <strong>Runtime limitations</strong>
        {!tools.data.filterStateKnown && <span>{tools.data.canEditTools
          ? "The runtime cannot report its full tool filters. These controls edit this app's declared selection and exclusions, not all runtime or policy restrictions."
          : tools.data.requiresAdoption ? "This existing session stays read-only until you explicitly opt in to app-managed tool selection."
            : "Individual tool switches are read-only because the runtime cannot report existing tool filters."} MCP server controls remain separate.</span>}
        {tools.data.warnings.map((warning, index) => <span key={index}>{warning}</span>)}
      </div>}
      <div className="ct-source-filter" role="group" aria-label="Filter tools by source">
        {(["all", "builtin", "mcp", "custom"] as const).map((kind) => <button type="button" key={kind} aria-pressed={source === kind} onClick={() => setSource(kind)}>
          {kind === "all" ? "All sources" : sourceLabel(kind)}
        </button>)}
      </div>
      {servers.length > 0 && <details className="ct-servers" open={servers.length <= 6 || undefined}>
        <summary>MCP server controls <span>{servers.length}</span></summary>
        <p className="ct-help">Server switches enable or disable this session's MCP connection. Individual tool filters are unchanged. Connection status and offered tool counts are separate.</p>
        {serverPage.items.map((server) => {
          const state = serverControlState(server, tools.data!);
          const key = `server:${server.name}`;
          return <div className="ct-server" key={server.name}>
            <div className="ct-tool-heading">
              <div><strong>{server.name}</strong><small>{server.status} · {tools.data!.metadataAvailable ? `${state.enabled}/${state.total} known tools available` : "tool availability unknown"}{tools.data!.metadataAvailable && state.mixed ? " · Some tools not offered" : ""}</small></div>
              <ToolSwitch label={`Enable MCP server ${server.name} for this session`} checked={state.checked} busy={busy === key} stateLabel={state.known ? undefined : "Unknown"}
                disabled={Boolean(busy) || tools.loading || Boolean(tools.error) || Boolean(state.disabledReason)}
                onChange={(enabled) => { void mutate(key, "set_mcp_enabled", serverMutationArgs(sessionId, server, enabled), server.name); }} />
            </div>
            {state.disabledReason && <p className="ct-help">{state.disabledReason}</p>}
            {mutationErrors[key] && <p className="ct-inline-error" role="alert">{mutationErrors[key]}</p>}
          </div>;
        })}
        {serverPage.remaining > 0 && <button type="button" className="ct-load-more" onClick={() => setServerLimit(serverPage.nextLimit)}>Load more servers ({serverPage.remaining} remaining)</button>}
      </details>}
      <h3 className="ct-section-title">{query || source !== "all" ? `${matching.length} matching tools` : "Session tools"}</h3>
      <ul className="ct-tool-list">
        {page.items.map((tool) => <ToolRow key={tool.id} tool={tool} snapshot={tools.data!} tokens={toolCosts.get(tool.id)}
          busy={busy === `tool:${tool.id}`} disabled={Boolean(busy) || tools.loading || Boolean(tools.error)} error={mutationErrors[`tool:${tool.id}`]}
          onChange={(enabled) => { void mutate(`tool:${tool.id}`, "set_tool_enabled", toolMutationArgs(sessionId, tool, enabled), tool.name); }} />)}
      </ul>
      {matching.length === 0 && <p className="ct-status">{query || source !== "all" ? "No tools match this search or source." : "The runtime reports no tools in this session's inventory."}</p>}
      {page.remaining > 0 && <button type="button" className="ct-load-more" onClick={() => setLimit(page.nextLimit)}>Load more tools ({page.remaining} remaining)</button>}
    </>}
    <span className="ct-sr-only" role="status" aria-live="polite">{announcement}</span>
  </div>;
}

function ReadStatus({ name, loading, error, hasData, retry }: {
  name: string; loading: boolean; error: string | null; hasData: boolean; retry: () => void;
}) {
  return <>
    {loading && (hasData
      ? <span className="ct-refresh-status" role="status">Refreshing {name}…</span>
      : <div className="ct-status" role="status">Reading {name}…</div>)}
    {error && <div className="ct-status ct-error" role="alert">
      <strong>Could not {hasData ? "refresh" : "read"} {name}.</strong>
      <span>{error}</span>
      {hasData && <span>The last successful snapshot is shown; it may be out of date.</span>}
      <button type="button" onClick={retry} disabled={loading}>Retry</button>
    </div>}
  </>;
}

function ContextSummary({ context, query, limit, onLoadMore }: {
  context: ContextAttribution; query: string; limit: number; onLoadMore: () => void;
}) {
  const budget = contextBudget(context);
  const needle = query.trim().toLocaleLowerCase();
  const matching = context.entries
    .filter((entry) => !needle || `${entry.name} ${entry.category} ${entry.toolName ?? ""}`.toLocaleLowerCase().includes(needle))
    .sort((left, right) => (right.tokens ?? -1) - (left.tokens ?? -1));
  const page = paginate(matching, limit);
  const categoryTotal = context.categories.reduce((total, category) => total + category.tokens, 0);
  const chartTotal = context.totalTokens ?? categoryTotal;
  return <>
    <p className="ct-scope"><strong>This session</strong> · Last runtime context snapshot; values can lag the active turn.</p>
    <section className="ct-budget" aria-label="Context token budget">
      <dl className="ct-budget-grid">
        <div><dt>Used tokens</dt><dd>{formatTokens(budget.used)}</dd></div>
        <div><dt>Free prompt space</dt><dd>{formatTokens(budget.free)}</dd></div>
        <div><dt>Output reserve</dt><dd>{formatTokens(budget.output)}</dd></div>
        <div><dt>Prompt limit</dt><dd>{formatTokens(context.promptTokenLimit)}</dd></div>
      </dl>
      {budget.usedPercent !== null && <div className="ct-budget-bar" role="meter" aria-label="Prompt budget used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(budget.usedPercent)} aria-valuetext={`${formatTokens(context.totalTokens)} of ${formatTokens(context.promptTokenLimit)} tokens`}>
        <span style={{ width: `${budget.usedPercent}%` }} />
      </div>}
      {budget.overBudget && <p className="ct-inline-error">The last snapshot exceeds the prompt limit. Compaction or a fresher usage report may be pending.</p>}
      <p className="ct-help">Model window: {formatTokens(context.limit)} · Runtime free capacity: {formatTokens(context.windowFreeSpace)}. Output reserve is outside the prompt limit. The runtime's combined buffer ({formatTokens(context.bufferTokens)}) includes this reserve and its post-blocking-threshold buffer; it is not additional usage.</p>
      <dl className="ct-compaction">
        <div><dt>Compaction threshold</dt><dd>{formatTokens(context.compactionThreshold)}{budget.beforeCompaction !== null ? ` · ${formatTokens(budget.beforeCompaction)} tokens away` : ""}</dd></div>
        <div><dt>Compactions</dt><dd>{formatTokens(context.compactions)}</dd></div>
      </dl>
    </section>
    <section aria-label="Context categories">
      <h3 className="ct-section-title">Where context is used</h3>
      {context.categories.length === 0 ? <p className="ct-help">The runtime did not provide category totals.</p> : <ul className="ct-categories">
        {context.categories.map((category, index) => <li key={`${category.name}:${index}`}>
          <div><span>{category.label}</span><strong>{formatTokens(category.tokens)}</strong></div>
          <div className="ct-category-track" aria-hidden="true"><span style={{ width: `${chartTotal > 0 ? Math.min(100, 100 * category.tokens / chartTotal) : 0}%` }} /></div>
        </li>)}
      </ul>}
    </section>
    <section aria-label="Context entries">
      <h3 className="ct-section-title">{needle ? "Matching entries" : "Heaviest entries"} <span>{matching.length}</span></h3>
      <p className="ct-help">Largest first. Group totals include their children and are not additional usage.</p>
      <ul className="ct-entry-list">
        {page.items.map((entry, index) => <li key={`${entry.id}:${index}`}>
          <div><strong>{entry.name}</strong><small>{contextCategoryLabel(entry.category)}{entry.aggregate ? " · Group total" : ""}</small></div>
          <span>{formatTokens(entry.tokens)}<small>tokens</small></span>
        </li>)}
      </ul>
      {matching.length === 0 && <p className="ct-status">{needle ? "No context entries match this search." : "This snapshot contains no itemized entries."}</p>}
      {page.remaining > 0 && <button type="button" className="ct-load-more" onClick={onLoadMore}>Load more entries ({page.remaining} remaining)</button>}
    </section>
  </>;
}

function sourceLabel(source: ToolSource) {
  return source === "builtin" ? "Built-in" : source === "mcp" ? "MCP" : "Custom";
}

function ToolRow({ tool, snapshot, tokens, busy, disabled, error, onChange }: {
  tool: SessionTool; snapshot: ToolControlsSnapshot; tokens?: number; busy: boolean; disabled: boolean; error?: string; onChange: (enabled: boolean) => void;
}) {
  const disabledReason = toolControlDisabledReason(tool, snapshot);
  const availability = toolAvailability(tool);
  const appOwned = snapshot.filterOwnership === "app";
  const checked = toolControlChecked(tool, snapshot);
  return <li className="ct-tool">
    <div className="ct-tool-heading">
      <div><strong>{tool.name}</strong><small>{sourceLabel(tool.source)}{tool.serverName ? ` · ${tool.serverName}` : ""}</small></div>
      <ToolSwitch label={appOwned ? `Allow ${tool.id} in this app's selection for this session` : `Enable ${tool.id} for this session`}
        checked={checked} stateLabel={!snapshot.metadataAvailable ? "Unknown" : appOwned ? checked ? "Allowed" : snapshot.excludedTools.includes(tool.id) ? "Excluded" : "Not selected" : undefined}
        busy={busy} disabled={disabled || Boolean(disabledReason)} onChange={onChange} />
    </div>
    <div className="ct-tool-meta"><span className={`ct-badge ct-badge-${availability}`}>{!snapshot.metadataAvailable ? "Availability unknown" : availability === "enabled" ? "Enabled · offer state unknown" : availability === "offered" ? "Offered" : availability === "deferred" ? "Deferred" : "Not offered"}</span><span>{tokens === undefined ? "Token cost unavailable" : `${formatTokens(tokens)} tokens`}</span></div>
    {tool.id !== tool.name && <code className="ct-tool-id">{tool.id}</code>}
    {tool.description && <details className="ct-tool-description"><summary>Description</summary><p>{tool.description}</p></details>}
    {disabledReason && <p className="ct-help">{disabledReason}</p>}
    {error && <p className="ct-inline-error" role="alert">{error}</p>}
  </li>;
}

function ToolSwitch({ label, checked, disabled, busy, stateLabel, onChange }: {
  label: string; checked: boolean; disabled: boolean; busy: boolean; stateLabel?: string; onChange: (enabled: boolean) => void;
}) {
  return <label className="ct-switch">
    <input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.checked)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !disabled) { event.preventDefault(); onChange(!checked); }
      }} />
    <span aria-hidden="true">{busy ? "Saving…" : stateLabel ?? (checked ? "On" : "Off")}</span>
  </label>;
}
