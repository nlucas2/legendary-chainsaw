import { memo, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Bot,
  Brain,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  FileJson,
  GitBranch,
  LoaderCircle,
  TerminalSquare,
  User,
  Wrench,
  XCircle,
} from "lucide-react";
import type { PermissionRequest, SessionEvent } from "../lib/types";

interface TranscriptProps {
  hasSession: boolean;
  loading: boolean;
  events: SessionEvent[];
  subagentContext: SessionEvent[];
  permissions: PermissionRequest[];
  showRawEvents: boolean;
  onPermission: (requestId: string, approved: boolean) => void;
}

type TimelineItem =
  | {
      kind: "message";
      id: string;
      role: "user" | "assistant";
      content: string;
      streaming?: boolean;
    }
  | {
      kind: "tool";
      id: string;
      callId: string;
      name: string;
      state: "running" | "done" | "failed";
      detail?: string;
      arguments?: unknown;
      result?: unknown;
      progress: string[];
    }
  | {
      kind: "reasoning";
      id: string;
      content: string;
      streaming: boolean;
    }
  | {
      kind: "command";
      id: string;
      command: string;
      result: unknown;
    }
  | {
      kind: "subagent";
      id: string;
      name: string;
      description: string;
      model?: string;
      status: "running" | "completed" | "failed" | "cancelled" | "unknown";
      durationMs?: number;
      error?: string;
      events: SessionEvent[];
    }
  | { kind: "status"; id: string; label: string };

