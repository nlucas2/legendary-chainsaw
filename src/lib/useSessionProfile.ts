import { useCallback, useEffect, useRef, useState } from "react";
import { daemonInvoke } from "./daemon";
import { createSingleflightReader, errorMessage } from "./context";
import { normalizeSessionProfile, type SessionProfileStatus } from "./profiles";

export function useSessionProfile(sessionId: string | undefined, connected: boolean, onApplied: (id: string) => void) {
  const [state, setState] = useState<{ id?: string; status: SessionProfileStatus | null; error: string }>({ status: null, error: "" });
  const reader = useRef<ReturnType<typeof createSingleflightReader<SessionProfileStatus>> | null>(null);
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  const applied = useRef(onApplied);
  applied.current = onApplied;
  useEffect(() => {
    setState({ id: sessionId, status: null, error: "" });
    if (!sessionId || !connected) return;
    const request = createSingleflightReader(async (signal) =>
      normalizeSessionProfile(await daemonInvoke("get_session_profile", { sessionId },
        AbortSignal.any([signal, AbortSignal.timeout(10000)])), sessionId), {
      loading: () => {},
      value: (status) => {
        setState({ id: sessionId, status, error: "" });
      },
      error: (cause) => setState((current) => ({ ...current, error: errorMessage(cause) })),
    });
    reader.current = request;
    void request.refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void request.refresh(); }, 2500);
    return () => { request.dispose(); window.clearInterval(timer); if (reader.current === request) reader.current = null; };
  }, [sessionId, connected]);
  const refresh = useCallback(() => { void reader.current?.refresh(); }, []);
  const replace = useCallback((status: SessionProfileStatus) => {
    if (status.sessionId === currentSession.current) {
      reader.current?.replace(status);
      if (!status.applying && !status.configurationBlocked) applied.current(status.sessionId);
    }
  }, []);
  return { status: state.id === sessionId ? state.status : null, error: state.id === sessionId ? state.error : "", refresh, replace };
}
