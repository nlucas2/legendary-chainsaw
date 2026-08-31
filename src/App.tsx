import {
  useCallback,
  useEffect,
  lazy,
  Suspense,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  CSSProperties,
  Dispatch,
  FormEvent,
  PointerEvent as ReactPointerEvent,
  SetStateAction,
} from "react";
import {
  BookOpen,
  Bot,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  FolderCog,
  Menu,
  MessageSquarePlus,
  PanelRightClose,
  PanelRightOpen,
  Pin,
  PinOff,
  Plus,
  Search,
  Send,
  Settings2,
  Square,
  TerminalSquare,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import "./App.css";
import { Transcript } from "./components/Transcript";
import {
  ReferenceDrawer,
  type ReferenceSectionName,
  type TaskCancelAction,
} from "./components/ReferenceDrawer";
import { RuntimePanel } from "./components/RuntimePanel";
import { ModelPicker } from "./components/ModelPicker";
import { SessionOrganizer } from "./components/SessionOrganizer";
import {
  SettingsPanel,
  type ThemePreference,
} from "./components/SettingsPanel";
import {
  DaemonError,
  daemonInvoke,
  daemonLogin,
  subscribeToDaemon,
} from "./lib/daemon";
import type {
  DaemonEvent,
  HistoryPage,
  PermissionRequest,
  SessionEvent,
  SessionReferences,
  SessionSummary,
  RuntimeStatus,
} from "./lib/types";

const DEFAULT_MODEL = "";
type HistoryState = "idle" | "loading" | "ready" | "error";
type CachedHistory = HistoryPage;

interface AvailableModelOption {
  id: string;
  name: string;
}

const TerminalPane = lazy(() =>
  import("./components/TerminalPane").then((module) => ({
    default: module.TerminalPane,
  })),
);

function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSession, setActiveSession] = useState<SessionSummary | null>(null);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [subagentContext, setSubagentContext] = useState<SessionEvent[]>([]);
  const [permissions, setPermissions] = useState<PermissionRequest[]>([]);
  const [connected, setConnected] = useState(false);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [historyState, setHistoryState] = useState<HistoryState>("idle");
  const [sessionReady, setSessionReady] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showRawEvents, setShowRawEvents] = useState(false);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [references, setReferences] = useState<SessionReferences | null>(null);
  const [referenceSectionLoading, setReferenceSectionLoading] =
    useState<ReferenceSectionName | "">("");
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [organizingSession, setOrganizingSession] =
    useState<SessionSummary | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [themePreference, setThemePreference] =
    useState<ThemePreference>(readThemePreference);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [composer, setComposer] = useState("");
  const [search, setSearch] = useState("");
  const [sessionRenderLimit, setSessionRenderLimit] = useState(100);
  const [collapsedGroups, setCollapsedGroups] =
    useState<Set<string>>(readCollapsedGroups);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [newModel, setNewModel] = useState(DEFAULT_MODEL);
  const [newSessionModels, setNewSessionModels] = useState<AvailableModelOption[]>([]);
  const [newSessionModelsLoading, setNewSessionModelsLoading] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalWidth, setTerminalWidth] = useState(520);
  const [followCwd, setFollowCwd] = useState(true);
  const [trackedCwd, setTrackedCwd] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const activeIdRef = useRef<string | null>(null);
  const historyCursorRef = useRef<string | null>(null);
  const historyCacheRef = useRef(new Map<string, CachedHistory>());
  const pendingLiveEventsRef = useRef<SessionEvent[]>([]);
  const liveEventFrameRef = useRef<number | null>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const followOutputRef = useRef(true);

  const queueLiveEvent = useCallback((event: SessionEvent) => {
    pendingLiveEventsRef.current.push(event);
    if (liveEventFrameRef.current !== null) return;
    liveEventFrameRef.current = requestAnimationFrame(() => {
      const pending = pendingLiveEventsRef.current;
      pendingLiveEventsRef.current = [];
      liveEventFrameRef.current = null;
      setEvents((current) => mergeEvents(current, pending));
    });
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const next = await daemonInvoke<SessionSummary[]>("list_sessions");
      setSessions(next);
      setNeedsLogin(false);
      if (!activeIdRef.current && next.length > 0) {
        void openSession(next[0], false);
      }
    } catch (cause) {
      handleError(cause, setError, setNeedsLogin);
    } finally {
      setLoading(false);
    }
  }, []);

  const openSession = useCallback(
    async (session: SessionSummary, closeSidebar = true) => {
      if (activeIdRef.current === session.sessionId) {
        if (closeSidebar) setSidebarOpen(false);
        return;
      }
      setError("");
      followOutputRef.current = true;
      pendingLiveEventsRef.current = [];
      if (liveEventFrameRef.current !== null) {
        cancelAnimationFrame(liveEventFrameRef.current);
        liveEventFrameRef.current = null;
      }
      activeIdRef.current = session.sessionId;
      setActiveSession(session);
      setSessionReady(false);
      if (session.cwd) setTrackedCwd(session.cwd);
      const cached = historyCacheRef.current.get(session.sessionId);
      setEvents(cached?.events ?? []);
      setHasMoreHistory(cached?.hasMore ?? false);
      historyCursorRef.current = cached?.cursor ?? null;
      setHistoryState(cached ? "ready" : "loading");
      setPermissions([]);
      setSubagentContext([]);
      setReferences(null);
      setReferenceOpen(false);
      if (closeSidebar) setSidebarOpen(false);

      // Persisted history and live-session attachment are independent daemon operations.
      // Start all three at once and reveal each result as soon as it is ready.
      const resumeRequest = daemonInvoke<SessionSummary>("resume_session", {
        sessionId: session.sessionId,
      });
      const historyRequest = session.isActive
        ? daemonInvoke<HistoryPage>("session_history", {
            sessionId: session.sessionId,
            cursor: null,
          })
        : resumeRequest.then(() =>
            daemonInvoke<HistoryPage>("session_history", {
              sessionId: session.sessionId,
              cursor: null,
            }),
          );
      const permissionRequest =
        daemonInvoke<PermissionRequest[]>("pending_permissions");

      const historyTask = historyRequest
        .then((page) => {
          cacheHistory(historyCacheRef.current, session.sessionId, page);
          if (activeIdRef.current !== session.sessionId) return;
          setEvents(page.events);
          setHasMoreHistory(page.hasMore);
          historyCursorRef.current = page.cursor;
          setHistoryState("ready");
        })
        .catch((cause) => {
          if (activeIdRef.current !== session.sessionId) return;
          setHistoryState("error");
          handleError(cause, setError, setNeedsLogin);
        });

      const permissionTask = permissionRequest
        .then((pending) => {
          if (activeIdRef.current !== session.sessionId) return;
          setPermissions(
            pending.filter((item) => item.sessionId === session.sessionId),
          );
        })
        .catch((cause) => handleError(cause, setError, setNeedsLogin));

      try {
        const resumed = await resumeRequest;
        if (activeIdRef.current !== session.sessionId) return;
        setActiveSession(resumed);
        setSessionReady(true);
        void daemonInvoke<SessionEvent[]>("subagent_context", {
          sessionId: session.sessionId,
        })
          .then((context) => {
            if (activeIdRef.current === session.sessionId) {
              setSubagentContext(context);
            }
          })
          .catch((cause) => {
            console.warn("Subagent metadata enrichment failed", cause);
          });
        if (resumed.cwd) setTrackedCwd(resumed.cwd);
        setSessions((current) =>
          current.map((item) =>
            item.sessionId === resumed.sessionId ? resumed : item,
          ),
        );
      } catch (cause) {
        if (activeIdRef.current === session.sessionId) {
          handleError(cause, setError, setNeedsLogin);
        }
      } finally {
        await Promise.allSettled([historyTask, permissionTask]);
      }
    },
    [],
  );

  useEffect(() => {
    void loadSessions();
    void daemonInvoke<RuntimeStatus>("runtime_status")
      .then(setRuntimeStatus)
      .catch(() => undefined);
    const unsubscribe = subscribeToDaemon(
      (event) => {
        setConnected(true);
        if (event.type === "runtime_status") {
          setRuntimeStatus(event.status);
          if (!event.status.connected) setSessionReady(false);
        }
        if (event.type === "session_event" && event.sessionId === activeIdRef.current) {
          const model = eventModel(event.event);
          if (model) {
            setActiveSession((current) => (current ? { ...current, model } : current));
            setSessions((current) =>
              current.map((session) =>
                session.sessionId === event.sessionId ? { ...session, model } : session,
              ),
            );
          }
        }
        handleDaemonEvent(
          event,
          activeIdRef.current,
          queueLiveEvent,
          setPermissions,
          loadSessions,
        );
      },
      setConnected,
    );
    return unsubscribe;
  }, [loadSessions, queueLiveEvent]);

  useEffect(
    () => () => {
      if (liveEventFrameRef.current !== null) {
        cancelAnimationFrame(liveEventFrameRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!followOutputRef.current) return;
    const conversation = conversationRef.current;
    if (!conversation) return;
    const frame = requestAnimationFrame(() => {
      conversation.scrollTop = conversation.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [events, permissions]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark =
        themePreference === "dark" || (themePreference === "auto" && media.matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", dark ? "#0b0f14" : "#f4ecd8");
      window.dispatchEvent(new CustomEvent("copilot-sessions-theme"));
    };
    try {
      localStorage.setItem("copilot-sessions.theme", themePreference);
    } catch {
      // Storage can be unavailable in private browsing; the in-memory setting still applies.
    }
    apply();
    const onSystemTheme = () => {
      if (themePreference === "auto") apply();
    };
    media.addEventListener("change", onSystemTheme);
    return () => media.removeEventListener("change", onSystemTheme);
  }, [themePreference]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== "copilot-sessions.theme") return;
      if (
        event.newValue === "auto" ||
        event.newValue === "light" ||
        event.newValue === "dark"
      ) {
        setThemePreference(event.newValue);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const filteredSessions = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return sessions;
    return sessions.filter(
      (session) =>
        session.title.toLowerCase().includes(query) ||
        session.cwd?.toLowerCase().includes(query) ||
        session.folder?.toLowerCase().includes(query) ||
        session.tags.some((tag) => tag.toLowerCase().includes(query)),
    );
  }, [search, sessions]);

  const sessionGroups = useMemo(
    () => groupSessions(filteredSessions.slice(0, sessionRenderLimit)),
    [filteredSessions, sessionRenderLimit],
  );

  useEffect(() => {
    setSessionRenderLimit(100);
  }, [search]);

  function toggleGroup(group: string) {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      try {
        localStorage.setItem(
          "copilot-sessions.collapsed-folders",
          JSON.stringify([...next]),
        );
      } catch {
        // The grouping still works when storage is unavailable.
      }
      return next;
    });
  }

  async function createSession(event: FormEvent) {
    event.preventDefault();
    if (!newCwd.trim()) return;
    setBusy(true);
    try {
      const session = await daemonInvoke<SessionSummary>("create_session", {
        cwd: newCwd.trim(),
        model: newModel || null,
      });
      setSessions((current) => [session, ...current]);
      setNewSessionOpen(false);
      await openSession(session);
    } catch (cause) {
      handleError(cause, setError, setNeedsLogin);
    } finally {
      setBusy(false);
    }
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const content = composer.trim();
    if (!activeSession || !sessionReady || !content || busy) return;
    setComposer("");
    setBusy(true);
    try {
      const slash = parseSlashCommand(content, references);
      if (slash) {
        const result = await daemonInvoke<Record<string, unknown>>("execute_command", {
          sessionId: activeSession.sessionId,
          commandName: slash.name,
          args: slash.args,
        });
        setEvents((current) => [
          ...current,
          {
            id: `command-${Date.now()}-${slash.name}`,
            timestamp: new Date().toISOString(),
            type: "command.result",
            data: { command: content, result },
          },
        ]);
      } else {
        await daemonInvoke("send_message", {
          sessionId: activeSession.sessionId,
          content,
        });
      }
    } catch (cause) {
      setComposer(content);
      handleError(cause, setError, setNeedsLogin);
    } finally {
      setBusy(false);
    }
  }

  async function decidePermission(requestId: string, approved: boolean) {
    try {
      await daemonInvoke("decide_permission", { requestId, approved });
      setPermissions((current) =>
        current.filter((item) => item.requestId !== requestId),
      );
    } catch (cause) {
      handleError(cause, setError, setNeedsLogin);
    }
  }

  async function deleteSession(session: SessionSummary) {
    if (!window.confirm(`Delete "${session.title}"? This cannot be undone.`)) return;
    try {
      await daemonInvoke("delete_session", { sessionId: session.sessionId });
      setSessions((current) =>
        current.filter((item) => item.sessionId !== session.sessionId),
      );
      if (activeIdRef.current === session.sessionId) {
        activeIdRef.current = null;
        setActiveSession(null);
        setEvents([]);
        setHistoryState("idle");
        setSessionReady(false);
      }
    } catch (cause) {
      handleError(cause, setError, setNeedsLogin);
    }
  }

  async function organizeSession(
    session: SessionSummary,
    organization: { pinned: boolean; folder?: string; tags: string[] },
  ) {
    const updated = await daemonInvoke<SessionSummary>("organize_session", {
      sessionId: session.sessionId,
      ...organization,
    });
    setSessions((current) =>
      sortSessions(
        current.map((item) => (item.sessionId === updated.sessionId ? updated : item)),
      ),
    );
    if (activeSession?.sessionId === updated.sessionId) setActiveSession(updated);
  }

  function openNewSession() {
    setNewCwd(trackedCwd || activeSession?.cwd || "");
    setNewModel(DEFAULT_MODEL);
    setNewSessionOpen(true);
    if (newSessionModels.length === 0 && !newSessionModelsLoading) {
      setNewSessionModelsLoading(true);
      void daemonInvoke<{ models?: unknown[] }>("available_models")
        .then((result) => setNewSessionModels(normalizeAvailableModels(result.models)))
        .catch((cause) => handleError(cause, setError, setNeedsLogin))
        .finally(() => setNewSessionModelsLoading(false));
    }
  }

  const loadReferences = useCallback(async () => {
    if (!activeIdRef.current) return;
    setReferences(emptySessionReferences());
  }, []);

  async function cancelTaskAction(action: TaskCancelAction) {
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    const sessionName = activeSession?.title ?? sessionId;
    const warning =
      action.kind === "main_turn"
        ? `This subagent is synchronous and cannot be cancelled independently. Abort the parent turn in “${sessionName}”? This stops Copilot’s current response and its synchronous children, but no other session.`
        : action.kind === "background_agents"
          ? `Stop all background agents in “${sessionName}”? The runtime exposes group cancellation for these agents, not an individual handle. No other Copilot session is affected.`
          : `Cancel this background task in “${sessionName}”?`;
    if (!window.confirm(warning)) return;
    if (action.kind === "main_turn") {
      await daemonInvoke("abort_session", { sessionId });
    } else if (action.kind === "background_agents") {
      await daemonInvoke("cancel_background_agents", { sessionId });
    } else {
      await daemonInvoke("cancel_task", { sessionId, taskId: action.id });
    }
    const context = await daemonInvoke<SessionEvent[]>("subagent_context", {
      sessionId,
    });
    if (activeIdRef.current === sessionId) setSubagentContext(context);
    await loadReferences();
  }

  const loadReferenceSection = useCallback(
    async (section: ReferenceSectionName) => {
      const sessionId = activeIdRef.current;
      if (!sessionId || referenceSectionLoading) return;
      setReferenceSectionLoading(section);
      try {
        const endpoint =
          section === "mcpTools"
            ? "mcp_tools"
            : section === "skills"
              ? "discover_skills"
              : section === "contextAttribution"
                ? "context_attribution"
                : "reference_section";
        const value = await daemonInvoke<unknown>(endpoint, {
          sessionId,
          ...(endpoint === "reference_section" ? { section } : {}),
        });
        if (activeIdRef.current !== sessionId) return;
        setReferences((current) =>
          current
            ? {
                ...current,
                [section]: { value },
              }
            : current,
        );
      } catch (cause) {
        if (activeIdRef.current !== sessionId) return;
        setReferences((current) =>
          current
            ? {
                ...current,
                [section]: {
                  error: cause instanceof Error ? cause.message : String(cause),
                },
              }
            : current,
        );
      } finally {
        if (activeIdRef.current === sessionId) setReferenceSectionLoading("");
      }
    },
    [referenceSectionLoading],
  );

  useEffect(() => {
    if (
      sessionReady &&
      !references &&
      (referenceOpen || composer.trimStart().startsWith("/"))
    ) {
      void loadReferences();
    }
  }, [composer, loadReferences, referenceOpen, references, sessionReady]);

  useEffect(() => {
    if (
      sessionReady &&
      references &&
      composer.trimStart().startsWith("/") &&
      references.commands.value === undefined &&
      !references.commands.error
    ) {
      void loadReferenceSection("commands");
    }
  }, [composer, loadReferenceSection, references, sessionReady]);

  const commandSuggestions = useMemo(
    () => filterSlashCommands(references, composer),
    [composer, references],
  );
  const subagentTaskEvents = useMemo(
    () =>
      mergeHistoryEvents(
        subagentContext,
        events.filter((event) => event.type.startsWith("subagent.")),
      ),
    [events, subagentContext],
  );

  async function loadEarlierHistory() {
    if (!activeSession || !hasMoreHistory || loadingMore) return;
    const sessionId = activeSession.sessionId;
    setLoadingMore(true);
    try {
      const page = await daemonInvoke<HistoryPage>("session_history", {
        sessionId,
        cursor: historyCursorRef.current,
      });
      if (activeIdRef.current !== sessionId) return;
      historyCursorRef.current = page.cursor;
      setHasMoreHistory(page.hasMore);
      setEvents((current) => {
        const combined = mergeHistoryEvents(page.events, current);
        cacheHistory(historyCacheRef.current, sessionId, {
          ...page,
          events: combined,
        });
        return combined;
      });
    } catch (cause) {
      handleError(cause, setError, setNeedsLogin);
    } finally {
      if (activeIdRef.current === sessionId) setLoadingMore(false);
    }
  }

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = terminalWidth;
    const onMove = (move: globalThis.PointerEvent) => {
      setTerminalWidth(
        Math.min(window.innerWidth * 0.72, Math.max(340, startWidth + startX - move.clientX)),
      );
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  const trackTerminalCwd = useCallback((cwd: string) => {
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    setTrackedCwd(cwd);
    setActiveSession((current) =>
      current?.sessionId === sessionId ? { ...current, cwd } : current,
    );
    setSessions((current) =>
      current.map((session) =>
        session.sessionId === sessionId ? { ...session, cwd } : session,
      ),
    );
    void daemonInvoke<string>("set_session_cwd", { sessionId, cwd }).catch((cause) =>
      handleError(cause, setError, setNeedsLogin),
    );
  }, []);

  if (needsLogin) {
    return <LoginScreen onLoggedIn={loadSessions} />;
  }

  return (
    <main
      className={`app-shell ${terminalOpen ? "terminal-visible" : ""}`}
      style={{ "--terminal-width": `${terminalWidth}px` } as CSSProperties}
    >
      <aside className={sidebarOpen ? "sidebar open" : "sidebar"}>
        <div className="brand">
          <div className="brand-mark">
            <Bot size={20} />
          </div>
          <div>
            <strong>Copilot Sessions</strong>
            <span>daemon workspace</span>
          </div>
          <button
            className="icon-button mobile-only"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close sessions"
          >
            <X size={18} />
          </button>
        </div>
        <button className="new-session-button" onClick={openNewSession}>
          <MessageSquarePlus size={17} />
          New session
          <span>⌘ N</span>
        </button>
        <label className="session-search">
          <Search size={15} />
          <input
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder="Search sessions"
          />
        </label>
        <div className="sidebar-label">Sessions</div>
        <nav
          className="session-list"
          onScroll={(event) => {
            const element = event.currentTarget;
            if (
              element.scrollHeight - element.scrollTop - element.clientHeight < 240 &&
              sessionRenderLimit < filteredSessions.length
            ) {
              setSessionRenderLimit((current) =>
                Math.min(current + 100, filteredSessions.length),
              );
            }
          }}
        >
          {loading && <div className="sidebar-placeholder">Loading sessions…</div>}
          {!loading && filteredSessions.length === 0 && (
            <div className="sidebar-placeholder">No matching sessions</div>
          )}
          {sessionGroups.map((group) => {
            const collapsed = !group.bare && collapsedGroups.has(group.key);
            return (
              <section className="session-group" key={group.key}>
                {!group.bare && (
                  <button
                    className="session-group-heading"
                    onClick={() => toggleGroup(group.key)}
                    aria-expanded={!collapsed}
                  >
                    {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    {group.pinned && <Pin size={11} />}
                    <span>{group.name}</span>
                    <i>{group.sessions.length}</i>
                  </button>
                )}
                {!collapsed &&
                  group.sessions.map((session) => (
                    <SessionRow
                      key={session.sessionId}
                      session={session}
                      active={activeSession?.sessionId === session.sessionId}
                      onOpen={() => void openSession(session)}
                      onTogglePin={() =>
                        void organizeSession(session, {
                          pinned: !session.pinned,
                          folder: session.folder,
                          tags: session.tags,
                        })
                      }
                      onOrganize={() => setOrganizingSession(session)}
                      onDelete={() => void deleteSession(session)}
                    />
                  ))}
              </section>
            );
          })}
          {sessionRenderLimit < filteredSessions.length && (
            <div className="session-list-progress">
              Showing {Math.min(sessionRenderLimit, filteredSessions.length)} of{" "}
              {filteredSessions.length}
            </div>
          )}
        </nav>
        <button className="daemon-state" onClick={() => setSettingsOpen(true)}>
          {connected ? <Wifi size={14} /> : <WifiOff size={14} />}
          <span>
            {!connected
              ? "Reconnecting…"
              : runtimeStatus?.connected === false
                ? "Copilot disconnected"
                : runtimeStatus?.acceptingWork === false
                  ? "Copilot draining"
                  : "Daemon connected"}
          </span>
          <Settings2 size={14} />
        </button>
      </aside>

      {sidebarOpen && (
        <button
          className="sidebar-scrim"
          aria-label="Close sessions"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <section className="workspace">
        <header className="workspace-header">
          <button
            className="icon-button mobile-menu"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open sessions"
          >
            <Menu size={19} />
          </button>
          <div className="session-heading">
            <h1>{activeSession?.title ?? "Copilot Sessions"}</h1>
            <div className="session-context">
              {activeSession ? (
                <>
                  <button
                    className="model-trigger"
                    title="Change this session's model"
                    onClick={() => setModelPickerOpen(true)}
                  >
                    {activeSession.model || "Resolving model…"}
                  </button>
                  <i />
                  <button title={activeSession.cwd}>{activeSession.cwd || "No CWD"}</button>
                </>
              ) : (
                <span>Select or create a session</span>
              )}
            </div>
          </div>
          <div className="header-actions">
            {activeSession && busy && (
              <button
                className="icon-button"
                title="Stop current turn"
                onClick={() =>
                  void daemonInvoke("abort_session", {
                    sessionId: activeSession.sessionId,
                  })
                }
              >
                <Square size={15} />
              </button>
            )}
            <button
              className={showRawEvents ? "icon-button active" : "icon-button"}
              title="Toggle raw session event stream"
              disabled={!activeSession}
              onClick={() => setShowRawEvents((current) => !current)}
            >
              {showRawEvents ? <EyeOff size={17} /> : <Eye size={17} />}
              <span className="desktop-label">Trace</span>
            </button>
            <button
              className={referenceOpen ? "icon-button active" : "icon-button"}
              title="Browse commands, tools, skills, MCP, and instructions"
              disabled={!sessionReady}
              onClick={() => setReferenceOpen((current) => !current)}
            >
              <BookOpen size={17} />
              <span className="desktop-label">Context</span>
            </button>
            <button
              className={terminalOpen ? "icon-button active" : "icon-button"}
              title={terminalOpen ? "Hide terminal" : "Open terminal"}
              disabled={!activeSession?.cwd && !trackedCwd}
              onClick={() => setTerminalOpen((current) => !current)}
            >
              <TerminalSquare size={18} />
              <span className="desktop-label">Terminal</span>
              {terminalOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
            </button>
          </div>
        </header>

        {error && (
          <div className="error-banner">
            <span>{error}</span>
            <button onClick={() => setError("")}>
              <X size={15} />
            </button>
          </div>
        )}

        {runtimeStatus && (!runtimeStatus.connected || !runtimeStatus.acceptingWork) && (
          <div className="runtime-banner">
            <span>
              {runtimeStatus.connected
                ? "Copilot is draining; new prompts are paused."
                : "Copilot and MCP processes are disconnected. Terminals remain available."}
            </span>
            <button onClick={() => setRuntimeOpen(true)}>Runtime maintenance</button>
          </div>
        )}

        <div
          className="conversation"
          ref={conversationRef}
          onScroll={(event) => {
            const element = event.currentTarget;
            followOutputRef.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 120;
          }}
        >
          {historyState === "ready" && hasMoreHistory && (
            <div className="history-pagination">
              <button
                className="button secondary"
                disabled={loadingMore}
                onClick={() => void loadEarlierHistory()}
              >
                {loadingMore ? "Loading…" : "Load earlier messages"}
              </button>
            </div>
          )}
          <Transcript
            hasSession={activeSession !== null}
            loading={historyState === "loading"}
            events={events}
            subagentContext={subagentContext}
            permissions={permissions}
            showRawEvents={showRawEvents}
            onPermission={(requestId, approved) =>
              void decidePermission(requestId, approved)
            }
          />
        </div>

        <form className="composer" onSubmit={sendMessage}>
          {composer.trimStart().startsWith("/") && (
            <div className="command-palette">
              <header>
                <strong>Session commands</strong>
                <span>Experimental SDK surface</span>
              </header>
              {referenceSectionLoading === "commands" && (
                <div className="command-placeholder">Discovering commands…</div>
              )}
              {referenceSectionLoading !== "commands" &&
                commandSuggestions.map((command) => (
                  <button
                    type="button"
                    key={command.name}
                    onClick={() => setComposer(`/${command.name} `)}
                  >
                    <code>/{command.name}</code>
                    <span>{command.description}</span>
                  </button>
                ))}
              {referenceSectionLoading !== "commands" &&
                commandSuggestions.length === 0 && (
                <div className="command-placeholder">
                  No matching runtime command. It will be sent as a normal prompt.
                </div>
                )}
            </div>
          )}
          <textarea
            value={composer}
            onChange={(event) => setComposer(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={
              activeSession && sessionReady
                ? "Ask Copilot anything…"
                : activeSession
                  ? "Connecting to session…"
                  : "Select a session to start chatting"
            }
            disabled={!activeSession || !sessionReady}
            rows={1}
          />
          <div className="composer-footer">
            <span>Enter to send · Shift+Enter for a new line</span>
            <button
              className="send-button"
              type="submit"
              disabled={!activeSession || !sessionReady || !composer.trim() || busy}
            >
              <Send size={16} />
            </button>
          </div>
        </form>
      </section>

      {terminalOpen && activeSession && (
        <>
          <div className="pane-resizer" onPointerDown={startResize} />
          <Suspense fallback={<div className="terminal-loading">Opening terminal…</div>}>
            <TerminalPane
              key={activeSession.sessionId}
              sessionId={activeSession.sessionId}
              cwd={activeSession?.cwd || trackedCwd}
              followCwd={followCwd}
              onFollowCwdChange={setFollowCwd}
              onCwdChange={trackTerminalCwd}
              onClose={() => setTerminalOpen(false)}
            />
          </Suspense>
        </>
      )}

      {referenceOpen && (
        <>
          <button
            className="reference-scrim"
            aria-label="Close context"
            onClick={() => setReferenceOpen(false)}
          />
          <ReferenceDrawer
            references={references}
            loading={false}
            onClose={() => setReferenceOpen(false)}
            onRefresh={() => void loadReferences()}
            onRequestSection={(section) => void loadReferenceSection(section)}
            sectionLoading={referenceSectionLoading}
            subagentEvents={subagentTaskEvents}
            onCancelTask={(action) => void cancelTaskAction(action)}
            onInsert={(text) => {
              setComposer((current) => `${current}${current ? " " : ""}${text}`);
              setReferenceOpen(false);
            }}
          />
        </>
      )}

      {runtimeOpen && (
        <RuntimePanel
          onClose={() => setRuntimeOpen(false)}
          onStatusChange={(status: RuntimeStatus) => {
            setRuntimeStatus(status);
            if (!status.connected) {
              setSessionReady(false);
              return;
            }
            if (activeSession && !sessionReady) {
              const session = activeSession;
              activeIdRef.current = null;
              void openSession(session, false);
            }
          }}
        />
      )}

      {settingsOpen && (
        <SettingsPanel
          themePreference={themePreference}
          onThemePreferenceChange={setThemePreference}
          onClose={() => setSettingsOpen(false)}
          onOpenRuntime={() => {
            setSettingsOpen(false);
            setRuntimeOpen(true);
          }}
        />
      )}

      {modelPickerOpen && activeSession && (
        <ModelPicker
          sessionId={activeSession.sessionId}
          onClose={() => setModelPickerOpen(false)}
          onChanged={(model) => {
            setActiveSession((current) => (current ? { ...current, model } : current));
            setSessions((current) =>
              current.map((session) =>
                session.sessionId === activeSession.sessionId
                  ? { ...session, model }
                  : session,
              ),
            );
          }}
        />
      )}

      {organizingSession && (
        <SessionOrganizer
          session={organizingSession}
          onClose={() => setOrganizingSession(null)}
          onSave={(organization) => organizeSession(organizingSession, organization)}
        />
      )}

      {newSessionOpen && (
        <div className="modal-backdrop" role="presentation">
          <form className="new-session-modal" onSubmit={createSession}>
            <header>
              <div>
                <span>Workspace</span>
                <h2>Start a new session</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setNewSessionOpen(false)}
              >
                <X size={18} />
              </button>
            </header>
            <label>
              Working directory
              <input
                autoFocus
                value={newCwd}
                onChange={(event) => setNewCwd(event.currentTarget.value)}
                placeholder="Q:\\gitp\\my-project"
              />
              <small>
                {trackedCwd && trackedCwd === newCwd
                  ? "Tracking the terminal's current directory."
                  : "Copilot tools resolve relative paths from here."}
              </small>
            </label>
            <label>
              Model
              <select
                value={newModel}
                onChange={(event) => setNewModel(event.currentTarget.value)}
                disabled={newSessionModelsLoading}
              >
                <option value="">
                  {newSessionModelsLoading ? "Loading models…" : "Auto — Copilot chooses"}
                </option>
                {newSessionModels.map((model) => (
                  <option value={model.id} key={model.id}>
                    {model.name} ({model.id})
                  </option>
                ))}
              </select>
              <small>
                Auto lets Copilot resolve the model based on the session and prompt.
              </small>
            </label>
            <footer>
              <button
                type="button"
                className="button secondary"
                onClick={() => setNewSessionOpen(false)}
              >
                Cancel
              </button>
              <button className="button primary" type="submit" disabled={!newCwd.trim()}>
                <Plus size={16} />
                Create session
              </button>
            </footer>
          </form>
        </div>
      )}
    </main>
  );
}

interface SessionGroup {
  key: string;
  name: string;
  pinned?: boolean;
  bare?: boolean;
  sessions: SessionSummary[];
}

function SessionRow({
  session,
  active,
  onOpen,
  onTogglePin,
  onOrganize,
  onDelete,
}: {
  session: SessionSummary;
  active: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
  onOrganize: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={active ? "session-item active" : "session-item"}>
      <button className="session-open" onClick={onOpen}>
        {session.pinned && <Pin className="session-pin" size={12} />}
        <span className="session-main">
          <strong>{session.title}</strong>
          <small>
            {session.folder && <em>{session.folder}</em>}
            {compactPath(session.cwd) || "No working directory"}
          </small>
          {session.tags.length > 0 && (
            <span className="session-tags">
              {session.tags.slice(0, 3).map((tag) => (
                <i key={tag}>{tag}</i>
              ))}
            </span>
          )}
        </span>
      </button>
      <span className="session-meta">
        {relativeTime(session.modifiedTime)}
        {active && (
          <>
            <button
              className="session-action"
              onClick={onTogglePin}
              aria-label={
                session.pinned ? `Unpin ${session.title}` : `Pin ${session.title}`
              }
            >
              {session.pinned ? <PinOff size={13} /> : <Pin size={13} />}
            </button>
            <button
              className="session-action"
              onClick={onOrganize}
              aria-label={`Organize ${session.title}`}
            >
              <FolderCog size={13} />
            </button>
            <button
              className="session-action delete-session"
              onClick={onDelete}
              aria-label={`Delete ${session.title}`}
            >
              <Trash2 size={13} />
            </button>
          </>
        )}
      </span>
    </div>
  );
}

function LoginScreen({ onLoggedIn }: { onLoggedIn: () => Promise<void> }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await daemonLogin(token);
      await onLoggedIn();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="brand-mark large">
          <Bot size={27} />
        </div>
        <span className="login-kicker">Copilot Sessions</span>
        <h1>Connect to your workspace</h1>
        <p>Enter the access token configured on the sessions daemon.</p>
        <label>
          Access token
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.currentTarget.value)}
            autoFocus
          />
        </label>
        {error && <div className="login-error">{error}</div>}
        <button className="button primary" disabled={busy || !token}>
          {busy ? "Connecting…" : "Connect"}
        </button>
      </form>
    </main>
  );
}

function handleDaemonEvent(
  event: DaemonEvent,
  activeSessionId: string | null,
  queueEvent: (event: SessionEvent) => void,
  setPermissions: Dispatch<SetStateAction<PermissionRequest[]>>,
  refresh: () => Promise<void>,
) {
  if (event.type === "session_event" && event.sessionId === activeSessionId) {
    queueEvent(event.event);
  } else if (
    event.type === "permission_requested" &&
    event.sessionId === activeSessionId
  ) {
    setPermissions((current) => [
      ...current.filter((item) => item.requestId !== event.requestId),
      event,
    ]);
  } else if (event.type === "permission_resolved") {
    setPermissions((current) =>
      current.filter((item) => item.requestId !== event.requestId),
    );
  } else if (
    event.type === "session_deleted" ||
    (event.type === "session_attached" && event.sessionId !== activeSessionId)
  ) {
    void refresh();
  }
}

function mergeEvents(events: SessionEvent[], incoming: SessionEvent[]): SessionEvent[] {
  if (incoming.length === 0) return events;
  const merged = [...events];
  const positions = new Map(merged.map((event, index) => [event.id, index]));
  for (const event of incoming) {
    const index = positions.get(event.id);
    if (index === undefined) {
      positions.set(event.id, merged.length);
      merged.push(event);
    } else {
      merged[index] = event;
    }
  }
  return merged;
}

function mergeHistoryEvents(
  older: SessionEvent[],
  current: SessionEvent[],
): SessionEvent[] {
  const byId = new Map<string, SessionEvent>();
  for (const event of [...older, ...current]) byId.set(event.id, event);
  return [...byId.values()].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp),
  );
}

