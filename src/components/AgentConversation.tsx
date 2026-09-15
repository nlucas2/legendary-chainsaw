import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Send } from "lucide-react";
import { daemonInvoke } from "../lib/daemon";
import { agentEventMatches, agentRootEvents, type AgentHistory, type AgentTask } from "../lib/agentTasks";
import { mergeHistoryEvents } from "../lib/history";
import type { SessionEvent, SessionSummary } from "../lib/types";
import { Transcript } from "./Transcript";
import "./subagent-navigation.css";

const NO_EVENTS: SessionEvent[] = [];
const NO_PERMISSIONS: [] = [];
const NO_PERMISSION_ACTION = () => {};

export function AgentConversation({
  parent, task, currentTask, taskError, parentEvents, text, busy, error, onChange, onSend, onBack,
  reasoningExpanded, toolDetailsExpanded, connected, pendingInputs,
}: {
  parent: SessionSummary;
  task: AgentTask;
  currentTask?: AgentTask;
  taskError?: string;
  parentEvents: SessionEvent[];
  text: string;
  busy: boolean;
  error?: string;
  connected: boolean;
  pendingInputs: number;
  onChange: (text: string) => void;
  onSend: () => Promise<boolean>;
  onBack: () => void;
  reasoningExpanded: boolean;
  toolDetailsExpanded: boolean;
}) {
  const [history, setHistory] = useState<AgentHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState("");
  const [inputError, setInputError] = useState("");
  const mounted = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const prompt = useRef<HTMLTextAreaElement>(null);
  const identityRevision = useMemo(() => parentEvents.filter((event) =>
    event.type.startsWith("subagent.") && event.data.toolCallId === task.toolCallId,
  ).map((event) => event.id).join(","), [parentEvents, task.toolCallId]);

  useEffect(() => {
    mounted.current = true;
    prompt.current?.focus();
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setHistoryError("");
    void daemonInvoke<AgentHistory>("agent_history", { sessionId: parent.sessionId, taskId: task.id }, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        if (page.sessionId !== parent.sessionId || page.taskId !== task.id) throw new Error("Subagent history returned the wrong conversation.");
        setHistory((current) => current ? {
          ...current, agentId: page.agentId,
          events: mergeHistoryEvents(page.events, current.events),
        } : page);
      })
      .catch((cause) => { if (!controller.signal.aborted) setHistoryError(String(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [parent.sessionId, task.id, revision, identityRevision, currentTask?.status]);

  const events = useMemo(() => {
    const live = parentEvents.filter((event) => agentEventMatches(event, history?.agentId));
    return agentRootEvents(mergeHistoryEvents(history?.events ?? NO_EVENTS, live), history?.agentId);
  }, [history, parentEvents]);
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [events]);

  async function loadEarlier() {
    if (!history?.hasMore || !history.cursor || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const page = await daemonInvoke<AgentHistory>("agent_history", {
        sessionId: parent.sessionId, taskId: task.id, cursor: history.cursor,
      });
      if (!mounted.current) return;
      if (page.sessionId !== parent.sessionId || page.taskId !== task.id) throw new Error("Subagent history returned the wrong conversation.");
      setHistory((current) => current ? { ...page, events: mergeHistoryEvents(page.events, current.events) } : page);
    } catch (cause) {
      if (mounted.current) setHistoryError(String(cause));
    } finally {
      if (mounted.current) setLoadingEarlier(false);
    }
  }

  const effective = currentTask ?? task;
  const unavailable = !connected ? "Reconnect Copilot before messaging this subagent."
    : taskError ? "Subagent status is unavailable. Refresh its session's subagents before sending."
    : !currentTask ? "This task is no longer tracked by its parent session."
    : !effective.canMessage ? effective.unavailableReason ?? `This ${effective.status} task cannot receive messages.` : "";
  return <section className="agent-conversation" aria-label={`Conversation with ${effective.name}`}>
    <header className="agent-conversation-header">
      <button type="button" className="button secondary" onClick={onBack} title={parent.title}>
        <ArrowLeft size={14} />Back to parent
      </button>
      <div><h2>{effective.name}</h2><small>{effective.status}{effective.model ? ` · ${effective.model}` : ""} · {effective.agentType}</small></div>
      <button type="button" className="button secondary" onClick={() => setRevision((value) => value + 1)}>Refresh conversation</button>
    </header>
    <p className="agent-chat-notice">Parent: {parent.title}. Messages below go directly to {effective.name}, not the parent.</p>
    {pendingInputs > 0 && <p className="agent-chat-notice" role="status">
      This session has {pendingInputs} pending approval/input request{pendingInputs === 1 ? "" : "s"}.{" "}
      <button type="button" className="button secondary" onClick={onBack}>Review in parent</button>
    </p>}
    {historyError && <p className="agent-chat-error" role="alert">{historyError}</p>}
    <div ref={scroll} className="conversation" tabIndex={0} aria-label="Subagent conversation"
      onScroll={(event) => {
        const element = event.currentTarget;
        follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
      }}>
      {history?.hasMore && <div className="history-pagination"><button type="button" className="button secondary"
        disabled={loadingEarlier} onClick={() => void loadEarlier()}>{loadingEarlier ? "Loading..." : "Load earlier subagent messages"}</button></div>}
      {!loading && !events.length ? <p className="agent-chat-notice">No conversation events available for this subagent yet.</p>
        : <Transcript sessionId={`${parent.sessionId}:${task.id}`} hasSession loading={loading} events={events}
          subagentContext={NO_EVENTS} permissions={NO_PERMISSIONS} showRawEvents={false}
          reasoningExpanded={reasoningExpanded} toolDetailsExpanded={toolDetailsExpanded}
          assistantLabel={effective.name} assistantModel={effective.model} onPermission={NO_PERMISSION_ACTION} />}
    </div>
    {unavailable && <p className="agent-chat-notice" role="status">{unavailable}</p>}
    {error && <p className="agent-chat-error" role="alert">{error}</p>}
    {inputError && <p className="agent-chat-error" role="alert">{inputError}</p>}
    {notice && <p className="agent-chat-notice" role="status">{notice}</p>}
    <form className="composer agent-composer" onSubmit={async (event) => {
      event.preventDefault();
      if (busy || unavailable || !text.trim()) return;
      setNotice("");
      const sent = await onSend();
      if (sent && mounted.current) {
        setNotice(`Message delivered to ${effective.name}.`);
        follow.current = true;
        setRevision((value) => value + 1);
      }
    }}>
      <textarea ref={prompt} aria-label={`Message ${effective.name}`} value={text}
        onChange={(event) => { setInputError(""); onChange(event.currentTarget.value); }}
        onPaste={(event) => {
          if (event.clipboardData.files.length) {
            event.preventDefault();
            setInputError("Direct subagent messages currently support text only; attachments are not supported by this runtime API.");
          }
        }}
        placeholder={`Message ${effective.name}...`} disabled={!!unavailable} rows={2}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault(); event.currentTarget.form?.requestSubmit();
          }
        }} />
      <div className="composer-footer">
        <small>Direct subagent message · Enter to send · Shift+Enter for newline</small>
        <button className="send-button" type="submit" aria-label={`Send to ${effective.name}`}
          disabled={busy || !!unavailable || !text.trim()}><Send size={15} /></button>
      </div>
    </form>
  </section>;
}
