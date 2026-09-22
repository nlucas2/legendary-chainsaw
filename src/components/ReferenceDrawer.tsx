import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  Braces,
  Cable,
  Command,
  FileText,
  Puzzle,
  Search,
  ListTodo,
  Layers,
  Wrench,
  X,
} from "lucide-react";
import type { SessionReferences } from "../lib/types";
import type { SessionEvent } from "../lib/types";
import { ContextToolsPanel } from "./ContextToolsPanel";
import { SessionSkillsPanel } from "./SessionSkillsPanel";
import { SessionProfilePanel } from "./SessionProfilePanel";
import type { SessionProfileStatus } from "../lib/profiles";
import { paginate } from "../lib/context";

export interface ReferenceDrawerProps {
  sessionId?: string;
  cwd?: string;
  revision?: number;
  references: SessionReferences | null;
  loading: boolean;
  onClose: () => void;
  onInsert: (text: string) => void;
  onRefresh: () => void;
  onRequestSection: (section: ReferenceSectionName) => void;
  sectionLoading: ReferenceSectionName | "";
  subagentEvents: SessionEvent[];
  onCancelTask: (action: TaskCancelAction) => void;
  profileStatus?: SessionProfileStatus | null;
  profileError?: string;
  onProfileStatus?: (status: SessionProfileStatus) => void;
  onRefreshProfile?: () => void;
  onManageProfiles?: () => void;
}

type ReferenceItem = {
  kind:
    | "command"
    | "skill"
    | "mcp"
    | "tool"
    | "instruction"
    | "context"
    | "task"
    | "profile";
  name: string;
  description?: string;
  detail?: unknown;
  insert?: string;
  cancel?: TaskCancelAction;
};

export type TaskCancelAction =
  | { kind: "task"; id: string; label: string }
  | { kind: "background_agents"; label: string }
  | { kind: "main_turn"; label: string };

export type ReferenceSectionName =
  | "commands"
  | "skills"
  | "mcp"
  | "tools"
  | "mcpTools"
  | "instructions"
  | "contextAttribution"
  | "tasks";

const kindMeta = {
  context: { label: "Context", icon: Braces },
  profile: { label: "Profile", icon: Layers },
  tool: { label: "Tools", icon: Wrench },
  task: { label: "Tasks", icon: ListTodo },
  command: { label: "Commands", icon: Command },
  skill: { label: "Skills", icon: Puzzle },
  mcp: { label: "MCP", icon: Cable },
  instruction: { label: "Instructions", icon: FileText },
} as const;

const directSections: Partial<Record<ReferenceItem["kind"], ReferenceSectionName>> = {
  command: "commands",
  mcp: "mcp",
  instruction: "instructions",
  task: "tasks",
};