function cacheHistory(
  cache: Map<string, CachedHistory>,
  sessionId: string,
  page: HistoryPage,
) {
  cache.delete(sessionId);
  cache.set(sessionId, {
    ...page,
  });
  while (cache.size > 5) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function sortSessions(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    return right.modifiedTime.localeCompare(left.modifiedTime);
  });
}

function groupSessions(sessions: SessionSummary[]): SessionGroup[] {
  const groups: SessionGroup[] = [];
  const pinned = sessions.filter((session) => session.pinned);
  if (pinned.length > 0) {
    groups.push({
      key: "pinned",
      name: "Pinned",
      pinned: true,
      sessions: pinned,
    });
  }

  const folders = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    if (session.pinned || !session.folder) continue;
    const current = folders.get(session.folder) ?? [];
    current.push(session);
    folders.set(session.folder, current);
  }
  for (const folder of [...folders.keys()].sort((a, b) => a.localeCompare(b))) {
    groups.push({
      key: `folder:${folder}`,
      name: folder,
      sessions: folders.get(folder) ?? [],
    });
  }

  const loose = sessions.filter((session) => !session.pinned && !session.folder);
  if (loose.length > 0) {
    groups.push({
      key: "loose",
      name: "",
      bare: true,
      sessions: loose,
    });
  }
  return groups;
}

