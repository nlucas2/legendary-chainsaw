import { useCallback, useEffect, useRef, useState } from "react";
import { createSingleflightReader } from "./context";
import { daemonInvoke } from "./daemon";
import { normalizeAgentTasks, type AgentTaskList } from "./agentTasks";
import type { DaemonEvent, SessionSummary } from "./types";

export interface AgentTaskState {
  data?: AgentTaskList;
  loading: boolean;
  error?: string;
}

export function useAgentTasks(sessions: SessionSummary[], expanded: Set<string>, runtimeConnected: boolean) {
  const [states, setStates] = useState<Record<string, AgentTaskState>>({});
  const readers = useRef(new Map<string, ReturnType<typeof createSingleflightReader<AgentTaskList>>>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const signature = JSON.stringify(sessions.filter((session) => expanded.has(session.sessionId))
    .map((session) => [session.sessionId, session.isActive]));

  useEffect(() => {
    const targets: [string, boolean][] = JSON.parse(signature);
    const cleanups: (() => void)[] = [];
    for (const [sessionId, attached] of targets) {
      if (!runtimeConnected || !attached) {
        setStates((current) => ({ ...current, [sessionId]: {
          ...current[sessionId], loading: false,
          error: !runtimeConnected ? "Copilot is disconnected." : "Open this session to connect and read its subagents.",
        } }));
        continue;
      }
      const reader = createSingleflightReader(
        async (signal) => normalizeAgentTasks(await daemonInvoke("agent_tasks", { sessionId }, signal), sessionId),
        {
          loading: () => setStates((current) => ({ ...current, [sessionId]: { ...current[sessionId], loading: true } })),
          value: (data) => setStates((current) => ({ ...current, [sessionId]: { data, loading: false } })),
          error: (error) => setStates((current) => ({ ...current, [sessionId]: {
            ...current[sessionId], loading: false, error: String(error).includes("unknown command agent_tasks")
              ? "The UI is newer than the running daemon. Apply the daemon update to enable subagent conversations."
              : String(error),
          } })),
        },
      );
      readers.current.set(sessionId, reader);
      void reader.refresh();
      const poll = setInterval(() => { if (!document.hidden) void reader.refresh(); }, 3000);
      cleanups.push(() => { clearInterval(poll); reader.dispose(); readers.current.delete(sessionId); });
    }
    return () => {
      cleanups.forEach((cleanup) => cleanup());
      timers.current.forEach(clearTimeout);
      timers.current.clear();
    };
  }, [signature, runtimeConnected]);

  const refresh = useCallback((sessionId: string) => { void readers.current.get(sessionId)?.refresh(); }, []);
  const notify = useCallback((event: DaemonEvent) => {
    if (event.type !== "session_event" || !readers.current.has(event.sessionId)) return;
    if (!event.event.type.startsWith("subagent.") && !event.event.type.startsWith("task.") &&
        event.event.type !== "session.idle") return;
    if (timers.current.has(event.sessionId)) return;
    timers.current.set(event.sessionId, setTimeout(() => {
      timers.current.delete(event.sessionId);
      void readers.current.get(event.sessionId)?.refresh();
    }, 150));
  }, []);
  return { states, refresh, notify };
}
