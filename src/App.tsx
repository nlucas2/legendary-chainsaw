import {
  useCallback,
  useEffect,
  lazy,
  Suspense,
  useMemo,
  useReducer,
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
  Archive,
  ArchiveRestore,
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
  RefreshCw,
  Paperclip,
  Pencil,
  PanelBottom,
  PanelTop,
  GitBranch,
  MessageCircleQuestion,
  TerminalSquare,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import "./App.css";
import "./components/chat-controls.css";
import { Transcript } from "./components/Transcript";
import type {
  ReferenceSectionName,
  TaskCancelAction,
} from "./components/ReferenceDrawer";
import { RuntimePanel } from "./components/RuntimePanel";
import { ModelPicker } from "./components/ModelPicker";
import { RenameSession } from "./components/RenameSession";
import { GitWorkspaceButton } from "./components/GitWorkspaceButton";
import { ForkSession } from "./components/ForkSession";
import { useTerminalLayout } from "./lib/useTerminalLayout";
import { useTypography } from "./lib/useTypography";
import { useChatWidth } from "./lib/useChatWidth";
import { resizedTerminal, terminalSizeLimits } from "./lib/workspaceLayout";
import { slashCommandSuggestions } from "./lib/slashCommands";
import "./components/workspace-actions.css";
import { SessionSubagents } from "./components/SessionSubagents";
import { agentKey, type AgentTask } from "./lib/agentTasks";
import { useAgentTasks } from "./lib/useAgentTasks";
import { SessionOrganizer } from "./components/SessionOrganizer";
import { ReviewContextChip } from "./components/ReviewContextChip";
import { reviewAttachment, withReviewAttachment, type ReviewChatContext } from "./lib/reviewChat";
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
import {
  aggregateModelConfiguration,
  labelModelValue,
  normalizeModelOptions,
  type ModelOption,
} from "./lib/models";
import {
  activityFromEvent,
  activityIsProcessing,
  activityTimings,
  emptyActivity,
  isTranscriptEvent,
  submittedActivity,
  type ChatActivity,
} from "./lib/chatActivity";
import { attachmentPayload, readAttachment, validateAttachments, type AttachmentDraft } from "./lib/attachments";
import { chatDraftReducer, EMPTY_SESSION_DRAFTS } from "./lib/chatDrafts";
import { mergeEvents, mergeHistoryEvents, reconcileOptimisticUserEvents } from "./lib/history";
import { useSessionOperation } from "./lib/useSessionOperation";
import { useSessionActivity } from "./lib/useSessionActivity";
import { sessionActivityIndicator, type SessionActivity } from "./lib/sessionActivity";
import { filterSessions, groupSessions, SessionArchiveChanges, type SessionView } from "./lib/sessionList";
import type {
  AgentMode,
  DaemonEvent,
  HistoryPage,
  PermissionRequest,
  PendingInteraction,
  QueueItems,
  ReasoningSummary,
  SessionEvent,
  SessionReferences,
  SessionRefresh,
  SessionSummary,
  RuntimeStatus,
  SessionState,
} from "./lib/types";

const DEFAULT_MODEL = "";
type HistoryState = "idle" | "loading" | "ready" | "error";
type CachedHistory = HistoryPage;

interface HistoryReceipt {
  sessionId: string;
  loadedAt: string;
  newestEventAt?: string;
  eventCount: number;
  humanMessages: number;
  loadedPages: number;
  runtimeRecycled: boolean;
  truncatedBeforeAnchor: boolean;
}

interface StreamStatus {
  state: "recovering" | "recovered";
  message: string;
}

const TerminalPane = lazy(() =>
  import("./components/TerminalPane").then((module) => ({
    default: module.TerminalPane,
  })),
);
const ReferenceDrawer = lazy(() =>
  import("./components/ReferenceDrawer").then((module) => ({ default: module.ReferenceDrawer })),
);
const InteractionPanel = lazy(() =>
  import("./components/InteractionPanel").then((module) => ({ default: module.InteractionPanel })),
);
const AgentConversation = lazy(() =>
  import("./components/AgentConversation").then((module) => ({ default: module.AgentConversation })),
);
const AskPanel = lazy(() =>
  import("./components/AskPanel").then((module) => ({ default: module.AskPanel })),
);
const GitPanel = lazy(() =>
  import("./components/GitPanel").then((module) => ({ default: module.GitPanel })),
);

function App() {
  const typography = useTypography();
  const chatWidth = useChatWidth();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionView, setSessionView] = useState<SessionView>("current");
  const [archiveChanges] = useState(() => new SessionArchiveChanges());
  const archiveOperation = useSessionOperation();
  const [archiveError, setArchiveError] = useState("");
  const [archiveErrorLocation, setArchiveErrorLocation] = useState<"sidebar" | "workspace">("sidebar");
  const [archiveNotice, setArchiveNotice] = useState<{ sessionId: string; title: string; archived: boolean } | null>(null);
  const sessionViewControl = useRef<HTMLSelectElement>(null);
  const sessionListRef = useRef<HTMLElement>(null);
  const [activeSession, setActiveSession] = useState<SessionSummary | null>(null);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [subagentContext, setSubagentContext] = useState<SessionEvent[]>([]);
  const [permissions, setPermissions] = useState<PermissionRequest[]>([]);
  const [connected, setConnected] = useState(false);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const activityConnected = connected && runtimeStatus?.connected !== false;
  const sidebarActivity = useSessionActivity(sessions, activityConnected);
  const [expandedSessions, setExpandedSessions] = useState(new Set<string>());
  const [selectedAgent, setSelectedAgent] = useState<{ sessionId: string; task: AgentTask } | null>(null);
  const [agentDrafts, dispatchAgentDraft] = useReducer(chatDraftReducer, {});
  const agentSend = useSessionOperation();
  const trackedAgentSessions = useMemo(() => {
    const tracked = new Set(expandedSessions);
    if (selectedAgent) tracked.add(selectedAgent.sessionId);
    return tracked;
  }, [expandedSessions, selectedAgent?.sessionId]);
  const agentTasks = useAgentTasks(sessions, trackedAgentSessions, runtimeStatus?.connected !== false);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [historyState, setHistoryState] = useState<HistoryState>("idle");
  const [sessionReady, setSessionReady] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const historyOperation = useSessionOperation();
  const catchUpOperation = useSessionOperation();
  const [historyReceipt, setHistoryReceipt] = useState<HistoryReceipt | null>(null);
  const [historyWindowStartId, setHistoryWindowStartId] = useState<string | undefined>();
  const [sessionProcessing, setSessionProcessing] = useState<boolean | null>(null);
  const [streamStatus, setStreamStatus] = useState<StreamStatus | null>(null);
  const [streamStalled, setStreamStalled] = useState(false);
  const [showRawEvents, setShowRawEvents] = useState(false);
  const [reasoningExpanded, setReasoningExpanded] = useState(true);
  const [toolDetailsExpanded, setToolDetailsExpanded] = useState(false);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [references, setReferences] = useState<SessionReferences | null>(null);
  const [referenceSectionLoading, setReferenceSectionLoading] =
    useState<ReferenceSectionName | "">("");
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [organizingSession, setOrganizingSession] =
    useState<SessionSummary | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [renamingSession, setRenamingSession] = useState<SessionSummary | null>(null);
  const [forkingSession, setForkingSession] = useState<SessionSummary | null>(null);
  const [forkingName, setForkingName] = useState<string | undefined>();
  const [askPanel, setAskPanel] = useState<{ id: string; sessionId: string; question: string; submitOnOpen: boolean; reviewContext?: ReviewChatContext } | null>(null);
  const [gitOpen, setGitOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [themePreference, setThemePreference] =
    useState<ThemePreference>(readThemePreference);
  const [creatingSession, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [drafts, dispatchDraft] = useReducer(chatDraftReducer, {});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const draftSessionId = activeSession?.sessionId ?? "";
  const sessionDrafts = drafts[draftSessionId] ?? EMPTY_SESSION_DRAFTS;
  const composer = sessionDrafts.current.text;
  const attachmentDrafts = sessionDrafts.current.attachments;
  const setComposer = (value: SetStateAction<string>) => dispatchDraft({
    type: "edit", sessionId: draftSessionId,
    update: (draft) => ({ ...draft, text: typeof value === "function" ? value(draft.text) : value }),
  });
  const setAttachmentDrafts = (value: SetStateAction<AttachmentDraft[]>) => dispatchDraft({
    type: "edit", sessionId: draftSessionId,
    update: (draft) => ({ ...draft, attachments: typeof value === "function" ? value(draft.attachments) : value }),
  });
  const attachmentOperation = useSessionOperation();
  const sendOperation = useSessionOperation();
  const modeOperation = useSessionOperation();
  const queueOperation = useSessionOperation();
  const readingAttachments = !!attachmentOperation.operations.get(draftSessionId);
  const busy = creatingSession || !!sendOperation.operations.get(draftSessionId);
  const catchingUp = !!catchUpOperation.operations.get(draftSessionId);
  const loadingMore = !!historyOperation.operations.get(draftSessionId);
  const [deliveryMode, setDeliveryMode] = useState<"enqueue" | "immediate">("enqueue");
  const [activity, setActivity] = useState<ChatActivity>(emptyActivity);
  const [interactions, setInteractions] = useState<PendingInteraction[]>([]);
  const [contextRevision, setContextRevision] = useState(0);
  const modeBusy = !!modeOperation.operations.get(draftSessionId);
  const [modeConfirmation, setModeConfirmation] = useState<{ mode: AgentMode; detail: string } | null>(null);
  const [modeNotice, setModeNotice] = useState("");
  const [queueError, setQueueError] = useState("");
  const queueBusy = queueOperation.operations.get(draftSessionId);
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null);
  const [editingQueueText, setEditingQueueText] = useState("");
  const [rawDiagnostics, setRawDiagnostics] = useState<SessionEvent[]>([]);
  const [agentMode, setAgentMode] = useState<AgentMode>("interactive");
  const [queue, setQueue] = useState<QueueItems>({
    items: [],
    steeringMessages: [],
  });
  const [search, setSearch] = useState("");
  const [sessionRenderLimit, setSessionRenderLimit] = useState(100);
  const [collapsedGroups, setCollapsedGroups] =
    useState<Set<string>>(readCollapsedGroups);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [newModel, setNewModel] = useState(DEFAULT_MODEL);
  const [newReasoningEffort, setNewReasoningEffort] = useState("");
  const [newReasoningSummary, setNewReasoningSummary] =
    useState<ReasoningSummary>("detailed");
  const [newContextTier, setNewContextTier] = useState("");
  const [newSessionModels, setNewSessionModels] = useState<ModelOption[]>([]);
  const [newSessionModelsLoading, setNewSessionModelsLoading] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const terminalLayout = useTerminalLayout();
  const terminalWidth = terminalLayout.width;
  const terminalDrag = useRef<{ x: number; y: number; size: number } | null>(null);
  const [followCwd, setFollowCwd] = useState(true);
  const [trackedCwd, setTrackedCwd] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const activeIdRef = useRef<string | null>(null);
  const createSessionPendingRef = useRef(false);
  const historyCursorRef = useRef<string | null>(null);
  const historyCacheRef = useRef(new Map<string, CachedHistory>());
  const pendingLiveEventsRef = useRef<SessionEvent[]>([]);
  const liveEventFlushRef = useRef<number | null>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const submitDeliveryRef = useRef<"enqueue" | "immediate" | null>(null);
  const promptHistoryRef = useRef<string[]>([]);
  const promptHistoryIndexRef = useRef(-1);
  const activityRef = useRef<ChatActivity>(emptyActivity());
  const activityGenerationRef = useRef(0);
  const showRawEventsRef = useRef(false);
  const queueRequestsRef = useRef(new Map<string, Promise<void>>());
  const queueDirtyRef = useRef(new Set<string>());
  const referenceRequestsRef = useRef(new Map<string, Promise<void>>());
  const interactionRequestsRef = useRef(new Map<string, Promise<void>>());
  const interactionDirtyRef = useRef(new Set<string>());
  const referenceGenerationRef = useRef(0);
  const followOutputRef = useRef(true);
  const backfillPromisesRef = useRef(new Map<string, Promise<void>>());
  const processingRef = useRef(false);
  const lastLiveEventAtRef = useRef(0);
  const sseConnectedRef = useRef(false);
  const pendingResponseRef = useRef<string | null>(null);
  const initialSessionIdRef = useRef(new URLSearchParams(window.location.search).get("session"));
  const selectedNewSessionModel = useMemo(
    () =>
      newSessionModels.find((model) => model.id === newModel) ??
      aggregateModelConfiguration(newSessionModels),
    [newModel, newSessionModels],
  );

  function scrollToLatestHumanTurn() {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const conversation = conversationRef.current;
        if (!conversation) return;
        const humanTurns = conversation.querySelectorAll<HTMLElement>("[data-root-human]");
        const latest = humanTurns[humanTurns.length - 1];
        if (latest) {
          latest.scrollIntoView({ block: "start" });
          followOutputRef.current = false;
        } else {
          conversation.scrollTop = conversation.scrollHeight;
          followOutputRef.current = true;
        }
      });
    });
  }

  const flushLiveEvents = useCallback(() => {
    if (liveEventFlushRef.current !== null) window.clearTimeout(liveEventFlushRef.current);
    liveEventFlushRef.current = null;
    const pending = pendingLiveEventsRef.current;
    pendingLiveEventsRef.current = [];
    if (pending.length === 0) return;
    setEvents((current) => mergeEvents(reconcileOptimisticUserEvents(current, pending), pending));
  }, []);

  const queueLiveEvent = useCallback((event: SessionEvent) => {
    pendingLiveEventsRef.current.push(event);
    if (liveEventFlushRef.current !== null) return;
    liveEventFlushRef.current = window.setTimeout(flushLiveEvents, 16);
  }, [flushLiveEvents]);

  useEffect(() => {
    showRawEventsRef.current = showRawEvents;
    if (!showRawEvents) setRawDiagnostics([]);
  }, [showRawEvents]);

  useEffect(() => {
    const flush = () => flushLiveEvents();
    document.addEventListener("visibilitychange", flush);
    return () => document.removeEventListener("visibilitychange", flush);
  }, [flushLiveEvents]);

  const loadSessions = useCallback(async () => {
    try {
      const checkpoint = archiveChanges.checkpoint();
      const next = (await daemonInvoke<SessionSummary[]>("list_sessions")).map((session) => archiveChanges.reconcile(session, checkpoint));
      setSessions(next);
      setNeedsLogin(false);
      if (!activeIdRef.current) {
        const requested = initialSessionIdRef.current;
        const session = requested ? next.find((item) => item.sessionId === requested) : next.find((item) => !item.archived);
        if (session) {
          if (requested && session.archived) setSessionView("archived");
          void openSession(session, false);
        }
        else if (requested) {
          const resumed = archiveChanges.reconcile(await daemonInvoke<SessionSummary>("resume_session", { sessionId: requested }), checkpoint);
          if (!activeIdRef.current) {
            if (resumed.archived) setSessionView("archived");
            setSessions((current) => current.some((item) => item.sessionId === requested) ? current : [resumed, ...current]);
            void openSession(resumed, false);
          }
        }
      }
    } catch (cause) {
      handleError(cause, setError, setNeedsLogin);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadQueue = useCallback((sessionId = activeIdRef.current): Promise<void> => {
    if (!sessionId) {
      setQueue({ items: [], steeringMessages: [] });
      return Promise.resolve();
    }
    const running = queueRequestsRef.current.get(sessionId);
    if (running) {
      queueDirtyRef.current.add(sessionId);
      return running;
    }
    const request = (async () => {
      do {
        queueDirtyRef.current.delete(sessionId);
        const next = await daemonInvoke<QueueItems>("queue_items", { sessionId });
        if (activeIdRef.current === sessionId) {
          setQueue(next);
          setQueueError("");
        }
      } while (queueDirtyRef.current.has(sessionId));
    })()
      .catch((cause) => {
        if (activeIdRef.current === sessionId) setQueueError(String(cause));
      })
      .finally(() => {
        queueRequestsRef.current.delete(sessionId);
        queueDirtyRef.current.delete(sessionId);
      });
    queueRequestsRef.current.set(sessionId, request);
    return request;
  }, []);

  const loadInteractions = useCallback((sessionId: string): Promise<void> => {
    const running = interactionRequestsRef.current.get(sessionId);
    if (running) {
      interactionDirtyRef.current.add(sessionId);
      return running;
    }
    const request = (async () => {
      do {
        interactionDirtyRef.current.delete(sessionId);
        const pending = await daemonInvoke<PendingInteraction[]>("pending_interactions", { sessionId });
        if (!interactionDirtyRef.current.has(sessionId) && activeIdRef.current === sessionId) {
          setInteractions(pending);
          if (pending.length) {
            activityRef.current = { ...activityRef.current, phase: "waiting" };
            setActivity(activityRef.current);
          }
        }
      } while (interactionDirtyRef.current.has(sessionId));
    })().catch((cause) => {
      if (activeIdRef.current === sessionId) handleError(cause, setError, setNeedsLogin);
    }).finally(() => {
      interactionRequestsRef.current.delete(sessionId);
      interactionDirtyRef.current.delete(sessionId);
    });
    interactionRequestsRef.current.set(sessionId, request);
    return request;
  }, []);

  const openSession = useCallback(
    async (session: SessionSummary, closeSidebar = true) => {
      if (activeIdRef.current === session.sessionId) {
        if (closeSidebar) setSidebarOpen(false);
        return;
      }
      setError("");
      followOutputRef.current = false;
      pendingLiveEventsRef.current = [];
      if (liveEventFlushRef.current !== null) {
        window.clearTimeout(liveEventFlushRef.current);
        liveEventFlushRef.current = null;
      }
      activeIdRef.current = session.sessionId;
      setSelectedAgent(null);
      setAskPanel(null);
      setGitOpen(false);
      setActiveSession(session);
      setAgentMode("interactive");
      setModeConfirmation(null);
      setModeNotice("");
      activityGenerationRef.current += 1;
      activityRef.current = emptyActivity();
      setActivity(activityRef.current);
      setInteractions([]);
      submitDeliveryRef.current = null;
      setRawDiagnostics([]);
      setQueueError("");
      setEditingQueueId(null);
      setQueue({ items: [], steeringMessages: [] });
      setSessionReady(false);
      if (session.cwd) setTrackedCwd(session.cwd);
      const cached = historyCacheRef.current.get(session.sessionId);
      setEvents(cached?.events ?? []);
      setHasMoreHistory(cached?.hasMore ?? false);
      historyCursorRef.current = cached?.cursor ?? null;
      setHistoryState(cached ? "ready" : "loading");
      setHistoryReceipt(null);
      setHistoryWindowStartId(cached?.windowStartEventId);
      setSessionProcessing(null);
      setStreamStatus(null);
      setStreamStalled(false);
      processingRef.current = false;
      lastLiveEventAtRef.current = 0;
      pendingResponseRef.current = null;
      setPermissions([]);
      setSubagentContext([]);
      setReferences(null);
      referenceGenerationRef.current += 1;
      setReferenceOpen(false);
      if (closeSidebar) setSidebarOpen(false);

      // Persisted history and live-session attachment are independent daemon operations.
      // Start all three at once and reveal each result as soon as it is ready.
      const archiveCheckpoint = archiveChanges.checkpoint();
      const resumeRequest = daemonInvoke<SessionSummary>("resume_session", {
        sessionId: session.sessionId,
      });
      const historyRequest = resumeRequest.then(() =>
        daemonInvoke<HistoryPage>("session_history_window", {
          sessionId: session.sessionId,
        }),
      );
      const permissionRequest =
        daemonInvoke<PermissionRequest[]>("pending_permissions");

      const historyTask = historyRequest
        .then((page) => {
          cacheHistory(historyCacheRef.current, session.sessionId, page);
          if (activeIdRef.current !== session.sessionId) return;
          setEvents((current) =>
            mergeHistoryEvents(
              page.events,
              reconcileOptimisticUserEvents(current, page.events),
            ),
          );
          setHasMoreHistory(page.hasMore);
          historyCursorRef.current = page.cursor;
          setHistoryState("ready");
          setHistoryWindowStartId(page.windowStartEventId);
          setHistoryReceipt(createHistoryReceipt(session.sessionId, page, false));
          pendingResponseRef.current = hasUnansweredRootTurn(page.events)
            ? session.sessionId
            : null;
          scrollToLatestHumanTurn();
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
        const resumed = archiveChanges.reconcile(await resumeRequest, archiveCheckpoint);
        if (activeIdRef.current !== session.sessionId) return;
        setActiveSession(resumed);
        setSessionReady(true);
        void loadInteractions(session.sessionId);
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
  }, [loadSessions]);

  const applyArchiveChange = useCallback((sessionId: string, archived: boolean) => {
    archiveChanges.record(sessionId, archived);
    setSessions((current) => current.map((session) => session.sessionId === sessionId ? { ...session, archived } : session));
    setActiveSession((current) => current?.sessionId === sessionId ? { ...current, archived } : current);
  }, [archiveChanges]);

  useEffect(() => {
    let previouslyConnected = false;
    const unsubscribe = subscribeToDaemon(
      (event) => {
        if (event.type === "session_archive_changed") applyArchiveChange(event.sessionId, event.archived);
        if (event.type === "event_gap") void loadSessions();
        agentTasks.notify(event);
        sidebarActivity.notify(event);
        setConnected(true);
        if (event.type === "interaction_requested" &&
            event.interaction.sessionId === activeIdRef.current) {
          void loadInteractions(event.interaction.sessionId);
          activityRef.current = { ...activityRef.current, phase: "waiting" };
          setActivity(activityRef.current);
        } else if (event.type === "interaction_resolved" &&
                   event.sessionId === activeIdRef.current) {
          setInteractions((current) => current.filter((item) => item.requestId !== event.requestId));
          void loadInteractions(event.sessionId);
        }
        if (event.type === "session_event" && event.sessionId === activeIdRef.current &&
            ["user_input.requested", "user_input.completed", "elicitation.requested", "elicitation.completed"].includes(event.event.type)) {
          void loadInteractions(event.sessionId);
        }
        if (event.type === "runtime_status") {
          setRuntimeStatus(event.status);
          if (!event.status.connected) setSessionReady(false);
        }
        if (event.type === "tool_inventory_updated" && event.sessionId === activeIdRef.current) {
          setContextRevision((current) => current + 1);
        }
        if (
          event.type === "event_gap" &&
          (!event.sessionId || event.sessionId === activeIdRef.current)
        ) {
          const sessionId = activeIdRef.current;
          setStreamStatus({
            state: "recovering",
            message: `Recovering ${event.skipped.toLocaleString()} skipped live events…`,
          });
          if (sessionId) {
            void backfillSession(sessionId, event.skipped, true)
              .catch((cause) => handleError(cause, setError, setNeedsLogin));
          }
        }
        if (event.type === "session_event" && event.sessionId === activeIdRef.current) {
          if (showRawEventsRef.current) {
            setRawDiagnostics((current) => [...current.slice(-99), event.event]);
          }
          const nextActivity = activityFromEvent(activityRef.current, event.event, Date.now());
          if (nextActivity !== activityRef.current) {
            activityRef.current = nextActivity;
            activityGenerationRef.current += 1;
            setActivity(nextActivity);
            processingRef.current = activityIsProcessing(nextActivity);
            setSessionProcessing(processingRef.current);
          }
          lastLiveEventAtRef.current = Date.now();
          setStreamStalled(false);
          if (
            !event.event.agentId &&
            event.event.type === "user.message"
          ) {
            followOutputRef.current = true;
          }
          if (!event.event.agentId && event.event.type === "user.message") {
            pendingResponseRef.current = event.sessionId;
          } else if (
            !event.event.agentId &&
            eventHasAssistantText(event.event)
          ) {
            pendingResponseRef.current = null;
          }
          const model = eventModel(event.event);
          if (model) {
            setActiveSession((current) => (current ? { ...current, model } : current));
            setSessions((current) =>
              current.map((session) =>
                session.sessionId === event.sessionId ? { ...session, model } : session,
              ),
            );
          }
          if (event.event.type === "session.mode_changed") {
            const mode = eventAgentMode(event.event);
            if (mode) setAgentMode(mode);
          }
          if (event.event.type === "pending_messages.modified") {
            void loadQueue(event.sessionId);
          }
          if ([
            "session.idle", "session.tools_updated", "session.mcp_servers_loaded",
            "session.mcp_server_status_changed", "session.mode_changed",
          ].includes(event.event.type)) {
            setContextRevision((current) => current + 1);
          }
          if (event.event.type === "session.idle" && !event.event.agentId) {
            processingRef.current = false;
            setSessionProcessing(false);
            if (pendingResponseRef.current === event.sessionId) {
              setStreamStatus({
                state: "recovering",
                message: "Session finished before its response arrived · recovering…",
              });
              void backfillSession(event.sessionId, 0, true)
                .catch((cause) => handleError(cause, setError, setNeedsLogin));
            }
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
      (isConnected) => {
        if (isConnected && previouslyConnected) void loadSessions();
        if (isConnected) previouslyConnected = true;
        sseConnectedRef.current = isConnected;
        setConnected(isConnected);
        if (isConnected && activeIdRef.current) void loadInteractions(activeIdRef.current);
      },
      showRawEvents,
    );
    return unsubscribe;
  }, [loadQueue, loadSessions, loadInteractions, queueLiveEvent, showRawEvents, applyArchiveChange, sidebarActivity.notify]);

  useEffect(
    () => () => {
      if (liveEventFlushRef.current !== null) {
        window.clearTimeout(liveEventFlushRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    void loadQueue(sessionReady ? activeSession?.sessionId ?? null : null);
  }, [activeSession?.sessionId, loadQueue, sessionReady]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const key = event.key.toLowerCase();
      const modifier = event.ctrlKey || event.metaKey;
      const editing = isEditableTarget(event.target);
      const inComposer = event.target === composerRef.current;
      const inTerminal = event.target instanceof Element && !!event.target.closest(".terminal-pane");
      const modal = event.target instanceof Element
        ? event.target.closest(".modal-backdrop,.model-backdrop,.settings-backdrop,.runtime-backdrop,.ask-backdrop,.git-backdrop")
        : null;

      if (event.key === "Escape") {
        if (shortcutsOpen || newSessionOpen || renamingSession || forkingSession || askPanel || gitOpen || modeConfirmation || modelPickerOpen ||
            settingsOpen || organizingSession || runtimeOpen || referenceOpen) {
          event.preventDefault();
          setShortcutsOpen(false);
          setNewSessionOpen(false);
          setRenamingSession(null);
          setForkingSession(null);
          setAskPanel(null);
          setGitOpen(false);
          setModeConfirmation(null);
          setModelPickerOpen(false);
          setSettingsOpen(false);
          setOrganizingSession(null);
          setRuntimeOpen(false);
          setReferenceOpen(false);
          composerRef.current?.focus();
        }
        return;
      }

      if (event.key === "F6" && !modal) {
        event.preventDefault();
        const regions = [
          document.querySelector<HTMLTextAreaElement>(".agent-composer textarea") ?? composerRef.current,
          document.querySelector<HTMLDivElement>(".agent-conversation .conversation") ?? conversationRef.current,
          document.querySelector<HTMLElement>('input[placeholder="Search sessions"]'),
          document.querySelector<HTMLElement>(".terminal-host .xterm-helper-textarea"),
        ].filter((region): region is HTMLElement => region !== null);
        const index = regions.findIndex((region) => region === document.activeElement);
        regions[(index + (event.shiftKey ? -1 : 1) + regions.length) % regions.length]?.focus();
        return;
      }
      if (inTerminal && !(modifier && event.shiftKey && key === "t")) return;

      if (modal) {
        if (event.key === "Tab") {
          const controls = Array.from(modal.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],summary',
          )).filter((element) => element.offsetParent !== null);
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault(); last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault(); first?.focus();
          }
        }
        return;
      }
      if (selectedAgent && !(modifier && key === "n") &&
          !(modifier && event.shiftKey && (key === "t" || key === "b"))) {
        if (modifier && key === "k") {
          event.preventDefault();
          document.querySelector<HTMLTextAreaElement>(".agent-composer textarea")?.focus();
        }
        return;
      }
      if (event.altKey && !event.ctrlKey && !event.metaKey) {
        const mode =
          key === "1" ? "interactive" : key === "2" ? "plan" : key === "3" ? "autopilot" : null;
        if (mode) {
          event.preventDefault();
          void changeMode(mode);
          composerRef.current?.focus();
        }
        return;
      }

      if (modifier && event.shiftKey && key === "t") {
        event.preventDefault();
        if (activeIdRef.current) setTerminalOpen((current) => !current);
        return;
      }
      if (modifier && event.shiftKey && key === "b") {
        event.preventDefault();
        setSidebarOpen((current) => !current);
        return;
      }
      if (modifier && key === "n") {
        event.preventDefault();
        openNewSession();
        return;
      }
      if (modifier && key === ".") {
        if (processingRef.current) {
          event.preventDefault();
          void stopTurn();
        }
        return;
      }
      if (modifier && event.shiftKey && key === "backspace") {
        const item = [...queue.items]
          .reverse()
          .find((queued) => !queued.id.startsWith("local-queue-"));
        if (item) {
          event.preventDefault();
          void removeQueueItem(item.id);
        }
        return;
      }
      if (modifier && key === "t") {
        event.preventDefault();
        setReasoningExpanded((current) => !current);
        return;
      }
      if (modifier && key === "o" && !editing) {
        event.preventDefault();
        setToolDetailsExpanded((current) => !current);
        return;
      }
      if (modifier && key === "e" && !editing) {
        event.preventDefault();
        setReasoningExpanded(true);
        setToolDetailsExpanded(true);
        return;
      }
      if (event.ctrlKey && key === "c" && !editing && processingRef.current) {
        if (!window.getSelection()?.toString()) {
          event.preventDefault();
          void stopTurn();
        }
        return;
      }

      if (inComposer) {
        if (modifier && key === "q") {
          event.preventDefault();
          submitDeliveryRef.current = "enqueue";
          composerRef.current?.form?.requestSubmit();
        } else if (modifier && key === "s") {
          event.preventDefault();
          dispatchDraft({ type: "stash", sessionId: draftSessionId });
        } else if (modifier && key === "r") {
          event.preventDefault();
          const history = promptHistoryRef.current;
          if (history.length) {
            promptHistoryIndexRef.current = (promptHistoryIndexRef.current + 1) % history.length;
            setComposer(history[history.length - 1 - promptHistoryIndexRef.current]);
          }
        }
        return;
      }
      if (editing) return;

      if (key === "?" || (modifier && key === "/")) {
        event.preventDefault();
        setShortcutsOpen(true);
      } else if (key === "/") {
        event.preventDefault();
        setComposer((current) => current || "/");
        requestAnimationFrame(() => composerRef.current?.focus());
      } else if (modifier && key === "k") {
        event.preventDefault();
        composerRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [queue.items, shortcutsOpen, newSessionOpen, modeConfirmation, modelPickerOpen,
      settingsOpen, organizingSession, runtimeOpen, referenceOpen, modeBusy,
      composer, trackedCwd, activeSession, newSessionModels, newSessionModelsLoading, selectedAgent, renamingSession, forkingSession, askPanel, gitOpen]);

  useEffect(() => {
    if (!activeSession || !sessionReady || runtimeStatus?.connected === false) {
      setSessionProcessing(null);
      setStreamStalled(false);
      processingRef.current = false;
      return;
    }
    const sessionId = activeSession.sessionId;
    let cancelled = false;

    let timer: number | undefined;
    const poll = async () => {
      const generation = activityGenerationRef.current;
      void loadInteractions(sessionId);
      try {
        const snapshot = await daemonInvoke<SessionState>("session_state", {
          sessionId,
        });
        if (cancelled || activeIdRef.current !== sessionId) return;
        if (generation !== activityGenerationRef.current) return;
        const processing = snapshot.processing;
        setAgentMode(snapshot.mode);
        const wasProcessing = processingRef.current;
        processingRef.current = processing;
        setSessionProcessing(processing);
        setStreamStalled(processing && lastLiveEventAtRef.current > 0 &&
          Date.now() - lastLiveEventAtRef.current > 10_000);
        if (processing && !activityIsProcessing(activityRef.current)) {
          activityRef.current = { ...activityRef.current, phase: "working" };
          setActivity(activityRef.current);
        } else if (!processing && activityIsProcessing(activityRef.current)) {
          activityRef.current = { ...activityRef.current, phase: "idle", finishedAt: Date.now() };
          setActivity(activityRef.current);
        }
        if (wasProcessing && !processing && pendingResponseRef.current === sessionId) {
          setStreamStatus({
            state: "recovering",
            message: "Session became idle before its response arrived · recovering…",
          });
          await backfillSession(sessionId, 0, true);
        }
      } catch (cause) {
        if (!cancelled && activeIdRef.current === sessionId) {
          setSessionProcessing(null);
          setError(`Session status unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(
            () => void poll(),
            5000,
          );
        }
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeSession?.sessionId, runtimeStatus?.connected, sessionReady]);

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

  const filteredSessions = useMemo(() => filterSessions(sessions, search, sessionView), [search, sessions, sessionView]);
  const archivedCount = sessions.filter((session) => session.archived === true).length;
  const activeArchived = (sessions.find((session) => session.sessionId === activeSession?.sessionId) ?? activeSession)?.archived === true;

  const sessionGroups = useMemo(
    () => groupSessions(filteredSessions.slice(0, sessionRenderLimit)),
    [filteredSessions, sessionRenderLimit],
  );

  useEffect(() => {
    setSessionRenderLimit(100);
    sessionListRef.current?.scrollTo({ top: 0 });
  }, [search, sessionView]);

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
    if (createSessionPendingRef.current || !newCwd.trim()) return;
    createSessionPendingRef.current = true;
    setBusy(true);
    try {
      const session = await daemonInvoke<SessionSummary>("create_session", {
        cwd: newCwd.trim(),
        model: newModel || null,
        reasoningEffort: newReasoningEffort || null,
        reasoningSummary: newReasoningSummary,
        contextTier: newContextTier || null,
      });
      setSessions((current) => [session, ...current]);
      setNewSessionOpen(false);
      await openSession(session);
    } catch (cause) {
      handleError(cause, setError, setNeedsLogin);
    } finally {
      createSessionPendingRef.current = false;
      setBusy(false);
    }
  }

  function backfillSession(
    sessionId: string,
    skipped = 0,
    rerunAfterCurrent = false,
  ): Promise<void> {
    const current = backfillPromisesRef.current.get(sessionId);
    if (current) {
      return rerunAfterCurrent
        ? current
            .catch(() => undefined)
            .then(() => backfillSession(sessionId, skipped))
        : current;
    }
    const task = (async () => {
      const page = await daemonInvoke<HistoryPage>("session_history_window", {
        sessionId,
      });
      if (activeIdRef.current !== sessionId) return;
      setEvents((current) => {
        const reconciled = reconcileOptimisticUserEvents(current, page.events);
        const combined = mergeHistoryEvents(page.events, reconciled);
        cacheHistory(historyCacheRef.current, sessionId, {
          ...page,
          events: combined,
        });
        return combined;
      });
      setHasMoreHistory(page.hasMore);
      historyCursorRef.current = page.cursor;
      setHistoryWindowStartId(page.windowStartEventId);
      setHistoryReceipt(createHistoryReceipt(sessionId, page, false));
      pendingResponseRef.current = hasUnansweredRootTurn(page.events)
        ? sessionId
        : null;
      if (skipped > 0) {
        const message = `Recovered after ${skipped.toLocaleString()} skipped live events`;
        setStreamStatus({
          state: "recovered",
          message,
        });
        window.setTimeout(() => {
          setStreamStatus((current) =>
            current?.message === message ? null : current,
          );
        }, 5000);
      } else {
        setStreamStatus(null);
      }
    })().finally(() => {
      if (backfillPromisesRef.current.get(sessionId) === task) {
        backfillPromisesRef.current.delete(sessionId);
      }
    });
    backfillPromisesRef.current.set(sessionId, task);
    return task;
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const content = composer.trim();
    if (
      !activeSession ||
      !sessionReady ||
      (!content && attachmentDrafts.length === 0) ||
      sendOperation.operations.get(activeSession.sessionId) ||
      readingAttachments ||
      modeBusy ||
      runtimeStatus?.acceptingWork === false
    ) {
      return;
    }
    const slashMatch = content.match(/^\/(\S+)(?:\s+(.*))?$/s);
    const slash = slashMatch ? { name: slashMatch[1], args: slashMatch[2] ?? "" } : null;
    if (slash && attachmentDrafts.length > 0) {
      setError("Send attachments with a chat message, not a slash command.");
      return;
    }
    if (slash?.name === "ask") {
      dispatchDraft({ type: "submitted", sessionId: activeSession.sessionId });
      submitDeliveryRef.current = null;
      setAskPanel({ id: crypto.randomUUID(), sessionId: activeSession.sessionId, question: slash.args, submitOnOpen: !!slash.args.trim() });
      return;
    }
    if (slash?.name === "fork") {
      dispatchDraft({ type: "submitted", sessionId: activeSession.sessionId });
      submitDeliveryRef.current = null;
      setForkingName(slash.args.trim() || undefined);
      setForkingSession(activeSession);
      return;
    }
    const attachments = attachmentDrafts;
    try {
      validateAttachments([], attachments.map((attachment) => ({ size: attachment.size, name: attachment.displayName })));
    } catch (cause) {
      setError(String(cause));
      return;
    }
    const delivery = submitDeliveryRef.current ?? deliveryMode;
    submitDeliveryRef.current = null;
    const optimisticId = slash ? "" : `optimistic-user-${crypto.randomUUID()}`;
    const sessionId = activeSession.sessionId;
    const queued = processingRef.current && delivery === "enqueue";
    const optimisticQueueId = queued ? `local-queue-${crypto.randomUUID()}` : "";
    if (content) {
      promptHistoryRef.current = [...promptHistoryRef.current.slice(-99), content];
      promptHistoryIndexRef.current = -1;
    }
    const token = sendOperation.start(sessionId);
    if (!token) return;
    dispatchDraft({ type: "submitted", sessionId });
    const submittedAt = Date.now();
    if (!queued && !slash) {
      setSessionProcessing(true);
      processingRef.current = true;
      pendingResponseRef.current = sessionId;
      activityGenerationRef.current += 1;
      activityRef.current = submittedActivity(submittedAt);
      setActivity(activityRef.current);
    }
    lastLiveEventAtRef.current = submittedAt;
    setStreamStalled(false);
    followOutputRef.current = true;
    if (optimisticQueueId) {
      setQueue((current) => ({
        ...current,
        items: [
          ...current.items,
          {
            id: optimisticQueueId,
            displayText: content || attachments.map((item) => item.displayName).join(", "),
            kind: "message",
            agentMode,
          },
        ],
      }));
    }
    if (optimisticId && !queued) {
      if (activeIdRef.current === sessionId) setEvents((current) => [
        ...current,
        {
          id: optimisticId,
          timestamp: new Date().toISOString(),
          type: "user.message",
          data: {
            content,
            optimistic: true,
            attachments: attachments.map(({ displayName, mimeType }) => ({ type: "blob", displayName, mimeType })),
          },
        },
      ]);
    }
    try {
      if (slash) {
        const result = await daemonInvoke<Record<string, unknown>>("execute_command", {
          sessionId,
          commandName: slash.name,
          args: slash.args,
        });
        if (activeIdRef.current === sessionId) setEvents((current) => [
          ...current,
          {
            id: `command-${Date.now()}-${slash.name}`,
            timestamp: new Date().toISOString(),
            type: "command.result",
            data: { command: content, result },
          },
        ]);
        void loadQueue(sessionId);
      } else {
        await daemonInvoke("send_message", {
          sessionId,
          content,
          agentMode,
          deliveryMode: delivery,
          attachments: attachmentPayload(attachments),
        });
        if (activeIdRef.current === sessionId && activityRef.current.submittedAt === submittedAt) {
          activityRef.current = {
            ...activityRef.current,
            phase: activityRef.current.phase === "submitting" ? "working" : activityRef.current.phase,
            acceptedAt: activityRef.current.acceptedAt ?? Date.now(),
          };
          setActivity(activityRef.current);
        }
        void loadQueue(sessionId);
      }
    } catch (cause) {
      dispatchDraft({
        type: "failed", sessionId, id: optimisticId || crypto.randomUUID(),
        draft: { text: composer, attachments }, error: String(cause),
      });
      if (activeIdRef.current !== sessionId) {
        return;
      }
      if (optimisticId) {
        setEvents((current) => current.filter((event) => event.id !== optimisticId));
      }
      if (optimisticQueueId) {
        setQueue((current) => ({
          ...current,
          items: current.items.filter((item) => item.id !== optimisticQueueId),
        }));
      }
      handleError(cause, setError, setNeedsLogin);
      if (!queued) {
        activityRef.current = { ...activityRef.current, phase: "error", error: String(cause) };
        setActivity(activityRef.current);
        processingRef.current = false;
        setSessionProcessing(false);
      }
    } finally {
      sendOperation.finish(sessionId, token);
    }
  }

  async function catchUpSession() {
    if (
      !activeSession ||
      busy ||
      catchingUp ||
      sessionProcessing ||
      runtimeStatus?.connected === false
    ) {
      return;
    }
    const sessionId = activeSession.sessionId;
    const token = catchUpOperation.start(sessionId);
    if (!token) return;
    setError("");
    setSessionReady(false);
    setHistoryState("loading");
    followOutputRef.current = false;
    flushLiveEvents();

    try {
      const refreshed = await daemonInvoke<SessionRefresh>("refresh_session", {
        sessionId,
      });
      if (activeIdRef.current !== sessionId) return;
      cacheHistory(historyCacheRef.current, sessionId, refreshed.history);
      setEvents((current) =>
        mergeHistoryEvents(
          refreshed.history.events,
          reconcileOptimisticUserEvents(current, refreshed.history.events),
        ),
      );
      setPermissions([]);
      setHasMoreHistory(refreshed.history.hasMore);
      historyCursorRef.current = refreshed.history.cursor;
      setActiveSession(refreshed.session);
      setSessions((current) =>
        current.map((session) =>
          session.sessionId === sessionId ? refreshed.session : session,
        ),
      );
      if (refreshed.session.cwd) setTrackedCwd(refreshed.session.cwd);
      setHistoryState("ready");
      setSessionReady(true);
      setHistoryWindowStartId(refreshed.history.windowStartEventId);
      setHistoryReceipt(
        createHistoryReceipt(sessionId, refreshed.history, refreshed.runtimeRecycled),
      );
      scrollToLatestHumanTurn();
      void daemonInvoke<SessionEvent[]>("subagent_context", { sessionId })
        .then((context) => {
          if (activeIdRef.current === sessionId) setSubagentContext(context);
        })
        .catch((cause) => {
          console.warn("Subagent metadata enrichment failed", cause);
        });
    } catch (cause) {
      if (activeIdRef.current === sessionId) {
        setHistoryState(events.length > 0 ? "ready" : "error");
        try {
          const [status, refreshedSessions] = await Promise.all([
            daemonInvoke<RuntimeStatus>("runtime_status"),
            daemonInvoke<SessionSummary[]>("list_sessions"),
          ]);
          if (activeIdRef.current !== sessionId) return;
          const current = refreshedSessions.find(
            (session) => session.sessionId === sessionId,
          );
          setRuntimeStatus(status);
          setSessions(refreshedSessions);
          if (current) setActiveSession(current);
          setSessionReady(Boolean(status.connected && current?.isActive));
        } catch {
          if (activeIdRef.current === sessionId) setSessionReady(false);
        }
        if (activeIdRef.current === sessionId) handleError(cause, setError, setNeedsLogin);
      }
    } finally {
      catchUpOperation.finish(sessionId, token);
    }
  }

  async function removeQueueItem(itemId: string) {
    const sessionId = activeIdRef.current;
    if (!sessionId || queueBusy) return;
    const token = queueOperation.start(sessionId, itemId);
    if (!token) return;
    try {
      await daemonInvoke("remove_queue_item", { sessionId, itemId });
      await loadQueue(sessionId);
    } catch (cause) {
      if (activeIdRef.current === sessionId) setQueueError(String(cause));
    } finally {
      queueOperation.finish(sessionId, token);
    }
  }

  const decidePermission = useCallback(async (requestId: string, approved: boolean) => {
    try {
      await daemonInvoke("decide_permission", { requestId, approved });
      setPermissions((current) =>
        current.filter((item) => item.requestId !== requestId),
      );
    } catch (cause) {
      handleError(cause, setError, setNeedsLogin);
    }
  }, []);

  const respondInteraction = useCallback(async (interaction: PendingInteraction, response: unknown) => {
    let result: { success: boolean };
    try {
      result = await daemonInvoke<{ success: boolean }>("respond_interaction", {
        sessionId: interaction.sessionId,
        requestId: interaction.requestId,
        kind: interaction.kind,
        response,
      });
    } catch (cause) {
      if (cause instanceof DaemonError && cause.status === 409) await loadInteractions(interaction.sessionId);
      throw cause;
    }
    if (!result.success) {
      await loadInteractions(interaction.sessionId);
      throw new Error("This request is no longer pending. It may have been answered in another window.");
    }
    if (activeIdRef.current === interaction.sessionId) {
      setInteractions((current) => current.filter((item) => item.requestId !== interaction.requestId));
      activityRef.current = { ...activityRef.current, phase: "working" };
      setActivity(activityRef.current);
    }
    void loadInteractions(interaction.sessionId);
    const snapshot = await daemonInvoke<SessionState>("session_state", { sessionId: interaction.sessionId });
    if (activeIdRef.current === interaction.sessionId) {
      setAgentMode(snapshot.mode);
      setContextRevision((current) => current + 1);
    }
  }, [loadInteractions]);

  async function addAttachments(files: File[]) {
    const sessionId = activeIdRef.current;
    if (!sessionId) {
      setError("Attach a session before adding files.");
      return;
    }
    const token = attachmentOperation.start(sessionId);
    if (!token) {
      setError("Wait for the current attachments to finish loading.");
      return;
    }
    try {
      validateAttachments(attachmentDrafts, files);
      const loaded: AttachmentDraft[] = [];
      for (const file of files) loaded.push(await readAttachment(file));
      dispatchDraft({ type: "edit", sessionId, update: (draft) => ({
        ...draft, attachments: [...draft.attachments, ...loaded],
      }) });
    } catch (cause) {
      handleError(cause, setError, setNeedsLogin);
    } finally {
      attachmentOperation.finish(sessionId, token);
    }
  }

  async function runQueueAction(action: "sendNow" | "move" | "update", itemId: string, details: Record<string, unknown> = {}) {
    const sessionId = activeIdRef.current;
    if (!sessionId || queueBusy) return;
    const token = queueOperation.start(sessionId, itemId);
    if (!token) return;
    setQueueError("");
    try {
      const result = await daemonInvoke<{ steered?: boolean }>("queue_action", { sessionId, action, itemId, ...details });
      if (action === "sendNow" && result.steered === false) {
        throw new Error("No turn is running; this message remains queued.");
      }
      if (activeIdRef.current === sessionId) setEditingQueueId(null);
      await loadQueue(sessionId);
    } catch (cause) {
      if (activeIdRef.current === sessionId) setQueueError(String(cause));
    } finally {
      queueOperation.finish(sessionId, token);
    }
  }

  async function stopTurn() {
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    const before = activityRef.current;
    activityRef.current = { ...before, phase: "stopping" };
    setActivity(activityRef.current);
    try {
      await daemonInvoke("abort_session", { sessionId });
    } catch (cause) {
      if (activeIdRef.current === sessionId) {
        activityRef.current = before;
        setActivity(before);
        handleError(cause, setError, setNeedsLogin);
      }
    }
  }

  async function changeMode(mode: AgentMode) {
    const sessionId = activeIdRef.current;
    if (!sessionId || !sessionReady || modeBusy) return;
    const token = modeOperation.start(sessionId);
    if (!token) return;
    setError("");
    try {
      const result = await daemonInvoke<{
        status?: string;
        confirmation?: Record<string, unknown>;
        message?: string;
        warning?: string;
        pendingPostActions?: string[];
      }>("set_session_mode", { sessionId, mode });
      if (activeIdRef.current !== sessionId) return;
      if (result.confirmation) {
        setModeConfirmation({
          mode,
          detail: result.message ?? "Changing mode requires compacting this session's context.",
        });
        return;
      }
      const snapshot = await daemonInvoke<SessionState>("session_state", { sessionId });
      if (activeIdRef.current !== sessionId) return;
      setAgentMode(snapshot.mode);
      setModeConfirmation(null);
      setContextRevision((current) => current + 1);
      setModeNotice(result.warning ?? (result.pendingPostActions?.length ? result.message ?? "Mode changed. Send your next instruction to continue." : ""));
    } catch (cause) {
      if (activeIdRef.current === sessionId) handleError(cause, setError, setNeedsLogin);
    } finally {
      modeOperation.finish(sessionId, token);
    }
  }

  async function deleteSession(session: SessionSummary) {
    if (!window.confirm(`Delete "${session.title}"? This cannot be undone.`)) return;
    try {
      await daemonInvoke("delete_session", { sessionId: session.sessionId });
      dispatchDraft({ type: "delete", sessionId: session.sessionId });
      setSelectedAgent((current) => current?.sessionId === session.sessionId ? null : current);
      setExpandedSessions((current) => {
        const next = new Set(current);
        next.delete(session.sessionId);
        return next;
      });
      for (const key of Object.keys(agentDrafts)) {
        if ((JSON.parse(key) as [string, string])[0] === session.sessionId) {
          dispatchAgentDraft({ type: "delete", sessionId: key });
        }
      }
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
    const checkpoint = archiveChanges.checkpoint();
    const updated = archiveChanges.reconcile(await daemonInvoke<SessionSummary>("organize_session", {
      sessionId: session.sessionId,
      ...organization,
    }), checkpoint);
    setSessions((current) =>
      sortSessions(
        current.map((item) => (item.sessionId === updated.sessionId ? updated : item)),
      ),
    );
    setActiveSession((current) => current?.sessionId === updated.sessionId ? updated : current);
  }

  const setSessionArchived = useCallback(async (sessionId: string, archived: boolean, title: string) => {
    const token = archiveOperation.start(sessionId);
    if (!token) return;
    const checkpoint = archiveChanges.checkpoint();
    const trigger = document.activeElement;
    const fromSidebar = trigger instanceof HTMLElement && !!trigger.closest(".sidebar");
    setArchiveError("");
    setArchiveErrorLocation(fromSidebar ? "sidebar" : "workspace");
    setArchiveNotice(null);
    try {
      const result = await daemonInvoke<SessionSummary>("set_session_archived", { sessionId, archived });
      if (result.sessionId !== sessionId || result.archived !== archived) throw new Error("The daemon returned an unexpected archive result. Refresh the session list.");
      if (!archiveChanges.changedSince(sessionId, checkpoint)) applyArchiveChange(sessionId, archived);
      const effective = archiveChanges.reconcile(result, checkpoint);
      if (effective.archived === archived) setArchiveNotice({ sessionId, title, archived });
      requestAnimationFrame(() => {
        if (trigger && !trigger.isConnected) (fromSidebar ? sessionViewControl.current : composerRef.current)?.focus();
      });
    } catch (cause) {
      handleError(cause, setArchiveError, setNeedsLogin);
      requestAnimationFrame(() => {
        if (document.activeElement === document.body && trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
      });
    } finally {
      archiveOperation.finish(sessionId, token);
    }
  }, [archiveChanges, archiveOperation.start, archiveOperation.finish, applyArchiveChange]);

  function openNewSession() {
    setNewCwd(trackedCwd || activeSession?.cwd || "");
    setNewModel(DEFAULT_MODEL);
    setNewReasoningEffort("");
    setNewReasoningSummary("detailed");
    setNewContextTier("");
    setNewSessionOpen(true);
    if (newSessionModels.length === 0 && !newSessionModelsLoading) {
      setNewSessionModelsLoading(true);
      void daemonInvoke<{ models?: unknown[] }>("available_models")
        .then((result) => setNewSessionModels(normalizeModelOptions(result.models)))
        .catch((cause) => handleError(cause, setError, setNeedsLogin))
        .finally(() => setNewSessionModelsLoading(false));
    }
  }

  const loadReferences = useCallback(async () => {
    if (!activeIdRef.current) return;
    referenceGenerationRef.current += 1;
    setReferences(emptySessionReferences());
    setContextRevision((current) => current + 1);
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
      if (!sessionId) return;
      const generation = referenceGenerationRef.current;
      const key = `${sessionId}:${generation}:${section}`;
      const inFlight = referenceRequestsRef.current.get(key);
      if (inFlight) return inFlight;
      setReferenceSectionLoading(section);
      const request = (async () => {
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
        if (activeIdRef.current !== sessionId || referenceGenerationRef.current !== generation) return;
        setReferences((current) =>
          current
            ? {
                ...current,
                [section]: { value },
              }
            : current,
        );
      } catch (cause) {
        if (activeIdRef.current !== sessionId || referenceGenerationRef.current !== generation) return;
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
        referenceRequestsRef.current.delete(key);
        if (activeIdRef.current === sessionId) {
          setReferenceSectionLoading((current) => current === section ? "" : current);
        }
      }
      })();
      referenceRequestsRef.current.set(key, request);
      return request;
    },
    [],
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
    () => slashCommandSuggestions(references?.commands.value, composer),
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
  const sessionActivity = useMemo(
    () =>
      catchingUp
        ? { state: "syncing", label: "Catching up" }
        : runtimeStatus?.connected === false
          ? { state: "offline", label: "Runtime disconnected" }
          : !sessionReady
            ? { state: "detached", label: "Session detached" }
            : (sessionProcessing ?? isSessionProcessing(events))
              ? { state: "working", label: "Copilot working" }
              : { state: "idle", label: "Attached · idle" },
    [catchingUp, events, runtimeStatus?.connected, sessionProcessing, sessionReady],
  );

  async function loadEarlierHistory() {
    if (!activeSession || !hasMoreHistory || loadingMore) return;
    const sessionId = activeSession.sessionId;
    const token = historyOperation.start(sessionId);
    if (!token) return;
    try {
      const page = await daemonInvoke<HistoryPage>("session_history", {
        sessionId,
        cursor: historyCursorRef.current,
      });
      if (activeIdRef.current !== sessionId) return;
      historyCursorRef.current = page.cursor;
      setHasMoreHistory(page.hasMore);
      setHistoryWindowStartId(undefined);
      setEvents((current) => {
        const combined = mergeHistoryEvents(page.events, current);
        cacheHistory(historyCacheRef.current, sessionId, {
          ...page,
          events: combined,
        });
        return combined;
      });
    } catch (cause) {
      if (activeIdRef.current === sessionId) handleError(cause, setError, setNeedsLogin);
    } finally {
      historyOperation.finish(sessionId, token);
    }
  }

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    terminalDrag.current = { x: event.clientX, y: event.clientY,
      size: terminalLayout.layout.dock !== "right" ? terminalLayout.height : terminalWidth };
  }

  function resizeTerminal(delta: number, start?: number) {
    const dock = terminalLayout.layout.dock;
    const size = resizedTerminal(dock, start ?? (dock !== "right" ? terminalLayout.height : terminalWidth),
      delta, window.innerWidth, window.innerHeight);
    terminalLayout.setLayout((current) => ({ ...current, [dock !== "right" ? "height" : "width"]: size }));
  }

  function sessionRenamed(updated: SessionSummary) {
    setSessions((current) => current.map((session) => session.sessionId === updated.sessionId ? { ...updated, archived: session.archived } : session));
    setActiveSession((current) => current?.sessionId === updated.sessionId ? { ...updated, archived: current.archived } : current);
    setRenamingSession(null);
  }

  function sessionForked(fork: SessionSummary) {
    setForkingSession(null);
    setSessions((current) => [fork, ...current.filter((session) => session.sessionId !== fork.sessionId)]);
    void openSession(fork);
  }

  function discussReview(sessionId: string, context: ReviewChatContext) {
    if (activeIdRef.current !== sessionId) throw new Error("The selected session changed. Reopen the review from its original session.");
    if (readingAttachments) throw new Error("Wait for the current attachments to finish loading before adding review context.");
    const attachment = reviewAttachment(context);
    withReviewAttachment(draftsRef.current[sessionId]?.current.attachments ?? [], attachment);
    dispatchDraft({ type: "edit", sessionId, update: (draft) => ({
      ...draft,
      text: draft.text.trim() ? draft.text : context.suggestedQuestion,
      attachments: [...draft.attachments.filter((item) => item.id !== attachment.id), attachment],
    }) });
    setSelectedAgent(null);
    setGitOpen(false);
    setAskPanel(null);
    setError("");
    requestAnimationFrame(() => composerRef.current?.focus());
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

  const selectAgent = useCallback((session: SessionSummary, task: AgentTask) => {
    void openSession(session);
    setSelectedAgent({ sessionId: session.sessionId, task });
    setExpandedSessions((current) => new Set(current).add(session.sessionId));
    setSidebarOpen(false);
    setReferenceOpen(false);
    setModelPickerOpen(false);
  }, [openSession]);

  async function sendAgentMessage() {
    if (!selectedAgent || !activeSession || selectedAgent.sessionId !== activeSession.sessionId) return false;
    const { sessionId, task } = selectedAgent;
    const currentTask = agentTasks.states[sessionId]?.data?.tasks.find((entry) => entry.id === task.id);
    if (!currentTask?.canMessage || agentTasks.states[sessionId]?.error || runtimeStatus?.acceptingWork === false) return false;
    const key = agentKey(sessionId, task.id);
    const draft = agentDrafts[key]?.current;
    if (!draft?.text.trim()) return false;
    const token = agentSend.start(key);
    if (!token) return false;
    dispatchAgentDraft({ type: "submitted", sessionId: key });
    try {
      const result = await daemonInvoke<{ sent: boolean; error?: string }>("send_agent_message", {
        sessionId, taskId: task.id, message: draft.text.trim(),
      });
      if (!result.sent) throw new Error(result.error ?? "The runtime did not deliver this message.");
      agentTasks.refresh(sessionId);
      return true;
    } catch (cause) {
      dispatchAgentDraft({ type: "failed", sessionId: key, id: crypto.randomUUID(), draft, error: String(cause) });
      agentTasks.refresh(sessionId);
      return false;
    } finally {
      agentSend.finish(key, token);
    }
  }

  const selectedAgentKey = selectedAgent ? agentKey(selectedAgent.sessionId, selectedAgent.task.id) : "";
  const selectedAgentDraft = agentDrafts[selectedAgentKey] ?? EMPTY_SESSION_DRAFTS;

  const sessionRows = useMemo(() => sessionGroups.map((group) => {
    const collapsed = collapsedGroups.has(group.key);
    const itemsId = `session-group-${encodeURIComponent(group.key)}`;
    return (
      <section className="session-group" key={group.key} data-group-key={group.key}
        aria-label={group.pinned ? "Pinned sessions" : group.key === "loose" ? "Unfiled sessions" : `Folder ${group.name}`}>
          <button className="session-group-heading" onClick={() => toggleGroup(group.key)} aria-expanded={!collapsed} aria-controls={itemsId}>
            {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            {group.pinned && <Pin size={11} />}
            <span>{group.name}</span><i>{group.sessions.length}</i>
          </button>
        <div id={itemsId} className="session-group-items" hidden={collapsed}>
        {!collapsed && group.sessions.map((session) => (
          <div className="session-node" key={session.sessionId}>
            <div className="session-node-row">
            <button type="button" className="session-expander" aria-label={`Subagents for ${session.title}`}
              aria-expanded={expandedSessions.has(session.sessionId)} aria-controls={`subagents-${session.sessionId}`}
              onClick={() => setExpandedSessions((current) => {
                const next = new Set(current);
                if (!next.delete(session.sessionId)) next.add(session.sessionId);
                return next;
              })}>
              {expandedSessions.has(session.sessionId) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          <SessionRow session={session} active={activeSession?.sessionId === session.sessionId}
            activity={sidebarActivity.states[session.sessionId]} activityConnected={activityConnected}
            onOpen={() => { setSelectedAgent(null); void openSession(session); }}
            onTogglePin={() => void organizeSession(session, {
              pinned: !session.pinned, folder: session.folder, tags: session.tags,
            }).catch((cause) => {
              setArchiveErrorLocation("sidebar");
              handleError(cause, setArchiveError, setNeedsLogin);
            })}
            onToggleArchive={() => void setSessionArchived(session.sessionId, !session.archived, session.title)}
            archiveBusy={!!archiveOperation.operations.get(session.sessionId)}
            onOrganize={() => setOrganizingSession(session)}
            onRename={() => setRenamingSession(session)}
            onDelete={() => void deleteSession(session)} />
            </div>
            {expandedSessions.has(session.sessionId) && <SessionSubagents sessionId={session.sessionId}
              state={agentTasks.states[session.sessionId]}
              canRefresh={session.isActive && runtimeStatus?.connected !== false}
              selectedId={selectedAgent?.sessionId === session.sessionId ? selectedAgent.task.id : undefined}
              onSelect={(task) => selectAgent(session, task)} onRefresh={() => agentTasks.refresh(session.sessionId)} />}
          </div>
        ))}
        </div>
      </section>
    );
  }), [sessionGroups, collapsedGroups, activeSession?.sessionId, expandedSessions, agentTasks.states, selectedAgent, selectAgent, runtimeStatus?.connected, setSessionArchived, archiveOperation.revision, sidebarActivity.states, activityConnected]);

  if (needsLogin) {
    return <LoginScreen onLoggedIn={loadSessions} />;
  }

  return (
    <main
      className={`app-shell ${terminalOpen ? "terminal-visible" : ""} terminal-${terminalLayout.layout.dock}`}
      data-chat-width={chatWidth.width}
      style={{ "--terminal-width": `${terminalWidth}px`, "--terminal-height": `${terminalLayout.height}px` } as CSSProperties}
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
        <div className="session-list-controls">
          <span className="sidebar-label">Sessions</span>
          <select ref={sessionViewControl} aria-label="Session view" value={sessionView}
            onChange={(event) => setSessionView(event.target.value as SessionView)}>
            <option value="current">Current ({sessions.length - archivedCount})</option>
            <option value="archived">Archived ({archivedCount})</option>
            <option value="all">All ({sessions.length})</option>
          </select>
        </div>
        {archiveError && archiveErrorLocation === "sidebar" && <p className="session-archive-error" role="alert">{archiveError}</p>}
        {archiveNotice && <div className="session-archive-notice" role="status">
          <span>{archiveNotice.archived ? "Archived" : "Restored"} "{archiveNotice.title}".</span>
          <button type="button" disabled={!!archiveOperation.operations.get(archiveNotice.sessionId)}
            onClick={() => void setSessionArchived(archiveNotice.sessionId, !archiveNotice.archived, archiveNotice.title)}>Undo</button>
          <button type="button" aria-label="Dismiss archive notice" onClick={() => setArchiveNotice(null)}><X size={12} /></button>
        </div>}
        <nav
          ref={sessionListRef}
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
            <div className="sidebar-placeholder">
              {search.trim() ? "No matching sessions in this view." : sessionView === "archived" ? "No archived sessions." : sessionView === "all" ? "No sessions." : "No current sessions."}
              {sessionView === "current" && archivedCount > 0 && <button type="button" className="session-view-link"
                onClick={() => setSessionView("archived")}>View archived sessions</button>}
            </div>
          )}
          {sessionRows}
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
        {archiveError && archiveErrorLocation === "workspace" && <p className="session-archive-error" role="alert">{archiveError}</p>}
        {activeArchived && activeSession && <div className="session-archived-banner" role="status">
          <Archive size={15} /><span>This session is archived. Its conversation and running work are unchanged.</span>
          <button type="button" disabled={!!archiveOperation.operations.get(activeSession.sessionId)}
            onClick={() => void setSessionArchived(activeSession.sessionId, false, activeSession.title)}>Restore session</button>
        </div>}
        <header className="workspace-header">
          <button
            className="icon-button mobile-menu"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open sessions"
          >
            <Menu size={19} />
          </button>
          <div className="session-heading">
            <div className="session-title-line">
              <h1>{activeSession?.title ?? "Copilot Sessions"}</h1>
              {activeSession && <button type="button" className="icon-button" aria-label="Rename session"
                title="Rename session" onClick={() => setRenamingSession(activeSession)}><Pencil size={15} /></button>}
            </div>
            <div className="session-context">
              {activeSession ? (
                <>
                  <button
                    className="model-trigger"
                    title="Change this session's model"
                    disabled={!!selectedAgent}
                    onClick={() => setModelPickerOpen(true)}
                  >
                    {activeSession.model || "Resolving model…"}
                  </button>
                  <i />
                  <button title={activeSession.cwd}>{activeSession.cwd || "No CWD"}</button>
                  <span className={`session-activity ${sessionActivity.state}`}>
                    <b />
                    {sessionActivity.label}
                  </span>
                </>
              ) : (
                <span>Select or create a session</span>
              )}
            </div>
          </div>
          <div className="header-actions">
            {activeSession?.cwd && <GitWorkspaceButton sessionId={activeSession.sessionId} cwd={activeSession.cwd} onOpen={() => setGitOpen(true)} />}
            <button type="button" className="icon-button" title="Ask about this conversation without tools or history changes"
              aria-label="Ask about conversation" disabled={!sessionReady || !!selectedAgent || runtimeStatus?.acceptingWork === false}
              onClick={() => activeSession && setAskPanel({ id: crypto.randomUUID(), sessionId: activeSession.sessionId, question: "", submitOnOpen: false })}>
              <MessageCircleQuestion size={16} /><span className="desktop-label">Ask</span>
            </button>
            <button type="button" className="icon-button" title="Fork conversation" aria-label="Fork conversation"
              disabled={!activeSession || !sessionReady || !!selectedAgent || sessionProcessing === true}
              onClick={() => { setForkingName(undefined); if (activeSession) setForkingSession(activeSession); }}>
              <GitBranch size={16} /><span className="desktop-label">Fork</span>
            </button>
            {!selectedAgent && activeSession && (busy || sessionProcessing) && (
              <button
                className="icon-button"
                title="Stop current turn"
                onClick={() => void stopTurn()}
              >
                <Square size={15} />
              </button>
            )}
            <button
              className="icon-button"
              title="Merge recent history without restarting Copilot or other sessions"
              disabled={
                !activeSession ||
                !!selectedAgent ||
                runtimeStatus?.connected === false ||
                busy ||
                sessionProcessing === true ||
                catchingUp
              }
              onClick={() => void catchUpSession()}
            >
              <RefreshCw className={catchingUp ? "spin" : undefined} size={17} />
              <span className="desktop-label">Catch up</span>
            </button>
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
              disabled={!sessionReady || !!selectedAgent}
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
            {terminalOpen && <div className="terminal-layout-toggle" role="group" aria-label="Terminal layout">
              <button type="button" className="icon-button" title="Terminal above chat" aria-label="Terminal above chat"
                aria-pressed={terminalLayout.layout.dock === "top"}
                onClick={() => terminalLayout.setLayout((current) => ({ ...current, dock: "top" }))}><PanelTop size={16} /></button>
              <button type="button" className="icon-button" title="Terminal beside chat" aria-label="Terminal beside chat"
                aria-pressed={terminalLayout.layout.dock === "right"}
                onClick={() => terminalLayout.setLayout((current) => ({ ...current, dock: "right" }))}><PanelRightOpen size={16} /></button>
              <button type="button" className="icon-button" title="Terminal below chat" aria-label="Terminal below chat"
                aria-pressed={terminalLayout.layout.dock === "bottom"}
                onClick={() => terminalLayout.setLayout((current) => ({ ...current, dock: "bottom" }))}><PanelBottom size={16} /></button>
            </div>}
          </div>
        </header>
        {terminalLayout.error && <p className="error-banner" role="alert">{terminalLayout.error}</p>}

        {activeSession && interactions.length > 0 && <section className="interaction-dock" aria-label="Pending session questions">
          <div className="interaction-dock-heading" role="status">
            <strong>Copilot needs your input</strong>
            <span>{interactions.length} pending · {activeSession.title}</span>
          </div>
          {interactions.map((interaction) => (
            <Suspense key={`${interaction.sessionId}:${interaction.requestId}`}
              fallback={<div className="interaction-panel" role="status">Loading input controls...</div>}>
              <InteractionPanel interaction={interaction} onRespond={respondInteraction} />
            </Suspense>
          ))}
        </section>}
        {selectedAgent && activeSession && <Suspense fallback={<p role="status">Opening subagent conversation...</p>}>
          <AgentConversation key={selectedAgentKey} parent={activeSession} task={selectedAgent.task}
            currentTask={agentTasks.states[selectedAgent.sessionId]?.data?.tasks.find((task) => task.id === selectedAgent.task.id)}
            taskError={agentTasks.states[selectedAgent.sessionId]?.error}
            pendingInputs={permissions.length}
            parentEvents={events} text={selectedAgentDraft.current.text}
            busy={!!agentSend.operations.get(selectedAgentKey)} error={selectedAgentDraft.error}
            connected={connected && sessionReady && runtimeStatus?.connected !== false && runtimeStatus?.acceptingWork !== false}
            onChange={(text) => dispatchAgentDraft({ type: "edit", sessionId: selectedAgentKey, update: (draft) => ({ ...draft, text }) })}
            onSend={sendAgentMessage} onBack={() => {
              setSelectedAgent(null);
              requestAnimationFrame(() => composerRef.current?.focus());
            }}
            reasoningExpanded={reasoningExpanded} toolDetailsExpanded={toolDetailsExpanded} />
          {selectedAgentDraft.saved.map((saved) => <div className="saved-chat-draft" key={saved.id}>
            <strong>Unsent subagent message</strong><p>{saved.draft.text}</p>
            {saved.error && <p role="alert">{saved.error}</p>}
            <button type="button" onClick={() => dispatchAgentDraft({ type: "restore", sessionId: selectedAgentKey, id: saved.id })}>Restore draft</button>
            <button type="button" onClick={() => dispatchAgentDraft({ type: "discard", sessionId: selectedAgentKey, id: saved.id })}>Discard</button>
          </div>)}
        </Suspense>}
        <div className="parent-session-view" hidden={!!selectedAgent && !!activeSession}>
        {error && (
          <div className="error-banner">
            <span>{error}</span>
            <button onClick={() => setError("")}>
              <X size={15} />
            </button>
          </div>
        )}

        {activeSession && (catchingUp || historyReceipt?.sessionId === activeSession.sessionId) && (
          <div className={`sync-banner ${catchingUp ? "working" : "complete"}`}>
            <RefreshCw className={catchingUp ? "spin" : undefined} size={14} />
            <span>
              {catchingUp ? (
                <>
                  <strong>Catching up</strong>
                  Checking daemon activity, refreshing Copilot, and loading recent human turns…
                </>
              ) : (
                <>
                  <strong>
                    Loaded {formatEventTime(historyReceipt?.loadedAt)} · history through{" "}
                    {formatEventTime(historyReceipt?.newestEventAt)}
                  </strong>
                  {historyReceipt?.humanMessages ?? 0} human messages ·{" "}
                  {historyReceipt?.eventCount.toLocaleString()} events scanned
                  {historyReceipt?.loadedPages && historyReceipt.loadedPages > 1
                    ? ` · ${historyReceipt.loadedPages} pages`
                    : ""}
                  {historyReceipt?.runtimeRecycled ? " · Copilot runtime refreshed" : ""}
                  {historyReceipt?.truncatedBeforeAnchor
                    ? " · latest turn continues above this window"
                    : historyReceipt && hasMoreHistory
                      ? " · earlier turns available"
                      : ""}
                </>
              )}
            </span>
            {!catchingUp && (
              <button type="button" onClick={scrollToLatestHumanTurn}>
                Latest turn
              </button>
            )}
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
          tabIndex={0}
          aria-label="Conversation"
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
            sessionId={activeSession?.sessionId}
            hasSession={activeSession !== null}
            loading={historyState === "loading"}
            events={events}
            windowStartEventId={historyWindowStartId}
            subagentContext={subagentContext}
            permissions={permissions}
            showRawEvents={false}
            reasoningExpanded={reasoningExpanded}
            toolDetailsExpanded={toolDetailsExpanded}
            assistantModel={activeSession?.model}
            onPermission={decidePermission}
          />
          {showRawEvents && (
            <details className="raw-diagnostics" open>
              <summary>Diagnostic events ({rawDiagnostics.length} most recent)</summary>
              {rawDiagnostics.map((event) => (
                <details key={event.id}>
                  <summary>{event.type}</summary>
                  <pre>{JSON.stringify(event, null, 2)}</pre>
                </details>
              ))}
            </details>
          )}
        </div>

        {activeSession && (
          <div className="message-queue" key={activeSession.sessionId} aria-label="Message queue" role="region">
            {(queue.items.length > 0 || queue.steeringMessages.length > 0) && (
              <details className="message-queue-disclosure" open>
                <summary className="message-queue-heading">
                  <ChevronRight className="queue-toggle" size={12} />
                  <strong aria-live="polite">
                    {queue.items.length > 0 && `${queue.items.length} queued`}
                    {queue.items.length > 0 && queue.steeringMessages.length > 0 && " · "}
                    {queue.steeringMessages.length > 0 && `${queue.steeringMessages.length} guidance sent`}
                  </strong>
                  <span className="queue-next-preview" title={queue.items[0]?.displayText ?? queue.steeringMessages[0]}>
                    {queue.items[0]?.displayText ?? queue.steeringMessages[0]}
                  </span>
                  <span className="queue-order-hint">{queue.items.length ? "Runs in submission order" : "Sent to the running turn"}</span>
                </summary>
                <div className="message-queue-items">
                {queue.items.map((item, index) => (
                  <div className="message-queue-item" key={item.id} data-queue-id={item.id}>
                    <span>{index + 1}</span>
                    <div className="queue-item-content">
                      {editingQueueId === item.id ? (
                        <input className="queue-edit" aria-label="Edit queued message"
                          value={editingQueueText} onChange={(event) => setEditingQueueText(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void runQueueAction("update", item.id, { prompt: editingQueueText });
                            } else if (event.key === "Escape") {
                              event.preventDefault(); setEditingQueueId(null);
                            }
                          }} />
                      ) : <strong title={item.displayText}>{item.displayText}</strong>}
                      <small>{modeLabel(item.agentMode)} · {item.kind}</small>
                    </div>
                    <div className="queue-actions">
                      {editingQueueId === item.id ? (
                        <>
                          <button type="button" disabled={!!queueBusy || !editingQueueText.trim()}
                            onClick={() => void runQueueAction("update", item.id, { prompt: editingQueueText })}>Save</button>
                          <button type="button" disabled={!!queueBusy} title="Cancel editing queued message"
                            onClick={() => setEditingQueueId(null)}>Cancel</button>
                        </>
                      ) : (
                        <>
                          <button type="button" title="Move queued message earlier"
                            disabled={!!queueBusy || index === 0 || item.id.startsWith("local-queue-")}
                            onClick={() => void runQueueAction("move", item.id, { toPosition: index - 1 })}>↑</button>
                          <button type="button" title="Edit queued message"
                            disabled={!!queueBusy || item.kind !== "message" || item.id.startsWith("local-queue-")}
                            onClick={() => { setEditingQueueId(item.id); setEditingQueueText(item.displayText); }}>
                            <Pencil size={13} /><span className="queue-action-label">Edit</span>
                          </button>
                          <button type="button" title="Send as guidance to the running turn"
                            disabled={!sessionProcessing || !!queueBusy || item.kind !== "message" || item.id.startsWith("local-queue-")}
                            onClick={() => void runQueueAction("sendNow", item.id)}>
                            <Send size={13} /><span className="queue-action-label">Send now</span>
                          </button>
                        </>
                      )}
                    <button
                      type="button"
                      className="queue-remove"
                      title="Remove queued prompt"
                      disabled={!!queueBusy || item.id.startsWith("local-queue-")}
                      onClick={() => void removeQueueItem(item.id)}
                    >
                      <X size={13} />
                    </button>
                    </div>
                  </div>
                ))}
                {queue.steeringMessages.map((message, index) => (
                  <div className="message-queue-item" key={`steer-${index}`}>
                    <span>↳</span><div className="queue-item-content"><strong title={message}>{message}</strong><small>Guidance sent to the running turn</small></div>
                  </div>
                ))}
                </div>
              </details>
            )}
            {queueError && <p role="alert">{queueError}</p>}
          </div>
        )}

        {activeSession && (
          <div
            className={`composer-status ${
              busy || sessionProcessing ? "working" : "idle"
            }`}
            aria-live="polite"
          >
            <span>
              {busy || sessionProcessing ? (
                <RefreshCw className="spin" size={13} />
              ) : (
                <i />
              )}
              <strong>
                {!connected ? "Reconnecting to daemon" :
                  !sessionReady ? "Attaching session" :
                  interactions.length || permissions.length ? "Copilot needs your input" :
                  activity.phase === "submitting" ? "Sending message" :
                  activity.phase === "stopping" ? "Stopping turn" :
                  activity.phase === "error" ? "Session error" :
                  sessionProcessing ? "Copilot is working" : "Session attached · idle"}
              </strong>
              <small>
                {streamStalled
                  ? "Waiting for a runtime update"
                  : streamStatus?.message ??
                  `Last event ${formatEventTime(events[events.length - 1]?.timestamp)}`}
              </small>
            </span>
            {(busy || sessionProcessing) && (
              <button
                type="button"
                onClick={() => void stopTurn()}
              >
                <Square size={11} />
                Stop
              </button>
            )}
            {activityTimings(activity) && (
              <small className="timing-detail">{activityTimings(activity)}</small>
            )}
          </div>
        )}

        <form className="composer" onSubmit={sendMessage}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files")) event.preventDefault();
          }}
          onDrop={(event) => {
            if (!event.dataTransfer.files.length) return;
            event.preventDefault();
            if (!sessionReady) { setError("Attach a session before adding files."); return; }
            void addAttachments(Array.from(event.dataTransfer.files));
          }}>
          {modeNotice && <p className="mode-notice" role="status">{modeNotice}</p>}
          {sessionDrafts.error && <p role="alert">{sessionDrafts.error}</p>}
          {sessionDrafts.saved.map((saved) => (
            <div className="saved-chat-draft" key={saved.id}>
              <strong>Unsent message</strong>
              <p>{saved.draft.text}</p>
              {saved.draft.attachments.length > 0 && <small>{saved.draft.attachments.map((file) => file.reviewContext?.label ?? file.displayName).join(", ")}</small>}
              {saved.error && <p role="alert">{saved.error}</p>}
              <button type="button" onClick={() => dispatchDraft({ type: "restore", sessionId: draftSessionId, id: saved.id })}>Restore draft</button>
              <button type="button" onClick={() => dispatchDraft({ type: "discard", sessionId: draftSessionId, id: saved.id })}>Discard</button>
            </div>
          ))}
          <input ref={attachmentInputRef} type="file" multiple hidden
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              if (files.length) void addAttachments(files);
            }} />
          {attachmentDrafts.length > 0 && (
            <div className="composer-attachments">
              {attachmentDrafts.map((file) => (
                file.reviewContext ? <ReviewContextChip key={file.id} context={file.reviewContext}
                  onRemove={() => setAttachmentDrafts((current) => current.filter((item) => item.id !== file.id))} /> :
                <div className="attachment-chip" key={file.id}>
                  <Paperclip size={13} /><span>{file.displayName}</span>
                  <button type="button" aria-label={`Remove ${file.displayName}`}
                    onClick={() => setAttachmentDrafts((current) => current.filter((item) => item.id !== file.id))}>
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {composer.trimStart().startsWith("/") && (
            <div className="command-palette">
              <header>
                <strong>Session commands</strong>
                <span>Experimental SDK surface</span>
              </header>
              {referenceSectionLoading === "commands" && (
                <div className="command-placeholder">Discovering commands…</div>
              )}
              {commandSuggestions.map((command) => (
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
                  No matching command loaded. The runtime will validate the command when submitted.
                </div>
                )}
            </div>
          )}
          <textarea
            ref={composerRef}
            value={composer}
            onChange={(event) => setComposer(event.currentTarget.value)}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (files.length) { event.preventDefault(); void addAttachments(files); }
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey) {
                event.preventDefault();
                void changeMode(cycleAgentMode(agentMode, 1));
              } else if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (event.ctrlKey || event.metaKey) submitDeliveryRef.current = "immediate";
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={
              catchingUp
                ? "Catching up with persisted history…"
                : activeSession && sessionReady
                  ? "Ask Copilot anything…"
                : activeSession
                  ? "Connecting to session…"
                  : "Select a session to start chatting"
            }
            disabled={!activeSession || !sessionReady || catchingUp}
            rows={1}
          />
          <div className="composer-footer">
            <div className="agent-mode-switcher" aria-label="Agent mode">
              {(["interactive", "plan", "autopilot"] as AgentMode[]).map((mode) => (
                <button
                  type="button"
                  className={agentMode === mode ? "active" : ""}
                  key={mode}
                  disabled={modeBusy || !sessionReady}
                  aria-pressed={agentMode === mode}
                  onClick={() => void changeMode(mode)}
                >
                  {modeLabel(mode)}
                </button>
              ))}
            </div>
            <button className="composer-attach" type="button" aria-label="Attach files or images"
              title="Attach files or images" disabled={readingAttachments || !sessionReady}
              onClick={() => attachmentInputRef.current?.click()}><Paperclip size={17} /></button>
            <select aria-label="Message delivery" value={deliveryMode}
              onChange={(event) => setDeliveryMode(event.target.value === "immediate" ? "immediate" : "enqueue")}>
              <option value="enqueue">Queue while busy</option>
              <option value="immediate">Steer running turn</option>
            </select>
            <span>
              {readingAttachments ? "Reading files..." :
                sessionProcessing && deliveryMode === "enqueue" ? "Enter to queue" : "Enter to send"}
              {" · Shift+Enter newline"}
            </span>
            <button
              className="send-button"
              type="submit"
              disabled={
                !activeSession ||
                !sessionReady ||
                (!composer.trim() && attachmentDrafts.length === 0) ||
                busy ||
                modeBusy ||
                readingAttachments ||
                catchingUp
              }
            >
              <Send size={16} />
            </button>
          </div>
        </form>
        </div>
      </section>

      {terminalOpen && activeSession && (
        <>
          <div className="pane-resizer" role="separator" tabIndex={0} aria-label="Resize terminal"
            aria-orientation={terminalLayout.layout.dock !== "right" ? "horizontal" : "vertical"}
            aria-valuemin={terminalSizeLimits(terminalLayout.layout.dock, window.innerWidth, window.innerHeight).min}
            aria-valuemax={terminalSizeLimits(terminalLayout.layout.dock, window.innerWidth, window.innerHeight).max}
            aria-valuenow={terminalLayout.layout.dock !== "right" ? terminalLayout.height : terminalWidth}
            onPointerDown={startResize} onPointerMove={(event) => {
              const drag = terminalDrag.current;
              if (drag) resizeTerminal(terminalLayout.layout.dock !== "right" ? event.clientY - drag.y : event.clientX - drag.x, drag.size);
            }}
            onPointerUp={() => { terminalDrag.current = null; }}
            onPointerCancel={() => { terminalDrag.current = null; }}
            onLostPointerCapture={() => { terminalDrag.current = null; }}
            onKeyDown={(event) => {
              const horizontal = terminalLayout.layout.dock !== "right";
              const sign = event.key === (horizontal ? "ArrowDown" : "ArrowRight") ? 1
                : event.key === (horizontal ? "ArrowUp" : "ArrowLeft") ? -1 : 0;
              if (sign) { event.preventDefault(); resizeTerminal(sign * (event.shiftKey ? 50 : 10)); }
            }} />
          <Suspense fallback={<div className="terminal-loading">Opening terminal…</div>}>
            <TerminalPane
              key={activeSession.sessionId}
              sessionId={activeSession.sessionId}
              cwd={activeSession?.cwd || trackedCwd}
              followCwd={followCwd}
              onFollowCwdChange={setFollowCwd}
              onCwdChange={trackTerminalCwd}
              onClose={() => setTerminalOpen(false)}
              typography={typography.settings}
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
          <Suspense fallback={<aside className="reference-drawer" role="status">Loading context controls...</aside>}>
          <ReferenceDrawer
            sessionId={activeSession?.sessionId}
            revision={contextRevision}
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
          </Suspense>
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
          typography={typography}
          chatWidth={chatWidth.width}
          onChatWidthChange={chatWidth.setWidth}
          chatWidthError={chatWidth.error}
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
      {renamingSession && <RenameSession key={renamingSession.sessionId} session={renamingSession}
        onSaved={sessionRenamed} onClose={() => setRenamingSession(null)} />}
      {forkingSession && <ForkSession key={forkingSession.sessionId} session={forkingSession} initialName={forkingName}
        onForked={sessionForked} onClose={() => setForkingSession(null)} />}
      {gitOpen && activeSession?.cwd && <Suspense fallback={<p role="status" className="git-loading">Opening Git workspace...</p>}>
        <GitPanel sessionId={activeSession.sessionId} cwd={activeSession.cwd} onClose={() => setGitOpen(false)}
          onDiscuss={(context) => discussReview(activeSession.sessionId, context)}
          onAsk={(question, reviewContext) => {
            setGitOpen(false);
            setAskPanel({ id: crypto.randomUUID(), sessionId: activeSession.sessionId, question, reviewContext, submitOnOpen: false });
          }} />
      </Suspense>}
      {askPanel && <div className="ask-backdrop" role="presentation">
        <div className="ask-dialog" role="dialog" aria-modal="true" aria-label="Ask about conversation">
          <Suspense fallback={<p role="status">Opening /ask...</p>}>
            <AskPanel key={askPanel.id} sessionId={askPanel.sessionId} initialQuestion={askPanel.question}
              reviewContext={askPanel.reviewContext}
              onContinue={(context) => discussReview(askPanel.sessionId, context)}
              submitOnOpen={askPanel.submitOnOpen} onClose={() => {
                setAskPanel(null);
                requestAnimationFrame(() => composerRef.current?.focus());
              }} />
          </Suspense>
        </div>
      </div>}

      {newSessionOpen && (
        <div className="modal-backdrop" role="presentation">
          <form className="new-session-modal" onSubmit={createSession}
            aria-busy={creatingSession}
            role="dialog" aria-modal="true" aria-label="New session">
            <header>
              <div>
                <span>Workspace</span>
                <h2>Start a new session</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                disabled={creatingSession}
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
                disabled={creatingSession}
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
                onChange={(event) => {
                  const modelId = event.currentTarget.value;
                  const option = newSessionModels.find((model) => model.id === modelId);
                  setNewModel(modelId);
                  setNewReasoningEffort(option?.defaultReasoningEffort ?? "");
                  setNewReasoningSummary(
                    !option || option.reasoningEfforts.length > 0 ? "detailed" : "none",
                  );
                  setNewContextTier("");
                }}
                disabled={creatingSession || newSessionModelsLoading}
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
            <div className="new-session-configuration">
              <label>
                Reasoning effort
                <select
                  value={newReasoningEffort}
                  onChange={(event) => setNewReasoningEffort(event.currentTarget.value)}
                  disabled={
                    creatingSession ||
                    !selectedNewSessionModel ||
                    selectedNewSessionModel.reasoningEfforts.length === 0
                  }
                >
                  <option value="">Model default</option>
                  {selectedNewSessionModel?.reasoningEfforts.map((effort) => (
                    <option value={effort} key={effort}>
                      {labelModelValue(effort)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Visible reasoning
                <select
                  value={newReasoningSummary}
                  onChange={(event) =>
                    setNewReasoningSummary(
                      event.currentTarget.value as ReasoningSummary,
                    )
                  }
                  disabled={
                    creatingSession ||
                    selectedNewSessionModel.reasoningEfforts.length === 0
                  }
                >
                  <option value="detailed">Detailed</option>
                  <option value="concise">Concise</option>
                  <option value="none">Off</option>
                </select>
              </label>
              <label>
                Context window
                <select
                  value={newContextTier}
                  onChange={(event) => setNewContextTier(event.currentTarget.value)}
                  disabled={
                    creatingSession ||
                    !selectedNewSessionModel ||
                    selectedNewSessionModel.contextTiers.length === 0
                  }
                >
                  <option value="">Model default</option>
                  {selectedNewSessionModel?.contextTiers.map((tier) => (
                    <option value={tier} key={tier}>
                      {labelModelValue(tier)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <footer>
              <button
                type="button"
                className="button secondary"
                disabled={creatingSession}
                onClick={() => setNewSessionOpen(false)}
              >
                Cancel
              </button>
              <button
                className="button primary"
                type="submit"
                disabled={creatingSession || !newCwd.trim()}
              >
                <Plus size={16} />
                {creatingSession ? "Creating..." : "Create session"}
              </button>
            </footer>
          </form>
        </div>
      )}

      {shortcutsOpen && (
        <div className="modal-backdrop" role="presentation" onClick={() => setShortcutsOpen(false)}>
          <section
            className="shortcut-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Keyboard shortcuts"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span>Keyboard workflow</span>
                <h2>Shortcuts</h2>
              </div>
              <button type="button" onClick={() => setShortcutsOpen(false)} aria-label="Close">
                <X size={17} />
              </button>
            </header>
            <div className="shortcut-grid">
              <kbd>F6 / Shift F6</kbd><span>Move between prompt, conversation, sessions, and terminal</span>
              <kbd>Ctrl K</kbd><span>Focus prompt</span>
              <kbd>/</kbd><span>Open command palette</span>
              <kbd>Ctrl Q</kbd><span>Send or enqueue prompt</span>
              <kbd>Ctrl Enter</kbd><span>Steer the running turn</span>
              <kbd>Ctrl S</kbd><span>Stash or restore prompt</span>
              <kbd>Ctrl R</kbd><span>Cycle recent prompts</span>
              <kbd>Tab / Shift Tab</kbd><span>Cycle Interactive / Plan / Autopilot</span>
              <kbd>Alt 1 / 2 / 3</kbd><span>Jump to Interactive / Plan / Autopilot</span>
              <kbd>Ctrl T</kbd><span>Toggle reasoning</span>
              <kbd>Ctrl O</kbd><span>Toggle tool details</span>
              <kbd>Ctrl E</kbd><span>Expand reasoning and tool details</span>
              <kbd>Ctrl .</kbd><span>Stop current turn</span>
              <kbd>Ctrl Shift Backspace</kbd><span>Remove newest queued prompt</span>
              <kbd>Ctrl Shift B</kbd><span>Toggle sessions sidebar</span>
              <kbd>Ctrl Shift T</kbd><span>Toggle terminal</span>
              <kbd>Ctrl N</kbd><span>New session</span>
              <kbd>?</kbd><span>Show this help</span>
            </div>
          </section>
        </div>
      )}
      {modeConfirmation && (
        <div className="modal-backdrop" role="presentation">
          <section className="shortcut-modal" role="dialog" aria-modal="true" aria-label="Mode change requires confirmation">
            <header><h2>Mode change needs context compaction</h2></header>
            <p>{modeConfirmation.detail}</p>
            <p>This SDK's compaction-confirmation action is not supported by this client yet. The requested switch to {modeLabel(modeConfirmation.mode)} has not been accepted here. Complete the compaction in the CLI, then retry.</p>
            <button className="button primary" autoFocus type="button" onClick={() => {
              setModeConfirmation(null); composerRef.current?.focus();
            }}>Dismiss</button>
          </section>
        </div>
      )}
    </main>
  );
}

function SessionRow({
  session,
  active,
  activity,
  activityConnected,
  onOpen,
  onTogglePin,
  onToggleArchive,
  archiveBusy,
  onOrganize,
  onRename,
  onDelete,
}: {
  session: SessionSummary;
  active: boolean;
  activity?: SessionActivity;
  activityConnected: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
  onToggleArchive: () => void;
  archiveBusy: boolean;
  onOrganize: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const indicator = sessionActivityIndicator(session.isActive, activityConnected, activity);
  const statusId = `session-activity-${session.sessionId}`;
  return (
    <div className={active ? "session-item active" : "session-item"} data-session-id={session.sessionId}>
      <button className="session-open" onClick={onOpen} aria-describedby={statusId}>
        {session.pinned && <Pin className="session-pin" size={12} />}
        <span className="session-main">
          <strong>{session.title}</strong>
          {session.archived && <span className="session-archived-label"><Archive size={10} />Archived</span>}
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
        <span className="session-meta-time">
          <span id={statusId} className={`session-activity-dot ${indicator.kind}`}
            role="img" aria-label={indicator.label} title={indicator.description} />
          <span>{relativeTime(session.modifiedTime)}</span>
        </span>
        <span className="session-row-actions">
        <button type="button" className="session-action session-archive-action" disabled={archiveBusy}
          onClick={onToggleArchive} aria-label={`${session.archived ? "Restore" : "Archive"} ${session.title}`}
          title={session.archived ? "Restore to current sessions" : "Hide from current sessions without stopping or deleting"}>
          {session.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
        </button>
        {active && (
          <>
            <button className="session-action" onClick={onRename} aria-label={`Rename ${session.title}`}>
              <Pencil size={13} />
            </button>
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
    if (isTranscriptEvent(event.event)) queueEvent(event.event);
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

function createHistoryReceipt(
  sessionId: string,
  page: HistoryPage,
  runtimeRecycled: boolean,
): HistoryReceipt {
  return {
    sessionId,
    loadedAt: new Date().toISOString(),
    newestEventAt: page.events[page.events.length - 1]?.timestamp,
    eventCount: page.events.length,
    humanMessages: page.humanMessages,
    loadedPages: page.loadedPages,
    runtimeRecycled,
    truncatedBeforeAnchor: page.truncatedBeforeAnchor,
  };
}

function isSessionProcessing(events: SessionEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.agentId || event.type.startsWith("subagent.")) continue;
    if (event.type === "session.idle" || event.type === "session.error") return false;
    if (event.type === "assistant.turn_start" || event.type === "user.message") {
      return true;
    }
  }
  return false;
}

function hasUnansweredRootTurn(events: SessionEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.agentId) continue;
    if (event.type !== "user.message") continue;
    return !events
      .slice(index + 1)
      .some((candidate) => !candidate.agentId && eventHasAssistantText(candidate));
  }
  return false;
}

function eventHasAssistantText(event: SessionEvent): boolean {
  if (
    event.type === "assistant.message_delta" ||
    event.type === "assistant.streaming_delta"
  ) {
    return eventText(event.data.deltaContent ?? event.data.content ?? event.data.text) !== "";
  }
  if (event.type !== "assistant.message") return false;
  const direct = eventText(event.data.content ?? event.data.message);
  if (direct) return true;
  for (const candidate of [event.data.message, event.data.response]) {
    if (!candidate || typeof candidate !== "object") continue;
    const value = candidate as Record<string, unknown>;
    if (eventText(value.content ?? value.text)) return true;
  }
  return Array.isArray(event.data.content)
    ? event.data.content.some((part) => {
        if (typeof part === "string") return part.length > 0;
        if (!part || typeof part !== "object") return false;
        const value = part as Record<string, unknown>;
        return eventText(value.text ?? value.content) !== "";
      })
    : false;
}

function eventText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function formatEventTime(timestamp?: string): string {
  if (!timestamp) return "unknown time";
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return timestamp;
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(parsed);
}

function sortSessions(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    return right.modifiedTime.localeCompare(left.modifiedTime);
  });
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
    const value = event.data.newModel ?? event.data.modelId ?? event.data.model;
    return typeof value === "string" ? value : "";
  }
  return "";
}

function eventAgentMode(event: SessionEvent): AgentMode | undefined {
  const mode = event.data.newMode ?? event.data.mode ?? event.data.agentMode;
  return mode === "interactive" ||
    mode === "plan" ||
    mode === "autopilot" ||
    mode === "shell"
    ? mode
    : undefined;
}

function modeLabel(mode: string): string {
  if (mode === "plan") return "Plan";
  if (mode === "autopilot") return "Autopilot";
  if (mode === "shell") return "Shell";
  return "Interactive";
}

function cycleAgentMode(current: AgentMode, direction: 1 | -1): AgentMode {
  const modes: AgentMode[] = ["interactive", "plan", "autopilot"];
  const index = modes.indexOf(current);
  return modes[(index + direction + modes.length) % modes.length];
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
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
