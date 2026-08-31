import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  Braces,
  Cable,
  Command,
  FileText,
  Puzzle,
  Search,
  ListTodo,
  Wrench,
  X,
} from "lucide-react";
import type { SessionReferences } from "../lib/types";
import type { SessionEvent } from "../lib/types";

interface ReferenceDrawerProps {
  references: SessionReferences | null;
  loading: boolean;
  onClose: () => void;
  onInsert: (text: string) => void;
  onRefresh: () => void;
  onRequestSection: (section: ReferenceSectionName) => void;
  sectionLoading: ReferenceSectionName | "";
  subagentEvents: SessionEvent[];
  onCancelTask: (action: TaskCancelAction) => void;
}

type ReferenceItem = {
  kind:
    | "command"
    | "skill"
    | "mcp"
    | "tool"
    | "instruction"
    | "context"
    | "task";
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
  command: { label: "Commands", icon: Command },
  skill: { label: "Skills", icon: Puzzle },
  mcp: { label: "MCP", icon: Cable },
  tool: { label: "Tools", icon: Wrench },
  instruction: { label: "Instructions", icon: FileText },
  context: { label: "Context", icon: Braces },
  task: { label: "Tasks", icon: ListTodo },
} as const;

export function ReferenceDrawer({
  references,
  loading,
  onClose,
  onInsert,
  onRefresh,
  onRequestSection,
  sectionLoading,
  subagentEvents,
  onCancelTask,
}: ReferenceDrawerProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ReferenceItem["kind"]>("task");
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
  const visible = matching.slice(0, 80);
  const errors = references
    ? Object.entries(references)
        .filter(([, section]) => section.error)
        .map(([name, section]) => `${name}: ${section.error}`)
    : [];

  useEffect(() => {
    const directSections: Partial<
      Record<ReferenceItem["kind"], ReferenceSectionName>
    > = {
      command: "commands",
      mcp: "mcp",
      instruction: "instructions",
      task: "tasks",
    };
    const direct = directSections[filter];
    if (
      direct &&
      references &&
      references[direct].value === undefined &&
      !references[direct].error &&
      sectionLoading !== direct
    ) {
      onRequestSection(direct);
      return;
    }
    if (
      filter === "skill" &&
      references &&
      references.skills.value === undefined &&
      !references.skills.error &&
      sectionLoading !== "skills"
    ) {
      onRequestSection("skills");
    }
    if (
      filter === "context" &&
      references &&
      references.contextAttribution.value === undefined &&
      !references.contextAttribution.error &&
      sectionLoading !== "contextAttribution"
    ) {
      onRequestSection("contextAttribution");
    }
    if (
      filter === "tool" &&
      references &&
      references.tools.value === undefined &&
      !references.tools.error &&
      sectionLoading !== "tools"
    ) {
      onRequestSection("tools");
      return;
    }
    if (
      filter === "tool" &&
      references &&
      references.tools.value !== undefined &&
      references.mcpTools.value === undefined &&
      !references.mcpTools.error &&
      sectionLoading !== "mcpTools"
    ) {
      onRequestSection("mcpTools");
    }
  }, [filter, onRequestSection, references, sectionLoading]);

  return (
    <aside className="reference-drawer" aria-label="Session context and references">
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
        Runtime-visible commands, tasks, skills, tools, MCP servers, and instruction
        sources. Select an item to reference it in the composer.
      </p>
      <label className="reference-search">
        <Search size={15} />
        <input
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search session capabilities"
        />
      </label>
      <div className="reference-filters">
        {(Object.keys(kindMeta) as ReferenceItem["kind"][]).map((kind) => {
          const Icon = kindMeta[kind].icon;
          return (
            <button
              key={kind}
              className={filter === kind ? "active" : ""}
              onClick={() => setFilter(kind)}
            >
              <Icon size={13} /> {kindMeta[kind].label}
            </button>
          );
        })}
      </div>
      <div className="reference-list">
        {loading && (
          <div className="reference-placeholder">Reading session capabilities…</div>
        )}
        {!loading && sectionLoading && (
          <div className="reference-placeholder">
            {sectionLoadingLabel(sectionLoading)}
          </div>
        )}
        {!loading &&
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
        {!loading && visible.length === 0 && (
          <div className="reference-placeholder">
            {filter === "task"
              ? "No background tasks or subagent runs in this session."
              : "No matching capabilities."}
          </div>
        )}
        {!loading && matching.length > visible.length && (
          <div className="reference-placeholder">
            Showing the first {visible.length} of {matching.length}. Narrow the search
            or choose a category.
          </div>
        )}
        {errors.map((error) => (
          <div className="reference-error" key={error}>
            {error}
          </div>
        ))}
      </div>
      <footer>
        <BookOpen size={13} />
        <span>
          The runtime exposes instruction <em>sources</em> and context attribution, not
          the complete assembled provider system prompt.
        </span>
        <button onClick={onRefresh}>Refresh</button>
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
  const mcpTools = asRecord(references.mcpTools.value);
  for (const [server, section] of Object.entries(mcpTools)) {
    for (const tool of arrayAt(asRecord(section).value, "tools")) {
      const name = stringAt(tool, "name");
      if (!name) continue;
      items.push({
        kind: "tool",
        name: `${server}/${name}`,
        description: stringAt(tool, "description") || "MCP tool",
        detail: tool,
        insert: `Use the ${server}/${name} tool to `,
      });
    }
  }
  for (const tool of arrayAt(references.tools.value, "tools")) {
    const name = stringAt(tool, "name");
    if (!name) continue;
    items.push({
      kind: "tool",
      name,
      description: stringAt(tool, "description"),
      detail: tool,
      insert: `Use the ${name} tool to `,
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
  const context = references.contextAttribution.value;
  const entries = arrayAt(context, "entries");
  for (const entry of entries) {
    const name =
      stringAt(entry, "label") || stringAt(entry, "name") || stringAt(entry, "type");
    if (!name) continue;
    items.push({
      kind: "context",
      name,
      description: contextDescription(entry),
      detail: entry,
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

function contextDescription(entry: Record<string, unknown>): string {
  const tokens = entry.tokens ?? entry.tokenCount;
  return typeof tokens === "number" ? `${tokens.toLocaleString()} tokens` : "Context source";
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
