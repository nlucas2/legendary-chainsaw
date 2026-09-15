export interface SessionSummary {
  sessionId: string;
  title: string;
  startTime: string;
  modifiedTime: string;
  cwd?: string;
  model?: string;
  isActive: boolean;
  isRemote: boolean;
  pinned: boolean;
  folder?: string;
  tags: string[];
}

export interface SessionEvent {
  id: string;
  timestamp: string;
  parentId?: string;
  agentId?: string;
  type: string;
  data: Record<string, unknown>;
}

export interface HistoryPage {
  events: SessionEvent[];
  hasMore: boolean;
  cursor: string;
  loadedPages: number;
  humanMessages: number;
  windowStartEventId?: string;
  truncatedBeforeAnchor: boolean;
}

export interface SessionRefresh {
  session: SessionSummary;
  history: HistoryPage;
  runtimeRecycled: boolean;
}

export interface ReferenceSection {
  value?: unknown;
  error?: string;
}

export interface SessionReferences {
  commands: ReferenceSection;
  skills: ReferenceSection;
  mcp: ReferenceSection;
  mcpTools: ReferenceSection;
  tools: ReferenceSection;
  instructions: ReferenceSection;
  contextAttribution: ReferenceSection;
  tasks: ReferenceSection;
}

export interface RuntimeStatus {
  connected: boolean;
  acceptingWork: boolean;
  activeSessions: number;
}

export type AgentMode = "interactive" | "plan" | "autopilot" | "shell";
export type ReasoningSummary = "none" | "concise" | "detailed";

export interface SessionState {
  processing: boolean;
  mode: AgentMode;
}

export interface PendingInteraction {
  sessionId: string;
  requestId: string;
  kind: "user_input" | "elicitation" | "exit_plan_mode" | "auto_mode_switch";
  data: Record<string, unknown>;
}

export interface ChatAttachment {
  type: "blob";
  data: string;
  mimeType: string;
  displayName: string;
}

export interface QueueItem {
  id: string;
  displayText: string;
  kind: "message" | "command" | string;
  agentMode: AgentMode | string;
}

export interface QueueItems {
  items: QueueItem[];
  steeringMessages: string[];
  inFlightSteeringCount?: number;
}

export interface ModelInfo {
  current: {
    modelId?: string;
    reasoningEffort?: string;
    reasoningSummary?: ReasoningSummary;
    contextTier?: string;
  };
  available: {
    list: unknown[];
  };
}

export interface DrainStatus {
  complete: boolean;
  processingSessions: string[];
  disconnectedSessions: number;
}

export interface PrepareRestartResult {
  drain: DrainStatus;
  checkpointedTerminals: number;
}

export interface PermissionRequest {
  type: "permission_requested";
  sessionId: string;
  requestId: string;
  request: {
    kind?: unknown;
    toolCallId?: string;
    managedApprovalRequired?: boolean;
    [key: string]: unknown;
  };
}

type DaemonEventPayload =
  | {
      type: "session_event";
      sessionId: string;
      event: SessionEvent;
    }
  | PermissionRequest
  | {
      type: "permission_resolved";
      sessionId: string;
      requestId: string;
      approved: boolean;
    }
  | { type: "runtime_status"; status: RuntimeStatus }
  | { type: "tool_inventory_updated"; sessionId: string }
  | { type: "event_gap"; sessionId?: string | null; skipped: number }
  | { type: "session_attached"; sessionId: string }
  | { type: "session_deleted"; sessionId: string }
  | { type: "interaction_requested"; interaction: PendingInteraction }
  | { type: "interaction_resolved"; sessionId: string; requestId: string };

export type DaemonEvent = DaemonEventPayload & {
  sequence?: number;
};

export type TerminalServerMessage =
  | {
      type: "ready";
      sessionId: string;
      cwd: string;
      shell: string;
      restored: boolean;
      hasControl: boolean;
      viewers: number;
    }
  | { type: "output"; data: string }
  | { type: "snapshot"; data: string }
  | { type: "cwd"; cwd: string }
  | { type: "control_changed"; controller?: string | null; viewers: number }
  | { type: "exit" }
  | { type: "error"; message: string };
