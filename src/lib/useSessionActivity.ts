import { useCallback, useEffect, useRef, useState } from "react";
import { createSingleflightReader, errorMessage } from "./context";
import { daemonInvoke } from "./daemon";
import { createRequestLimiter } from "./requestLimiter";
import { processingActivity, SessionActivityTracker, type SessionActivity } from "./sessionActivity";
import type { DaemonEvent, SessionSummary } from "./types";

interface ActivityRead {
  version: number;
  activity: SessionActivity;
}

export function useSessionActivity(sessions: SessionSummary[], connected: boolean) {
  const [tracker] = useState(() => new SessionActivityTracker());
  const [states, setStates] = useState<Record<string, SessionActivity>>({});
  const [limit] = useState(() => createRequestLimiter<ActivityRead>(4));
  const readers = useRef(new Map<string, ReturnType<typeof createSingleflightReader<ActivityRead>>>());
  const signature = JSON.stringify(sessions.filter((session) => session.isActive &&
    (!session.initialization || session.initialization.phase === "ready")).map((session) => session.sessionId).sort());
  const publish = useCallback(() => setStates(tracker.snapshot()), [tracker]);

  useEffect(() => {
    const ids = new Set<string>(connected ? JSON.parse(signature) : []);
    let changed = false;
    for (const [sessionId, reader] of readers.current) {
      if (ids.has(sessionId)) continue;
      reader.dispose();
      readers.current.delete(sessionId);
      changed = tracker.invalidate(sessionId) || changed;
    }
    if (changed) publish();
    for (const sessionId of ids) {
      if (readers.current.has(sessionId)) continue;
      const reader = createSingleflightReader(
        (signal) => limit(async () => {
          const version = tracker.version(sessionId);
          try {
            const value = await daemonInvoke("session_processing", { sessionId },
              AbortSignal.any([signal, AbortSignal.timeout(5000)]));
            return { version, activity: processingActivity(value) };
          } catch (cause) {
            if (signal.aborted) throw cause;
            return { version, activity: { kind: "unknown", reason: `Session status unavailable: ${errorMessage(cause)}` } };
          }
        }, signal),
        {
          loading: () => {},
          value: ({ version, activity }) => { if (tracker.accept(sessionId, version, activity)) publish(); },
          error: (cause) => {
            if (tracker.accept(sessionId, tracker.version(sessionId), { kind: "unknown", reason: errorMessage(cause) })) publish();
          },
        },
      );
      readers.current.set(sessionId, reader);
      if (!document.hidden) void reader.refresh();
    }
    const refresh = () => {
      if (!document.hidden) for (const reader of readers.current.values()) void reader.refresh();
    };
    const poll = window.setInterval(refresh, 5000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(poll);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [signature, connected, tracker, limit, publish]);

  useEffect(() => () => {
    readers.current.forEach((reader) => reader.dispose());
    readers.current.clear();
  }, []);

  const notify = useCallback((event: DaemonEvent) => {
    if (event.type === "event_gap") {
      let changed = false;
      for (const [sessionId, reader] of readers.current) {
        if (event.sessionId && sessionId !== event.sessionId) continue;
        changed = tracker.invalidate(sessionId) || changed;
        if (!document.hidden) void reader.refresh();
      }
      if (changed) publish();
    } else if (event.type === "session_deleted") {
      readers.current.get(event.sessionId)?.dispose();
      readers.current.delete(event.sessionId);
      if (tracker.invalidate(event.sessionId)) publish();
    } else if (event.type === "session_event" && readers.current.has(event.sessionId)) {
      if (tracker.observe(event.sessionId, event.event)) publish();
    }
  }, [tracker, publish]);

  return { states, notify };
}