function readCollapsedGroups(): Set<string> {
  try {
    const value = JSON.parse(
      localStorage.getItem("copilot-sessions.collapsed-folders") ?? "[]",
    );
    if (Array.isArray(value)) {
      return new Set(value.filter((item): item is string => typeof item === "string"));
    }
  } catch {
    // Start expanded when the saved preference cannot be read.
  }
  return new Set();
}

function emptySessionReferences(): SessionReferences {
  return {
    commands: {},
    skills: {},
    mcp: {},
    mcpTools: {},
    tools: {},
    instructions: {},
    contextAttribution: {},
    tasks: {},
  };
}

function normalizeAvailableModels(models: unknown[] | undefined): AvailableModelOption[] {
  if (!Array.isArray(models)) return [];
  return models.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const model = value as { id?: unknown; name?: unknown };
    if (typeof model.id !== "string" || model.id.toLowerCase() === "auto") return [];
    return [
      {
        id: model.id,
        name: typeof model.name === "string" ? model.name : model.id,
      },
    ];
  });
}

interface SlashCommand {
  name: string;
  description: string;
}

function availableSlashCommands(
  references: SessionReferences | null,
): SlashCommand[] {
  if (!references?.commands.value || typeof references.commands.value !== "object") {
    return [];
  }
  const commands = (references.commands.value as { commands?: unknown }).commands;
  if (!Array.isArray(commands)) return [];
  return commands.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const item = value as { name?: unknown; description?: unknown };
    if (typeof item.name !== "string") return [];
    return [
      {
        name: item.name,
        description:
          typeof item.description === "string" ? item.description : "Session command",
      },
    ];
  });
}

