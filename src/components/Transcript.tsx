import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MarkdownContent as Markdown } from "./MarkdownContent";
import { CodeBlock } from "./CodeBlock";
import { formattedJson, hasMarkdownFormatting, rawOutput, shellLanguage } from "../lib/codeRendering";
import {
  Bot,
  Brain,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  FileJson,
  GitBranch,
  Image as ImageIcon,
  LoaderCircle,
  Paperclip,
  TerminalSquare,
  User,
  Wrench,
  XCircle,
} from "lucide-react";
import type { PermissionRequest, SessionEvent } from "../lib/types";
import type { MessageOrigin } from "../lib/messageOrigin";
import {
  decodeAttachmentImage, projectTimeline,
  type TimelineAttachment, type TimelineItem, type TimelineProjection,
} from "../lib/timeline";
import "./transcript-attachments.css";

interface TranscriptProps {
  sessionId?: string;
  hasSession: boolean;
  loading: boolean;
  events: SessionEvent[];
  windowStartEventId?: string;
  subagentContext: SessionEvent[];
  permissions: PermissionRequest[];
  showRawEvents: boolean;
  reasoningExpanded: boolean;
  toolDetailsExpanded: boolean;
  assistantModel?: string;
  assistantLabel?: string;
  subagentConversation?: boolean;
  onPermission: (requestId: string, approved: boolean) => void;
}

