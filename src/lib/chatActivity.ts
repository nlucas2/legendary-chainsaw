import type { SessionEvent } from "./types.ts";

export type ChatPhase = "idle" | "submitting" | "working" | "waiting" | "stopping" | "error";

export interface ChatActivity {
  phase: ChatPhase;
  submittedAt?: number;
  acceptedAt?: number;
  modelStartedAt?: number;
  firstOutputAt?: number;
  finishedAt?: number;
  error?: string;
  awaitingUserEvent?: boolean;
}

export function emptyActivity(): ChatActivity {
  return { phase: "idle" };
}

export function submittedActivity(now: number): ChatActivity {
  return { phase: "submitting", submittedAt: now, awaitingUserEvent: true };
}

export function activityFromEvent(
  current: ChatActivity,
  event: SessionEvent,
  receivedAt: number,
): ChatActivity {
  if (event.agentId || event.type.startsWith("subagent.")) return current;
  if (event.type === "user.message") {
    return current.awaitingUserEvent && current.phase !== "error"
      ? { ...current, phase: "working", acceptedAt: current.acceptedAt ?? receivedAt, awaitingUserEvent: false }
      : { phase: "working" };
  }
  if (event.type === "session.idle") {
    return { ...current, phase: "idle", finishedAt: receivedAt };
  }
  if (event.type === "session.error") {
    const message = event.data.message ?? event.data.error;
    return {
      ...current,
      phase: "error",
      error: typeof message === "string" ? message : "The runtime reported a session error.",
      finishedAt: receivedAt,
    };
  }
  if (event.type === "model.call_start") {
    return { ...current, phase: "working", modelStartedAt: current.modelStartedAt ?? receivedAt };
  }
  if (
    event.type === "assistant.message_delta" ||
    event.type === "assistant.reasoning_delta" ||
    event.type === "assistant.message" ||
    event.type === "assistant.reasoning"
  ) {
    const content = event.data.deltaContent ?? event.data.content;
    if (typeof content !== "string" || !content.trim()) return current;
    if (current.firstOutputAt !== undefined && current.phase === "working") return current;
    return { ...current, phase: "working", firstOutputAt: current.firstOutputAt ?? receivedAt };
  }
  if (event.type === "assistant.turn_start" || event.type === "tool.execution_start") {
    return current.phase === "working" ? current : { ...current, phase: "working" };
  }
  // assistant.turn_end closes one model call, not the whole agent interaction.
  return current;
}

export function activityIsProcessing(activity: ChatActivity): boolean {
  return ["submitting", "working", "waiting", "stopping"].includes(activity.phase);
}

export function activityTimings(activity: ChatActivity): string {
  const submittedAt = activity.submittedAt;
  if (submittedAt === undefined) return "";
  const elapsed = (at: number) => {
    const ms = Math.max(0, at - submittedAt);
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
  };
  return [
    activity.acceptedAt !== undefined ? `Accepted ${elapsed(activity.acceptedAt)}` : "",
    activity.modelStartedAt !== undefined ? `Model started ${elapsed(activity.modelStartedAt)}` : "",
    activity.firstOutputAt !== undefined ? `First output ${elapsed(activity.firstOutputAt)}` : "",
  ].filter(Boolean).join(" · ");
}

export function isTranscriptEvent(event: SessionEvent): boolean {
  return (
    event.type.startsWith("assistant.") &&
      !["assistant.streaming_delta", "assistant.usage", "assistant.idle"].includes(event.type)
  ) || event.type.startsWith("tool.execution_") ||
    event.type.startsWith("subagent.") ||
    event.type.startsWith("session.compaction_") ||
    event.type === "user.message" ||
    event.type === "session.start" ||
    event.type === "session.resume" ||
    event.type === "session.idle" ||
    event.type === "session.error" ||
    event.type === "abort" ||
    event.type === "session.model_change" ||
    event.type === "session.model_changed" ||
    event.type === "session.auto_mode_resolved" ||
    event.type === "session.mcp_server_status_changed" ||
    event.type === "session.mcp_servers_loaded" ||
    event.type === "session.skills_loaded" ||
    event.type === "session.instructions_loaded" ||
    event.type === "session.custom_agents_updated" ||
    event.type === "session.plugins_loaded" ||
    event.type === "session.extensions_loaded" ||
    event.type === "command.result";
}