export function Transcript({
  hasSession,
  loading,
  events,
  subagentContext,
  permissions,
  showRawEvents,
  onPermission,
}: TranscriptProps) {
  const timeline = useMemo(
    () => buildTimeline(withSubagentContext(events, subagentContext)),
    [events, subagentContext],
  );

  if (loading) {
    return (
      <div className="transcript-loading" aria-live="polite" aria-busy="true">
        <div className="loading-heading">
          <LoaderCircle className="spin" size={17} />
          <div>
            <strong>Loading conversation</strong>
            <span>Reading recent session history…</span>
          </div>
        </div>
        <div className="message-skeleton">
          <i />
          <div>
            <b />
            <span />
            <span />
            <span className="short" />
          </div>
        </div>
        <div className="message-skeleton">
          <i />
          <div>
            <b />
            <span />
            <span className="medium" />
          </div>
        </div>
      </div>
    );
  }

  if (timeline.length === 0 && permissions.length === 0) {
    return (
      <div className="empty-transcript">
        <div className="empty-orbit">
          <Bot size={28} />
        </div>
        <h2>{hasSession ? "This session is empty" : "Choose a session"}</h2>
        <p>
          {hasSession
            ? "Send the first message below. The session and its terminal will remain owned by the daemon."
            : "Select an existing session from the sidebar or create a new one."}
        </p>
      </div>
    );
  }

  return (
    <div className="transcript">
      {timeline.map((item) => (
        <TimelineEntry item={item} key={item.id} />
      ))}

      {permissions.map((permission) => (
        <article className="permission-card" key={permission.requestId}>
          <div className="permission-icon">
            <TerminalSquare size={19} />
          </div>
          <div>
            <div className="permission-kicker">Tool approval requested</div>
            <h3>{permissionLabel(permission)}</h3>
            <pre>{permissionDetail(permission)}</pre>
            <div className="permission-actions">
              <button
                className="button secondary"
                onClick={() => onPermission(permission.requestId, false)}
              >
                Deny
              </button>
              <button
                className="button primary"
                onClick={() => onPermission(permission.requestId, true)}
              >
                Approve once
              </button>
            </div>
          </div>
        </article>
      ))}

      {showRawEvents && (
        <details className="raw-event-log" open>
          <summary>
            <FileJson size={15} />
            <strong>Raw event stream</strong>
            <span>{events.length} events</span>
            <ChevronRight className="details-chevron" size={14} />
          </summary>
          <div>
            {events.map((event) => (
              <details className="raw-event" key={`raw-${event.id}`}>
                <summary>
                  <code>{event.type}</code>
                  <time>{formatTime(event.timestamp)}</time>
                </summary>
                <pre>{JSON.stringify(event, null, 2)}</pre>
              </details>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function TimelineEntry({
  item,
  assistantLabel = "Copilot",
}: {
  item: TimelineItem;
  assistantLabel?: string;
}) {
  if (item.kind === "message") {
    const collapsibleSubagentFinding =
      item.role === "assistant" &&
      assistantLabel !== "Copilot" &&
      item.content.length > 600;
    if (collapsibleSubagentFinding) {
      return <CollapsibleSubagentMessage item={item} label={assistantLabel} />;
    }
    return (
      <MessageEntry
        role={item.role}
        content={item.content}
        streaming={item.streaming === true}
        assistantLabel={assistantLabel}
      />
    );
  }
  if (item.kind === "reasoning") {
    return <ReasoningEntry item={item} />;
  }
  if (item.kind === "tool") {
    return <ToolEntry item={item} />;
  }
  if (item.kind === "command") {
    return (
      <details className="command-result">
        <summary>
          <TerminalSquare size={15} />
          <strong>{item.command}</strong>
          <ChevronRight className="details-chevron" size={14} />
        </summary>
        <div className="command-result-content">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {commandResultText(item.result)}
          </ReactMarkdown>
        </div>
      </details>
    );
  }
  if (item.kind === "subagent") {
    return <SubagentCard item={item} />;
  }
  return (
    <div className="status-row">
      <CircleDot size={13} />
      {item.label}
    </div>
  );
}

const MessageEntry = memo(function MessageEntry({
  role,
  content,
  streaming,
  assistantLabel,
}: {
  role: "user" | "assistant";
  content: string;
  streaming: boolean;
  assistantLabel: string;
}) {
  return (
    <article className={`message ${role}`}>
      <div className="message-avatar">
        {role === "user" ? <User size={16} /> : <Bot size={17} />}
      </div>
      <div className="message-content">
        <div className="message-role">{role === "user" ? "You" : assistantLabel}</div>
        {role === "assistant" ? (
          <>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            {streaming && <span className="streaming-caret" />}
          </>
        ) : (
          <p>{content}</p>
        )}
      </div>
    </article>
  );
});

function ReasoningEntry({
  item,
}: {
  item: Extract<TimelineItem, { kind: "reasoning" }>;
}) {
  const [expanded, setExpanded] = useState(item.streaming);
  useEffect(() => {
    if (item.streaming) setExpanded(true);
  }, [item.streaming]);
  return (
    <section className="reasoning-card">
      <button
        className="timeline-disclosure"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <Brain size={15} />
        <strong>Reasoning</strong>
        {item.streaming && (
          <span className="reasoning-live">
            <i />
            live
          </span>
        )}
        <ChevronRight
          className={expanded ? "details-chevron expanded" : "details-chevron"}
          size={14}
        />
      </button>
      {expanded && (
        <div className="reasoning-content">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {item.content || "Waiting for reasoning output…"}
          </ReactMarkdown>
        </div>
      )}
    </section>
  );
}

function ToolEntry({ item }: { item: Extract<TimelineItem, { kind: "tool" }> }) {
  const [expanded, setExpanded] = useState(item.state === "running");
  useEffect(() => {
    if (item.state === "running") setExpanded(true);
  }, [item.state]);
  return (
    <section className={`tool-card ${item.state}`}>
      <button
        className="timeline-disclosure"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="tool-icon">
          {item.state === "running" ? (
            <LoaderCircle className="spin" size={15} />
          ) : item.state === "failed" ? (
            <XCircle size={15} />
          ) : (
            <CheckCircle2 size={15} />
          )}
        </span>
        <Wrench size={14} />
        <strong>{item.name}</strong>
        {item.detail && <span className="tool-summary">{item.detail}</span>}
        <ChevronRight
          className={expanded ? "details-chevron expanded" : "details-chevron"}
          size={14}
        />
      </button>
      {expanded && (
        <div className="tool-details">
          <div className="tool-call-id">call {item.callId}</div>
          {item.arguments !== undefined && (
            <DetailBlock label="Arguments" value={item.arguments} />
          )}
          {item.progress.length > 0 && (
            <DetailBlock label="Progress" value={item.progress} />
          )}
          {item.result !== undefined && <DetailBlock label="Result" value={item.result} />}
        </div>
      )}
    </section>
  );
}

function buildTimeline(events: SessionEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const tools = new Map<string, number>();
  const reasoning = new Map<string, number>();
  const messages = new Map<string, number>();
  const subagents = new Map<string, number>();
  const subagentsByTool = new Map<string, number>();
  for (const event of events) {
    const data = event.data ?? {};
    if (event.type === "subagent.started") {
      const toolCallId = stringValue(data, "toolCallId");
      const id = event.agentId || toolCallId || event.id;
      const item: TimelineItem = {
        kind: "subagent",
        id,
        name:
          stringValue(data, "agentDisplayName", "agentName") || "Subagent",
        description: stringValue(data, "agentDescription"),
        model: stringValue(data, "model") || undefined,
        status: "running",
        events: [event],
      };
      const index = items.length;
      items.push(item);
      subagents.set(id, index);
      if (event.agentId) subagents.set(event.agentId, index);
      if (toolCallId) subagentsByTool.set(toolCallId, index);
      continue;
    }

    if (event.type === "subagent.completed" || event.type === "subagent.failed") {
      const toolCallId = stringValue(data, "toolCallId");
      const index =
        (event.agentId ? subagents.get(event.agentId) : undefined) ??
        (toolCallId ? subagentsByTool.get(toolCallId) : undefined);
      if (index !== undefined && items[index]?.kind === "subagent") {
        const item = items[index] as Extract<TimelineItem, { kind: "subagent" }>;
        item.status =
          event.type === "subagent.failed"
            ? "failed"
            : data.cancelled === true
              ? "cancelled"
              : "completed";
        item.durationMs =
          typeof data.durationMs === "number" ? data.durationMs : undefined;
        item.error = stringValue(data, "error") || undefined;
        item.model = stringValue(data, "model") || item.model;
        item.events.push(event);
      }
      continue;
    }
    if (event.agentId) {
      let index = subagents.get(event.agentId);
      if (index === undefined) {
        index = items.length;
        items.push({
          kind: "subagent",
          id: event.agentId,
          name: "Subagent",
          description: "Earlier subagent lifecycle history is not loaded.",
          status: "unknown",
          events: [],
        });
        subagents.set(event.agentId, index);
      }
      const item = items[index];
      if (item.kind === "subagent") item.events.push(event);
      continue;
    }
    if (event.type === "command.result") {
      items.push({
        kind: "command",
        id: event.id,
        command: stringValue(data, "command") || "Slash command",
        result: data.result,
      });
      continue;
    }
    if (event.type === "assistant.reasoning_delta") {
      const reasoningId = stringValue(data, "reasoningId") || event.id;
      const delta = stringValue(data, "deltaContent", "content");
      const index = reasoning.get(reasoningId);
      if (index === undefined) {
        reasoning.set(reasoningId, items.length);
        items.push({
          kind: "reasoning",
          id: reasoningId,
          content: delta,
          streaming: true,
        });
      } else {
        const item = items[index];
        if (item.kind === "reasoning") item.content += delta;
      }
      continue;
    }
    if (event.type === "assistant.message_start") {
      const messageId = stringValue(data, "messageId") || event.id;
      messages.set(messageId, items.length);
      items.push({
        kind: "message",
        id: messageId,
        role: "assistant",
        content: "",
        streaming: true,
      });
      continue;
    }
    if (
      event.type === "assistant.message_delta" ||
      event.type === "assistant.streaming_delta"
    ) {
      const messageId = stringValue(data, "messageId") || "streaming-assistant";
      const delta = stringValue(data, "deltaContent", "content", "text");
      let index = messages.get(messageId);
      if (index === undefined) {
        index = items.length;
        messages.set(messageId, index);
        items.push({
          kind: "message",
          id: messageId,
          role: "assistant",
          content: "",
          streaming: true,
        });
      }
      const item = items[index];
      if (item.kind === "message") item.content += delta;
      continue;
    }
    if (event.type === "assistant.reasoning") {
      const reasoningId = stringValue(data, "reasoningId") || event.id;
      const content = stringValue(data, "content");
      const index = reasoning.get(reasoningId);
      if (index === undefined) {
        reasoning.set(reasoningId, items.length);
        items.push({
          kind: "reasoning",
          id: reasoningId,
          content,
          streaming: false,
        });
      } else {
        const item = items[index];
        if (item.kind === "reasoning") {
          item.content = content || item.content;
          item.streaming = false;
        }
      }
      continue;
    }
    if (event.type === "user.message") {
      const content = stringValue(data, "content", "message", "prompt");
      if (content) items.push({ kind: "message", id: event.id, role: "user", content });
      continue;
    }
    if (event.type === "assistant.message") {
      const reasoningText = stringValue(data, "reasoningText");
      if (reasoningText) {
        items.push({
          kind: "reasoning",
          id: `${event.id}-reasoning`,
          content: reasoningText,
          streaming: false,
        });
      }
      const content = stringValue(data, "content", "message");
      const messageId = stringValue(data, "messageId");
      const index = messageId ? messages.get(messageId) : undefined;
      if (index !== undefined && items[index]?.kind === "message") {
        const item = items[index] as Extract<TimelineItem, { kind: "message" }>;
        item.content = content || item.content;
        item.streaming = false;
      } else if (content) {
        items.push({ kind: "message", id: event.id, role: "assistant", content });
      }
      continue;
    }
    if (event.type === "tool.execution_start") {
      const callId = stringValue(data, "toolCallId", "callId", "id") || event.id;
      tools.set(callId, items.length);
      items.push({
        kind: "tool",
        id: event.id,
        callId,
        name: stringValue(data, "toolName", "name") || "tool",
        state: "running",
        detail: summarizeArguments(data.arguments ?? data.input),
        arguments: data.arguments ?? data.input,
        progress: [],
      });
      continue;
    }
    if (
      event.type === "tool.execution_progress" ||
      event.type === "tool.execution_partial_result"
    ) {
      const callId = stringValue(data, "toolCallId", "callId", "id");
      const index = callId ? tools.get(callId) : undefined;
      if (index !== undefined && items[index]?.kind === "tool") {
        const item = items[index] as Extract<TimelineItem, { kind: "tool" }>;
        const update = stringValue(data, "progressMessage", "partialOutput", "message");
        if (update) item.progress.push(update);
      }
      continue;
    }
    if (event.type === "tool.execution_complete") {
      const callId = stringValue(data, "toolCallId", "callId", "id");
      const index = callId ? tools.get(callId) : undefined;
      if (index !== undefined && items[index]?.kind === "tool") {
        const item = items[index] as Extract<TimelineItem, { kind: "tool" }>;
        item.state = data.success === false || data.error ? "failed" : "done";
        item.result = data.result ?? data.error;
      }
      continue;
    }

    if (event.type === "session.compaction_start") {
      items.push({ kind: "status", id: event.id, label: "Compacting context" });
    }
  }
  return items;
}

function withSubagentContext(
  events: SessionEvent[],
  context: SessionEvent[],
): SessionEvent[] {
  if (context.length === 0) return events;
  const agentIds = new Set(
    events
      .map((event) => event.agentId)
      .filter((agentId): agentId is string => !!agentId),
  );
  if (agentIds.size === 0) return events;
  const byId = new Map(events.map((event) => [event.id, event]));
  for (const event of context) {
    if (event.agentId && agentIds.has(event.agentId) && !byId.has(event.id)) {
      byId.set(event.id, event);
    }
  }
  return [...byId.values()].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp),
  );
}

function SubagentCard({
  item,
}: {
  item: Extract<TimelineItem, { kind: "subagent" }>;
}) {
  const [expanded, setExpanded] = useState(item.status === "running");
  useEffect(() => {
    if (item.status === "running") setExpanded(true);
  }, [item.status]);
  const findings = item.events
    .filter((event) => event.type === "assistant.message")
    .map((event) => stringValue(event.data, "content", "message"))
    .filter(Boolean);
  const preview = findings[findings.length - 1]?.replace(/\s+/g, " ").slice(0, 120);
  const innerTimeline = useMemo(
    () =>
      expanded
        ? buildTimeline(
            item.events
              .filter((event) => !event.type.startsWith("subagent."))
              .map((event) => ({ ...event, agentId: undefined })),
          )
        : [],
    [expanded, item.events],
  );
  return (
    <section className={`subagent-card ${item.status}`}>
      <button
        className="subagent-header"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="subagent-icon">
          {item.status === "running" ? (
            <LoaderCircle className="spin" size={16} />
          ) : item.status === "failed" ? (
            <XCircle size={16} />
          ) : (
            <GitBranch size={16} />
          )}
        </span>
        <span className="subagent-heading">
          <strong>{item.name}</strong>
          <small>
            {item.status}
            {item.model ? ` · ${item.model}` : ""}
            {item.durationMs ? ` · ${formatDuration(item.durationMs)}` : ""}
          </small>
          {preview && <em>{preview}</em>}
        </span>
        <span className="subagent-toggle">{expanded ? "Collapse" : "Expand"}</span>
        <ChevronRight
          className={expanded ? "details-chevron expanded" : "details-chevron"}
          size={14}
        />
      </button>
      {expanded && (
        <div className="subagent-body">
          {item.description && <p className="subagent-description">{item.description}</p>}
          <div className="subagent-timeline">
            {innerTimeline.map((entry) => (
              <TimelineEntry
                item={entry}
                assistantLabel={item.name}
                key={`${item.id}-${entry.id}`}
              />
            ))}
          </div>
          {item.error && <div className="subagent-error">{item.error}</div>}
          {innerTimeline.length === 0 && (
            <div className="subagent-empty">Waiting for subagent output…</div>
          )}
        </div>
      )}
    </section>
  );
}

function CollapsibleSubagentMessage({
  item,
  label,
}: {
  item: Extract<TimelineItem, { kind: "message" }>;
  label: string;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <section className="subagent-message">
      <button
        className="subagent-message-header"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <div className="message-avatar">
          <Bot size={17} />
        </div>
        <div>
          <span className="message-role">{label}</span>
          <strong>{markdownHeading(item.content) || "Subagent finding"}</strong>
        </div>
        <ChevronRight
          className={expanded ? "details-chevron expanded" : "details-chevron"}
          size={14}
        />
      </button>
      {expanded && (
        <div className="message-content subagent-message-content">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.content}</ReactMarkdown>
        </div>
      )}
    </section>
  );
}

function DetailBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <section className="detail-block">
      <h4>{label}</h4>
      <div className="detail-value">
        <PrettyValue value={value} />
      </div>
    </section>
  );
}

function PrettyValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="pretty-empty">No content</span>;
  }
  if (typeof value === "string") {
    return <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return <code>{String(value)}</code>;
  }
  if (Array.isArray(value)) {
    return (
      <div className="pretty-list">
        {value.map((item, index) => (
          <div className="pretty-list-item" key={index}>
            <PrettyValue value={item} />
          </div>
        ))}
      </div>
    );
  }
  if (typeof value === "object") {
    return (
      <dl className="pretty-object">
        {Object.entries(value).map(([key, item]) => (
          <div key={key}>
            <dt>{humanizeKey(key)}</dt>
            <dd>
              <PrettyValue value={item} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return <span>{String(value)}</span>;
}

function stringValue(
  data: Record<string, unknown>,
  ...keys: string[]
): string {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string") return value;
  }
  return "";
}

function summarizeArguments(value: unknown): string | undefined {
  if (!value) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 90 ? `${text.slice(0, 87)}...` : text;
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleTimeString();
}

function commandResultText(value: unknown): string {
  if (!value || typeof value !== "object") return "Command completed.";
  const result = value as Record<string, unknown>;
  if (typeof result.text === "string") return result.text;
  if (typeof result.message === "string") return result.message;
  if (typeof result.notice === "string") return result.notice;
  if (typeof result.displayPrompt === "string") return result.displayPrompt;
  if (typeof result.model === "string") return `Model changed to **${result.model}**.`;
  if (Array.isArray(result.options)) {
    const options = result.options
      .filter((option): option is Record<string, unknown> => {
        return typeof option === "object" && option !== null;
      })
      .map((option) => {
        const name = typeof option.name === "string" ? option.name : "option";
        const description =
          typeof option.description === "string" ? ` — ${option.description}` : "";
        return `- **${name}**${description}`;
      });
    return options.length > 0 ? options.join("\n") : "Command completed.";
  }
  return "Command completed.";
}

function humanizeKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function markdownHeading(content: string): string {
  return content.match(/^#{1,4}\s+(.+)$/m)?.[1]?.trim() ?? "";
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
  return `${Math.floor(durationMs / 60_000)}m ${Math.round(
    (durationMs % 60_000) / 1000,
  )}s`;
}

function permissionLabel(permission: PermissionRequest): string {
  const request = permission.request;
  const tool =
    (typeof request.tool === "string" && request.tool) ||
    (typeof request.toolName === "string" && request.toolName) ||
    (typeof request.kind === "string" && request.kind);
  return tool || "Copilot wants to run a tool";
}

function permissionDetail(permission: PermissionRequest): string {
  const request = permission.request;
  const detail =
    request.command ?? request.arguments ?? request.input ?? request.path ?? request;
  const text = typeof detail === "string" ? detail : JSON.stringify(detail, null, 2);
  return text.length > 900 ? `${text.slice(0, 900)}\n...` : text;
}