export const Transcript = memo(function Transcript({
  sessionId,
  hasSession,
  loading,
  events,
  windowStartEventId,
  subagentContext,
  permissions,
  showRawEvents,
  reasoningExpanded,
  toolDetailsExpanded,
  assistantModel,
  assistantLabel,
  subagentConversation = false,
  onPermission,
}: TranscriptProps) {
  const committed = useRef<TimelineProjection | undefined>(undefined);
  const projection = useMemo(
    () => projectTimeline(committed.current, events, {
      sessionId, windowStartEventId, subagentContext, assistantModel, subagentConversation,
    }),
    [sessionId, events, windowStartEventId, subagentContext, assistantModel, subagentConversation],
  );
  // Only publish the cache after commit. Interrupted renders project from an
  // immutable snapshot, never mutating items still displayed by another tree.
  useLayoutEffect(() => { committed.current = projection; }, [projection]);
  const timeline = projection.items;

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
          <div><b /><span /><span /><span className="short" /></div>
        </div>
        <div className="message-skeleton">
          <i />
          <div><b /><span /><span className="medium" /></div>
        </div>
      </div>
    );
  }

  if (timeline.length === 0 && permissions.length === 0) {
    return (
      <div className="empty-transcript">
        <div className="empty-orbit"><Bot size={28} /></div>
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
    <div className="transcript" key={sessionId}>
      {projection.environmentStatus && (
        <div className="environment-loading" role="status">
          <LoaderCircle className="spin" size={15} />
          <span>{projection.environmentStatus}</span>
        </div>
      )}
      {timeline.map((item) => (
        <TimelineEntry
          item={item}
          assistantLabel={assistantLabel}
          rootHumanMessages={!subagentConversation}
          key={item.id}
          reasoningExpanded={reasoningExpanded}
          toolDetailsExpanded={toolDetailsExpanded}
        />
      ))}
      {permissions.map((permission) => (
        <article className="permission-card" key={permission.requestId}>
          <div className="permission-icon"><TerminalSquare size={19} /></div>
          <div>
            <div className="permission-kicker">Tool approval requested</div>
            <h3>{permissionLabel(permission)}</h3>
            <pre>{permissionDetail(permission)}</pre>
            <div className="permission-actions">
              <button className="button secondary"
                onClick={() => onPermission(permission.requestId, false)}>
                Deny
              </button>
              <button className="button primary"
                onClick={() => onPermission(permission.requestId, true)}>
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
});

const TimelineEntry = memo(function TimelineEntry({
  item,
  assistantLabel = "Copilot",
  root = true,
  rootHumanMessages = true,
  reasoningExpanded = true,
  toolDetailsExpanded = false,
}: {
  item: TimelineItem;
  assistantLabel?: string;
  root?: boolean;
  rootHumanMessages?: boolean;
  reasoningExpanded?: boolean;
  toolDetailsExpanded?: boolean;
}) {
  if (item.kind === "message") {
    if (item.hidden || (!item.content.trim() && !item.attachments?.length)) return null;
    if (item.role === "assistant" && !root && item.content.length > 600) {
      return <CollapsibleSubagentMessage item={item} label={assistantLabel} />;
    }
    return (
      <MessageEntry role={item.role} content={item.content}
        streaming={item.streaming === true} assistantLabel={assistantLabel}
        rootMessage={root && rootHumanMessages} model={item.model} userOrigin={item.userOrigin}
        attachments={item.attachments}
        showAvatar={item.role === "user" || item.turnLead === true} />
    );
  }
  if (item.kind === "reasoning") {
    if (item.hidden || !item.content.trim()) return null;
    return (
      <ReasoningEntry item={item} defaultExpanded={reasoningExpanded}
        showAvatar={item.turnLead === true} model={item.model}
        assistantLabel={assistantLabel} />
    );
  }
  if (item.kind === "tool") {
    return <ToolEntry item={item} defaultExpanded={toolDetailsExpanded} />;
  }
  if (item.kind === "command") {
    return <CommandResult item={item} />;
  }
  if (item.kind === "subagent") {
    return (
      <SubagentCard item={item} reasoningExpanded={reasoningExpanded}
        toolDetailsExpanded={toolDetailsExpanded} />
    );
  }
  return <div className="status-row"><CircleDot size={13} />{item.label}</div>;
});

const MessageEntry = memo(function MessageEntry({
  role, content, streaming, assistantLabel, rootMessage, showAvatar, model, attachments, userOrigin,
}: {
  role: "user" | "assistant";
  content: string;
  streaming: boolean;
  assistantLabel: string;
  rootMessage: boolean;
  showAvatar: boolean;
  model?: string;
  attachments?: readonly TimelineAttachment[];
  userOrigin?: MessageOrigin;
}) {
  return (
    <article className={`message ${role}`}
      data-message-origin={role === "user" ? userOrigin?.kind ?? "unknown" : undefined}
      data-root-human={rootMessage && role === "user" && userOrigin?.kind === "human" ? "" : undefined}>
      <div className={showAvatar ? "message-avatar" : "message-avatar placeholder"}>
        {role === "assistant" || userOrigin?.kind === "agent" ? <Bot size={17} />
          : userOrigin?.kind === "human" ? <User size={16} />
            : userOrigin?.kind === "skill" ? <Wrench size={16} />
              : userOrigin?.kind === "scheduled" ? <CalendarClock size={16} /> : <CircleDot size={16} />}
      </div>
      <div className="message-content">
        {(role === "user" || showAvatar) && (
          <div className="message-role">
            <span title={role === "user" ? userOrigin?.description : undefined}>{role === "user" ? userOrigin?.label ?? "Input" : assistantLabel}</span>
            {role === "assistant" && model && <em>({model})</em>}
          </div>
        )}
        {role === "assistant" ? (
          <><Markdown streaming={streaming}>{content}</Markdown>{streaming && <span className="streaming-caret" />}</>
        ) : (
          <>
            {content && <p className="user-message-text">{content}</p>}
            {attachments && <MessageAttachments attachments={attachments} />}
          </>
        )}
      </div>
    </article>
  );
});

const MessageAttachments = memo(function MessageAttachments({
  attachments,
}: { attachments: readonly TimelineAttachment[] }) {
  return (
    <ul className="transcript-attachments" aria-label="Message attachments">
      {attachments.map((attachment, index) => (
        <li className="transcript-attachment" key={`${index}-${attachment.name}`}>
          {attachment.image
            ? <AttachmentThumbnail attachment={attachment} />
            : <Paperclip size={14} aria-hidden="true" />}
          <span className="transcript-attachment-name" title={attachment.name}>{attachment.name}</span>
        </li>
      ))}
    </ul>
  );
});

const AttachmentThumbnail = memo(function AttachmentThumbnail({
  attachment,
}: { attachment: TimelineAttachment }) {
  const container = useRef<HTMLSpanElement>(null);
  const [source, setSource] = useState<string>();
  useEffect(() => {
    setSource(undefined);
    const image = attachment.image;
    if (!image) return;
    let url: string | undefined;
    let disposed = false;
    let observer: IntersectionObserver | undefined;
    const load = () => {
      if (disposed || url) return;
      observer?.disconnect();
      const bytes = decodeAttachmentImage(attachment);
      if (!bytes) return;
      url = URL.createObjectURL(new Blob([bytes], { type: image.mimeType }));
      setSource(url);
    };
    if (typeof IntersectionObserver === "undefined" || !container.current) load();
    else {
      observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) load();
      }, { rootMargin: "160px" });
      observer.observe(container.current);
    }
    return () => {
      disposed = true;
      observer?.disconnect();
      if (url) URL.revokeObjectURL(url);
    };
  }, [attachment]);
  return (
    <span className="transcript-attachment-thumbnail" ref={container} aria-hidden="true">
      {source ? (
        <img src={source} alt="" width={40} height={40} loading="lazy" decoding="async"
          onError={() => { URL.revokeObjectURL(source); setSource(undefined); }} />
      ) : <ImageIcon size={18} />}
    </span>
  );
});