export function ReferenceDrawer({
  sessionId,
  cwd,
  revision = 0,
  references,
  loading,
  onClose,
  onInsert,
  onRefresh,
  onRequestSection,
  sectionLoading,
  subagentEvents,
  onCancelTask,
  profileStatus,
  profileError = "",
  onProfileStatus,
  onRefreshProfile,
  onManageProfiles,
}: ReferenceDrawerProps) {
  const drawer = useRef<HTMLElement>(null);
  const tabId = useId();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ReferenceItem["kind"]>("context");
  const [limit, setLimit] = useState(30);
  const [refreshToken, setRefreshToken] = useState(0);
  const items = useMemo(
    () => flattenReferences(references, subagentEvents),
    [references, subagentEvents],
  );
  const matching = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter(
      (item) =>
        item.kind === filter &&
        (!needle ||
          item.name.toLowerCase().includes(needle) ||
          item.description?.toLowerCase().includes(needle)),
    );
  }, [filter, items, query]);
  const page = paginate(matching, limit);
  const visible = page.items;
  const ownPanel = filter === "context" || filter === "tool" || filter === "skill" || filter === "profile";
  const direct = directSections[filter];
  const section = direct ? references?.[direct] : undefined;
  const waiting = loading || Boolean(direct && (!references || (section?.value === undefined && !section?.error) || sectionLoading === direct));

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    drawer.current?.querySelector<HTMLButtonElement>("header button")?.focus();
    return () => { if (previouslyFocused?.isConnected) previouslyFocused.focus(); };
  }, []);

  useEffect(() => { setLimit(30); }, [query, filter, sessionId]);

  useEffect(() => {
    if (
      direct &&
      references &&
      references[direct].value === undefined &&
      !references[direct].error &&
      sectionLoading !== direct
    ) {
      onRequestSection(direct);
    }
  }, [direct, onRequestSection, references, sectionLoading]);

  return (
    <aside ref={drawer} className="reference-drawer context-drawer" role="dialog" aria-modal="true" aria-label="Session context and references"
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); onClose(); }
        if (event.key !== "Tab") return;
        const targets = Array.from(drawer.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary, [tabindex="0"]') ?? [])
          .filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
        const first = targets[0];
        const last = targets[targets.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <header className="reference-header">
        <div>
          <span>Session transparency</span>
          <h2>Context & references</h2>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close context">
          <X size={18} />
        </button>
      </header>
      <p className="reference-intro">
        This session's context budget and tool controls, plus tasks, commands,
        skills, MCP servers, and instruction sources.
      </p>
      <label className="reference-search">
        <Search size={15} />
        <input
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          aria-label={`Search ${kindMeta[filter].label.toLowerCase()}`}
          placeholder={`Search ${kindMeta[filter].label.toLowerCase()}`}
        />
      </label>
      <div className="reference-filters" role="tablist" aria-label="Session references">
        {(Object.keys(kindMeta) as ReferenceItem["kind"][]).map((kind) => {
          const Icon = kindMeta[kind].icon;
          return (
            <button
              key={kind}
              type="button"
              role="tab"
              id={`${tabId}-${kind}`}
              aria-controls={`${tabId}-panel`}
              aria-selected={filter === kind}
              tabIndex={filter === kind ? 0 : -1}
              className={filter === kind ? "active" : ""}
              onClick={() => setFilter(kind)}
              onKeyDown={(event) => {
                const kinds = Object.keys(kindMeta) as ReferenceItem["kind"][];
                const index = kinds.indexOf(kind);
                const next = event.key === "ArrowRight" || event.key === "ArrowDown" ? (index + 1) % kinds.length
                  : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (index - 1 + kinds.length) % kinds.length
                    : event.key === "Home" ? 0 : event.key === "End" ? kinds.length - 1 : -1;
                if (next < 0) return;
                event.preventDefault();
                setFilter(kinds[next]);
                document.getElementById(`${tabId}-${kinds[next]}`)?.focus();
              }}
            >
              <Icon size={13} /> {kindMeta[kind].label}
            </button>
          );
        })}
      </div>
      <div className="reference-list" role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${filter}`}>
        {filter === "profile" ? sessionId && onProfileStatus && onRefreshProfile && onManageProfiles
          ? <SessionProfilePanel key={sessionId} sessionId={sessionId} cwd={cwd ?? ""} status={profileStatus ?? null}
              statusError={profileError} onStatus={onProfileStatus} onRefresh={onRefreshProfile} onManage={onManageProfiles} />
          : <p className="reference-placeholder">Select a session to manage its profile.</p>
          : filter === "skill" ? sessionId
          ? <SessionSkillsPanel key={sessionId} sessionId={sessionId} cwd={cwd} query={query} revision={revision}
              refreshToken={refreshToken} onInsert={onInsert} />
          : <p className="reference-placeholder">Select a session to read its skills.</p>
          : ownPanel ? <ContextToolsPanel key={sessionId ?? "no-session"} sessionId={sessionId} revision={revision}
          tab={filter === "context" ? "context" : "tools"} query={query} refreshToken={refreshToken} /> : <>
        {waiting && (
          <div className="reference-placeholder" role="status">
            {direct ? sectionLoadingLabel(direct) : "Reading session capabilities…"}
          </div>
        )}
        {
          visible.map((item, index) => {
            const Icon = kindMeta[item.kind].icon;
            return (
              <details className="reference-item" key={`${item.kind}-${item.name}-${index}`}>
                <summary>
                  <Icon size={15} />
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.description || kindMeta[item.kind].label}</small>
                  </span>
                  <span className="reference-item-actions">
                    {item.cancel && (
                      <button
                        className="danger"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onCancelTask(item.cancel!);
                        }}
                      >
                        {item.cancel.label}
                      </button>
                    )}
                    {item.insert && (
                      <button
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          onInsert(item.insert!);
                        }}
                      >
                        Reference
                      </button>
                    )}
                  </span>
                </summary>
                <div className="reference-detail">
                  <ReferenceValue value={item.detail ?? item} />
                </div>
              </details>
            );
          })}
        {!waiting && !section?.error && visible.length === 0 && (
          <div className="reference-placeholder">
            {filter === "task" && !query.trim()
              ? "No background tasks or subagent runs in this session."
              : "No matching capabilities."}
          </div>
        )}
        {page.remaining > 0 && <button className="ct-load-more" onClick={() => setLimit(page.nextLimit)}>
          Load more ({page.remaining} remaining)
        </button>}
        {section?.error && <div className="reference-error" role="alert">
          Could not read {kindMeta[filter].label.toLowerCase()}: {section.error}
          <button disabled={waiting} onClick={() => direct && onRequestSection(direct)}>Retry</button>
        </div>}
        </>}
      </div>
      <footer>
        <BookOpen size={13} />
        <span>
          The runtime exposes instruction <em>sources</em> and context attribution, not
          the complete assembled provider system prompt.
        </span>
        <button disabled={!ownPanel && waiting} onClick={() => {
          if (ownPanel) setRefreshToken((current) => current + 1);
          else onRefresh();
        }}>Refresh</button>
      </footer>
    </aside>
  );
}

function flattenReferences(
  references: SessionReferences | null,
  subagentEvents: SessionEvent[],
): ReferenceItem[] {
  const items: ReferenceItem[] = subagentTaskItems(subagentEvents);
  if (!references) return items;
  const commands = arrayAt(references.commands.value, "commands");
  for (const command of commands) {
    const name = stringAt(command, "name");
    if (!name) continue;
    items.push({
      kind: "command",
      name: `/${name}`,
      description: stringAt(command, "description"),
      detail: command,
      insert: `/${name} `,
    });
  }
  for (const skill of arrayAt(references.skills.value, "skills")) {
    const name = stringAt(skill, "name");
    if (!name) continue;
    items.push({
      kind: "skill",
      name,
      description: stringAt(skill, "description"),
      detail: skill,
      insert: `Use the ${name} skill to `,
    });
  }
  for (const server of arrayAt(references.mcp.value, "servers")) {
    const name = stringAt(server, "name");
    if (!name) continue;
    items.push({
      kind: "mcp",
      name,
      description: `MCP server · ${stringAt(server, "status") || "unknown"}`,
      detail: server,
      insert: `Using the ${name} MCP server, `,
    });
  }
  for (const source of arrayAt(references.instructions.value, "sources")) {
    const path = stringAt(source, "sourcePath");
    if (!path) continue;
    items.push({
      kind: "instruction",
      name: path,
      description: stringAt(source, "type") || "Instruction source",
      detail: source,
      insert: `Follow the instructions from ${path} and `,
    });
  }
  for (const task of arrayAt(references.tasks.value, "tasks")) {
    const name =
      stringAt(task, "title") ||
      stringAt(task, "name") ||
      stringAt(task, "description") ||
      stringAt(task, "id") ||
      "Background task";
    const status = stringAt(task, "status") || stringAt(task, "state") || "tracked";
    items.push({
      kind: "task",
      name,
      description: `Background task · ${status}`,
      detail: task,
      insert: `Check the status of the background task ${name} and `,
      cancel:
        status.toLowerCase() === "running" && stringAt(task, "id")
          ? {
              kind: "task",
              id: stringAt(task, "id"),
              label: "Cancel",
            }
          : undefined,
    });
  }
  return items;
}

function subagentTaskItems(events: SessionEvent[]): ReferenceItem[] {
  const runs = new Map<
    string,
    {
      name: string;
      model: string;
      status: string;
      description: string;
      startedAt: string;
      durationMs?: number;
      error?: string;
      executionMode?: string;
    }
  >();
  for (const event of [...events].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp),
  )) {
    const data = event.data ?? {};
    const id =
      stringAt(data, "toolCallId") || event.agentId || stringAt(data, "agentId");
    if (!id) continue;
    if (event.type === "subagent.started") {
      runs.set(id, {
        name: stringAt(data, "agentDisplayName") || stringAt(data, "agentName") || "Subagent",
        model: stringAt(data, "model"),
        status: "running",
        description: stringAt(data, "agentDescription"),
        startedAt: event.timestamp,
        executionMode: stringAt(data, "executionMode"),
      });
    } else if (
      event.type === "subagent.completed" ||
      event.type === "subagent.failed"
    ) {
      const current = runs.get(id);
      if (!current) continue;
      current.status =
        event.type === "subagent.failed"
          ? "failed"
          : data.cancelled === true
            ? "cancelled"
            : "completed";
      current.durationMs =
        typeof data.durationMs === "number" ? data.durationMs : undefined;
      current.error = stringAt(data, "error") || undefined;
      current.model = stringAt(data, "model") || current.model;
    }
  }
  return [...runs.entries()]
    .sort(([, left], [, right]) => {
      if (left.status === "running" && right.status !== "running") return -1;
      if (right.status === "running" && left.status !== "running") return 1;
      return right.startedAt.localeCompare(left.startedAt);
    })
    .map(([id, run]) => ({
      kind: "task" as const,
      name: run.name,
      description: `Subagent · ${run.status}${run.model ? ` · ${run.model}` : ""}`,
      detail: {
        id,
        type: "subagent",
        status: run.status,
        model: run.model || undefined,
        startedAt: run.startedAt,
        durationMs: run.durationMs,
        description: run.description || undefined,
        error: run.error,
      },
      insert:
        run.status === "running"
          ? `Check the progress of the ${run.name} subagent and `
          : `Review the ${run.name} subagent result and `,
      cancel:
        run.status !== "running"
          ? undefined
          : run.executionMode === "sync"
            ? {
                kind: "main_turn" as const,
                label: "Stop parent turn",
              }
            : {
                kind: "background_agents" as const,
                label: "Stop background agents",
              },
    }));
}

function arrayAt(value: unknown, key: string): Record<string, unknown>[] {
  const item = asRecord(value)[key];
  return Array.isArray(item)
    ? item.filter((entry): entry is Record<string, unknown> => isRecord(entry))
    : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAt(value: unknown, key: string): string {
  const item = asRecord(value)[key];
  return typeof item === "string" ? item : "";
}

function ReferenceValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span>Not provided</span>;
  if (typeof value === "string") return <span>{value}</span>;
  if (typeof value === "number" || typeof value === "boolean") {
    return <code>{String(value)}</code>;
  }
  if (Array.isArray(value)) {
    return (
      <div className="reference-value-list">
        {value.map((item, index) => (
          <div key={index}>
            <ReferenceValue value={item} />
          </div>
        ))}
      </div>
    );
  }
  if (typeof value === "object") {
    return (
      <dl className="reference-value-object">
        {Object.entries(value).map(([key, item]) => (
          <div key={key}>
            <dt>{humanizeKey(key)}</dt>
            <dd>
              <ReferenceValue value={item} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return <span>{String(value)}</span>;
}

function humanizeKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function sectionLoadingLabel(section: ReferenceSectionName): string {
  const labels: Record<ReferenceSectionName, string> = {
    commands: "Loading commands…",
    skills: "Discovering CLI skills…",
    mcp: "Loading MCP servers…",
    tools: "Loading built-in tools…",
    mcpTools: "Discovering MCP tools…",
    instructions: "Loading instruction sources…",
    contextAttribution: "Reading context attribution…",
    tasks: "Refreshing background tasks…",
  };
  return labels[section];
}