function filterSlashCommands(
  references: SessionReferences | null,
  input: string,
): SlashCommand[] {
  const query = input.trimStart().slice(1).split(/\s/, 1)[0].toLowerCase();
  return availableSlashCommands(references)
    .filter((command) => command.name.toLowerCase().includes(query))
    .slice(0, 8);
}

function parseSlashCommand(
  content: string,
  references: SessionReferences | null,
): { name: string; args: string } | null {
  const match = content.match(/^\/(\S+)(?:\s+(.*))?$/s);
  if (!match) return null;
  const command = availableSlashCommands(references).find(
    (item) => item.name.toLowerCase() === match[1].toLowerCase(),
  );
  return command ? { name: command.name, args: match[2] ?? "" } : null;
}

function handleError(
  cause: unknown,
  setError: (value: string) => void,
  setNeedsLogin: (value: boolean) => void,
) {
  if (cause instanceof DaemonError && cause.status === 401) {
    setNeedsLogin(true);
    return;
  }
  setError(cause instanceof Error ? cause.message : String(cause));
}

function eventModel(event: SessionEvent): string {
  if (event.type === "session.auto_mode_resolved") {
    const value = event.data.chosenModel;
    return typeof value === "string" ? value : "";
  }
  if (event.type === "session.model_change" || event.type === "session.model_changed") {
    const value = event.data.modelId ?? event.data.model;
    return typeof value === "string" ? value : "";
  }
  return "";
}

function readThemePreference(): ThemePreference {
  try {
    const value = localStorage.getItem("copilot-sessions.theme");
    if (value === "auto" || value === "light" || value === "dark") {
      return value;
    }
  } catch {
    // Use the default when storage is unavailable.
  }
  return "auto";
}

function compactPath(path?: string): string {
  if (!path) return "";
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}

function relativeTime(timestamp: string): string {
  if (!timestamp) return "";
  const time = new Date(timestamp).getTime();
  if (!Number.isFinite(time)) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export default App;