const ReasoningEntry = memo(function ReasoningEntry({
  item, defaultExpanded, showAvatar, model, assistantLabel,
}: {
  item: Extract<TimelineItem, { kind: "reasoning" }>;
  defaultExpanded: boolean;
  showAvatar: boolean;
  model?: string;
  assistantLabel: string;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  useEffect(() => setExpanded(defaultExpanded), [defaultExpanded]);
  return (
    <div className="reasoning-row">
      <div className={showAvatar ? "message-avatar" : "message-avatar placeholder"}>
        <Bot size={17} />
      </div>
      <div className="reasoning-turn-content">
        {showAvatar && (
          <div className="message-role">
            <span>{assistantLabel}</span>
            {model && <em>({model})</em>}
          </div>
        )}
        <section className="reasoning-card">
          <button className="timeline-disclosure" aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}>
            <Brain size={15} />
            <strong>Reasoning</strong>
            {item.streaming && <span className="reasoning-live"><i />live</span>}
            <ChevronRight className={expanded ? "details-chevron expanded" : "details-chevron"} size={14} />
          </button>
          {expanded && <div className="reasoning-content"><Markdown streaming={item.streaming}>{item.content}</Markdown></div>}
        </section>
      </div>
    </div>
  );
});

const ToolEntry = memo(function ToolEntry({
  item, defaultExpanded,
}: {
  item: Extract<TimelineItem, { kind: "tool" }>;
  defaultExpanded: boolean;
}) {
  const active = item.state === "preparing" || item.state === "running";
  const [expanded, setExpanded] = useState(defaultExpanded);
  useEffect(() => setExpanded(defaultExpanded), [defaultExpanded]);
  return (
    <section className={`tool-card ${item.state}`}>
      <button className="timeline-disclosure" aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}>
        <span className="tool-icon">
          {active ? <LoaderCircle className="spin" size={15} />
            : item.state === "failed" ? <XCircle size={15} /> : <CheckCircle2 size={15} />}
        </span>
        <Wrench size={14} />
        <strong>{item.name}</strong>
        {item.state === "preparing" && <span className="tool-summary">preparing…</span>}
        {item.detail && <span className="tool-summary">{item.detail}</span>}
        <ChevronRight className={expanded ? "details-chevron expanded" : "details-chevron"} size={14} />
      </button>
      {expanded && (
        <div className="tool-details">
          <div className="tool-call-id">call {item.callId}</div>
          {item.arguments !== undefined && <DetailBlock label="Arguments" value={item.arguments} commandLanguage={shellLanguage(item.name)} />}
          {item.arguments === undefined && item.inputBuffer && <DetailBlock label="Arguments" value={item.inputBuffer} streaming={active} />}
          {item.progress.length > 0 && <DetailBlock label="Progress" value={item.progress} plainText streaming={active} />}
          {item.result !== undefined && <DetailBlock label="Result" value={item.result} plainText={!!shellLanguage(item.name)} streaming={active} />}
        </div>
      )}
    </section>
  );
});

