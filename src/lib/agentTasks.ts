import type { SessionEvent } from "./types.ts";

export interface AgentTask {
  id: string;
  name: string;
  agentType: string;
  status: string;
  toolCallId: string;
  model?: string;
  canMessage: boolean;
  unavailableReason?: string;
}

export interface AgentTaskList {
  sessionId: string;
  tasks: AgentTask[];
}

export interface AgentHistory {
  sessionId: string;
  taskId: string;
  agentId?: string;
  events: SessionEvent[];
  cursor: string | null;
  hasMore: boolean;
}

export function activeAgent(task: AgentTask): boolean {
  return task.status === "running" || task.status === "idle";
}

export function visibleAgents(tasks: AgentTask[], showFinished: boolean, selectedId?: string): AgentTask[] {
  return tasks.filter((task) => showFinished || activeAgent(task) || task.id === selectedId);
}

export function agentKey(sessionId: string, taskId: string): string {
  return JSON.stringify([sessionId, taskId]);
}

export function normalizeAgentTasks(raw: unknown, sessionId: string): AgentTaskList {
  if (!raw || typeof raw !== "object" || !("sessionId" in raw) || raw.sessionId !== sessionId ||
      !("tasks" in raw) || !Array.isArray(raw.tasks)) {
    throw new Error("The runtime did not return this session's subagents.");
  }
  const tasks = raw.tasks.map((task: unknown): AgentTask => {
    if (!task || typeof task !== "object" || !("id" in task) || typeof task.id !== "string" ||
        !("name" in task) || typeof task.name !== "string" ||
        !("agentType" in task) || typeof task.agentType !== "string" ||
        !("status" in task) || typeof task.status !== "string" ||
        !("toolCallId" in task) || typeof task.toolCallId !== "string" ||
        !("canMessage" in task) || typeof task.canMessage !== "boolean") {
      throw new Error("The runtime returned invalid subagent metadata.");
    }
    return {
      id: task.id, name: task.name, agentType: task.agentType, status: task.status,
      toolCallId: task.toolCallId, canMessage: task.canMessage,
      model: "model" in task && typeof task.model === "string" ? task.model : undefined,
      unavailableReason: "unavailableReason" in task && typeof task.unavailableReason === "string" ? task.unavailableReason : undefined,
    };
  });
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) {
    throw new Error("The runtime returned duplicate subagent IDs.");
  }
  return { sessionId, tasks };
}

export function agentEventMatches(event: SessionEvent, agentId: string | undefined): boolean {
  return !!agentId && event.agentId === agentId;
}

const rootEventCache = new WeakMap<SessionEvent, SessionEvent>();

export function agentRootEvents(events: SessionEvent[], agentId: string | undefined): SessionEvent[] {
  return events.filter((event) => agentEventMatches(event, agentId)).map((event) => {
    const cached = rootEventCache.get(event);
    if (cached) return cached;
    const { agentId: _, ...root } = event;
    rootEventCache.set(event, root);
    return root;
  });
}
