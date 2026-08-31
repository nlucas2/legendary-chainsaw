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

export interface ModelInfo {
  current: {
    modelId?: string;
    reasoningEffort?: string;
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

export type DaemonEvent =
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
  | { type: "session_attached"; sessionId: string }
  | { type: "session_deleted"; sessionId: string };

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