const SubagentCard = memo(function SubagentCard({
  item, reasoningExpanded, toolDetailsExpanded,
}: {
  item: Extract<TimelineItem, { kind: "subagent" }>;
  reasoningExpanded: boolean;
  toolDetailsExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(item.status === "running");
  return (
    <section className={`subagent-card ${item.status}`}>
      <button className="subagent-header" aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}>
        <span className="subagent-icon">
          {item.status === "running" ? <LoaderCircle className="spin" size={16} />
            : item.status === "failed" ? <XCircle size={16} /> : <GitBranch size={16} />}
        </span>
        <span className="subagent-heading">
          <strong>{item.name}</strong>
          <small>
            {item.status}
            {item.model ? ` · ${item.model}` : ""}
            {item.durationMs ? ` · ${formatDuration(item.durationMs)}` : ""}
          </small>
          {item.preview && <em>{item.preview}</em>}
        </span>
        <span className="subagent-toggle">{expanded ? "Collapse" : "Expand"}</span>
        <ChevronRight className={expanded ? "details-chevron expanded" : "details-chevron"} size={14} />
      </button>
      {expanded && (
        <div className="subagent-body">
          {item.description && <p className="subagent-description">{item.description}</p>}
          <div className="subagent-timeline">
            {item.timeline.map((entry) => (
              <TimelineEntry item={entry} assistantLabel={item.name} root={false}
                reasoningExpanded={reasoningExpanded} toolDetailsExpanded={toolDetailsExpanded}
                key={`${item.id}-${entry.id}`} />
            ))}
          </div>
          {item.error && <div className="subagent-error">{item.error}</div>}
          {item.timeline.length === 0 && <div className="subagent-empty">Waiting for subagent output…</div>}
        </div>
      )}
    </section>
  );
});

const CollapsibleSubagentMessage = memo(function CollapsibleSubagentMessage({
  item, label,
}: {
  item: Extract<TimelineItem, { kind: "message" }>;
  label: string;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <section className="subagent-message">
      <button className="subagent-message-header" aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}>
        <div className={item.turnLead ? "message-avatar" : "message-avatar placeholder"}>
          <Bot size={17} />
        </div>
        <div>
          {item.turnLead && (
            <span className="message-role">{label}{item.model && <em> ({item.model})</em>}</span>
          )}
          <strong>{markdownHeading(item.content) || "Subagent finding"}</strong>
        </div>
        <ChevronRight className={expanded ? "details-chevron expanded" : "details-chevron"} size={14} />
      </button>
      {expanded && (
        <div className="message-content subagent-message-content"><Markdown streaming={item.streaming}>{item.content}</Markdown></div>
      )}
    </section>
  );
});

const CommandResult = memo(function CommandResult({ item }: { item: Extract<TimelineItem, { kind: "command" }> }) {
  const [expanded, setExpanded] = useState(false);
  const [raw, setRaw] = useState(false);
  return <details className="command-result" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary><TerminalSquare size={15} /><strong>{item.command}</strong><ChevronRight className="details-chevron" size={14} /></summary>
    {expanded && <div className="command-result-content output-preserve-lines">
      <label className="output-raw-toggle"><input type="checkbox" checked={raw} onChange={(event) => setRaw(event.target.checked)} />Show raw output</label>
      {raw ? <CodeBlock source={rawOutput(item.result)} forceRaw controls={false} />
        : <OutputText value={commandResultText(item.result)} />}
    </div>}
  </details>;
});

const DetailBlock = memo(function DetailBlock({ label, value, plainText = false, commandLanguage, streaming = false }: {
  label: string; value: unknown; plainText?: boolean; commandLanguage?: string; streaming?: boolean;
}) {
  const [raw, setRaw] = useState(false);
  return (
    <section className="detail-block">
      <h4>{label}</h4>
      <label className="output-raw-toggle"><input type="checkbox" checked={raw} onChange={(event) => setRaw(event.target.checked)} />Show raw output</label>
      <div className="detail-value output-preserve-lines">{raw
        ? <CodeBlock source={rawOutput(value)} forceRaw controls={false} />
        : <PrettyValue value={value} plainText={plainText} commandLanguage={commandLanguage} streaming={streaming} />}</div>
    </section>
  );
});

