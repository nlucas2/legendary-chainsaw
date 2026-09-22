import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { daemonInvoke } from "./daemon";
import { startupSnapshot, validInitialization } from "./sessionStartup";
import type { DaemonEvent, SessionInitialization, SessionSummary } from "./types";
import { useSessionOperation } from "./useSessionOperation";

interface StartupState {
  initialization: SessionInitialization;
  verified: boolean;
  error?: string;
}

export function useSessionStartup(session: SessionSummary | null, connected: boolean, onReady: (sessionId: string, summary?: SessionSummary) => void) {
  const [states, setStates] = useState<Record<string, StartupState>>({});
  const current = useRef(states);
  const generations = useRef(new Map<string, number>());
  const activeId = useRef(session?.sessionId);
  activeId.current = session?.sessionId;
  const [refresh, requestRefresh] = useReducer((value: number) => value + 1, 0);
  const operation = useSessionOperation();
  const update = useCallback((sessionId: string, next: StartupState) => {
    generations.current.set(sessionId, (generations.current.get(sessionId) ?? 0) + 1);
    current.current = { ...current.current, [sessionId]: next };
    setStates(current.current);
  }, []);

  const track = useCallback((summary: SessionSummary): SessionSummary => {
    const known = current.current[summary.sessionId];
    if (known) return { ...summary, initialization: known.initialization };
    if (validInitialization(summary.initialization)) {
      update(summary.sessionId, { initialization: summary.initialization, verified: summary.initialization.phase === "ready" });
    }
    return summary;
  }, [update]);

  const reconcile = useCallback((summary: SessionSummary): SessionSummary => {
    const known = current.current[summary.sessionId];
    return known ? { ...summary, initialization: known.initialization } : summary;
  }, []);

  const notify = useCallback((event: DaemonEvent) => {
    if (event.type === "runtime_status" && !event.status.connected) {
      for (const id of Object.keys(current.current)) generations.current.set(id, (generations.current.get(id) ?? 0) + 1);
      current.current = {};
      setStates({});
    } else if (event.type === "session_deleted") {
      generations.current.set(event.sessionId, (generations.current.get(event.sessionId) ?? 0) + 1);
      const next = { ...current.current };
      delete next[event.sessionId];
      current.current = next;
      setStates(next);
    } else if (event.type === "session_initialization_changed" && validInitialization(event.initialization)) {
      update(event.sessionId, { initialization: event.initialization, verified: false });
      if (event.sessionId === activeId.current) requestRefresh();
    } else if (event.type === "event_gap" && (!event.sessionId || event.sessionId === activeId.current)) {
      requestRefresh();
    }
  }, [update]);

  const id = session?.sessionId;
  const status = id ? states[id] ?? (session?.initialization ? { initialization: session.initialization, verified: false } : undefined) : undefined;
  const enabled = !!id && !!status;
  useEffect(() => {
    if (!id || !enabled || !connected) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const generation = generations.current.get(id);
      let again = true;
      try {
        const result = startupSnapshot(await daemonInvoke("session_initialization", { sessionId: id },
          AbortSignal.any([controller.signal, AbortSignal.timeout(10000)])), id);
        if (controller.signal.aborted || activeId.current !== id) return;
        if (generations.current.get(id) !== generation) return;
        update(id, { initialization: result.initialization, verified: true });
        again = result.initialization.phase === "initializing";
        if (result.initialization.phase === "ready") onReady(id, result.session);
      } catch (cause) {
        if (!controller.signal.aborted && generations.current.get(id) === generation) {
          const known = current.current[id];
          if (known) update(id, { ...known, verified: false, error: `Could not read startup status: ${String(cause)}` });
        }
      } finally {
        if (!controller.signal.aborted && again) timer = setTimeout(() => void poll(), 1000);
      }
    };
    void poll();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [id, enabled, connected, refresh, update, onReady]);

  async function retry() {
    if (!id || !connected) return;
    const token = operation.start(id);
    if (!token) return;
    const generation = generations.current.get(id);
    try {
      const result = startupSnapshot(await daemonInvoke("retry_session_initialization", { sessionId: id }), id);
      if (generations.current.get(id) === generation) update(id, { initialization: result.initialization, verified: false });
      requestRefresh();
    } catch (cause) {
      const known = current.current[id];
      if (known && generations.current.get(id) === generation) update(id, { ...known, error: `Could not retry startup: ${String(cause)}` });
    } finally { operation.finish(id, token); }
  }
  return {
    track, reconcile, notify, status, retry, refresh: requestRefresh,
    retrying: !!id && !!operation.operations.get(id),
    ready: !enabled || (connected && status?.verified === true && status.initialization.phase === "ready"),
  };
}