const PrettyValue = memo(function PrettyValue({ value, plainText = false, commandLanguage, field, streaming = false }: {
  value: unknown; plainText?: boolean; commandLanguage?: string; field?: string; streaming?: boolean;
}) {
  if (value === null || value === undefined) return <span className="pretty-empty">No content</span>;
  if (typeof value === "string") {
    const language = commandLanguage && ["command", "script", "code"].includes(field ?? "") ? commandLanguage : undefined;
    if (language) {
      return <CodeBlock source={value} language={language} controls={false} streaming={streaming} />;
    }
    return <OutputText value={value} streaming={streaming}
      plainText={plainText || ["stdout", "stderr", "output", "partialOutput"].includes(field ?? "")} />;
  }
  if (typeof value === "number" || typeof value === "boolean") return <code>{String(value)}</code>;
  if (Array.isArray(value)) {
    return (
      <div className="pretty-list">
        {value.map((item, index) => (
          <div className="pretty-list-item" key={index}><PrettyValue value={item} plainText={plainText} commandLanguage={commandLanguage} field={field} streaming={streaming} /></div>
        ))}
      </div>
    );
  }
  if (typeof value === "object") {
    return (
      <dl className="pretty-object">
        {Object.entries(value).map(([key, item]) => (
          <div key={key}><dt>{humanizeKey(key)}</dt><dd><PrettyValue value={item} field={key} plainText={plainText} commandLanguage={commandLanguage} streaming={streaming} /></dd></div>
        ))}
      </dl>
    );
  }
  return <span>{String(value)}</span>;
});

const OutputText = memo(function OutputText({ value, streaming = false, plainText = false }: { value: string; streaming?: boolean; plainText?: boolean }) {
  const json = useMemo(() => streaming ? null : formattedJson(value), [value, streaming]);
  if (json !== null) return <CodeBlock source={json} language="json" controls={false} />;
  return !plainText && hasMarkdownFormatting(value) ? <Markdown streaming={streaming}>{value}</Markdown>
    : <CodeBlock source={value} language="plaintext" controls={false} streaming={streaming} />;
});

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleTimeString();
}

function commandResultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "Command completed.";
  const result = value as Record<string, unknown>;
  if (typeof result.text === "string") return result.text;
  if (typeof result.message === "string") return result.message;
  if (typeof result.notice === "string") return result.notice;
  if (typeof result.displayPrompt === "string") return result.displayPrompt;
  if (typeof result.model === "string") return `Model changed to **${result.model}**.`;
  if (Array.isArray(result.options)) {
    const options = result.options
      .filter((option): option is Record<string, unknown> => typeof option === "object" && option !== null)
      .map((option) => {
        const name = typeof option.name === "string" ? option.name : "option";
        const description = typeof option.description === "string" ? ` — ${option.description}` : "";
        return `- **${name}**${description}`;
      });
    return options.length > 0 ? options.join("\n") : "Command completed.";
  }
  return rawOutput(value);
}

function humanizeKey(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function markdownHeading(content: string): string {
  return content.match(/^#{1,4}\s+(.+)$/m)?.[1]?.trim() ?? "";
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
  return `${Math.floor(durationMs / 60_000)}m ${Math.round((durationMs % 60_000) / 1000)}s`;
}

function permissionLabel(permission: PermissionRequest): string {
  const request = permission.request;
  const tool = (typeof request.tool === "string" && request.tool) ||
    (typeof request.toolName === "string" && request.toolName) ||
    (typeof request.kind === "string" && request.kind);
  return tool || "Copilot wants to run a tool";
}

function permissionDetail(permission: PermissionRequest): string {
  const request = permission.request;
  const detail = request.command ?? request.arguments ?? request.input ?? request.path ?? request;
  const text = typeof detail === "string" ? detail : JSON.stringify(detail, null, 2);
  return text.length > 900 ? `${text.slice(0, 900)}\n...` : text;
}
