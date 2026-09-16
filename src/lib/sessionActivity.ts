import { activityFromEvent, type ChatActivity } from "./chatActivity.ts";
import type { SessionEvent } from "./types.ts";

export interface SessionActivity {
  kind: "working" | "idle" | "unknown";
  reason?: string;
}

export function processingActivity(value: unknown): SessionActivity {
  if (typeof value !== "boolean") throw new Error("The daemon did not return a valid processing state.");
  return { kind: value ? "working" : "idle" };
}

export function sessionActivityIndicator(attached: boolean, connected: boolean, activity?: SessionActivity) {
  if (!attached) return { kind: "inactive", label: "Not attached", description: "Not attached to this daemon. No background status query is made." };
  if (!connected) return { kind: "unknown", label: "Status unavailable", description: "Session status unavailable while disconnected." };
  if (!activity) return { kind: "unknown", label: "Checking status", description: "Checking this attached session's activity." };
  if (activity.kind === "unknown") return { kind: "unknown", label: "Status unavailable", description: activity.reason ?? "Session status is unavailable." };
  return activity.kind === "working"
    ? { kind: "working", label: "Working", description: "Working — this attached session is processing a turn." }
    : { kind: "idle", label: "Idle", description: "Idle — this attached session is ready for a message. Subagents have separate activity." };
}

export class SessionActivityTracker {
  private states = new Map<string, SessionActivity>();
  private versions = new Map<string, number>();

  snapshot(): Record<string, SessionActivity> { return Object.fromEntries(this.states); }
  version(sessionId: string): number { return this.versions.get(sessionId) ?? 0; }

  private write(sessionId: string, next: SessionActivity): boolean {
    const current = this.states.get(sessionId);
    if (current?.kind === next.kind && current.reason === next.reason) return false;
    this.states.set(sessionId, next);
    return true;
  }

  accept(sessionId: string, version: number, next: SessionActivity): boolean {
    return this.version(sessionId) === version && this.write(sessionId, next);
  }

  observe(sessionId: string, event: SessionEvent): boolean {
    const activity: ChatActivity = { phase: this.states.get(sessionId)?.kind === "working" ? "working" : "idle" };
    const next = activityFromEvent(activity, event, Date.now());
    if (next === activity) return false;
    // Even repeated streaming signals invalidate reads started before them, without repainting the dot.
    this.versions.set(sessionId, this.version(sessionId) + 1);
    return this.write(sessionId, next.phase === "error"
      ? { kind: "unknown", reason: next.error }
      : { kind: next.phase === "idle" ? "idle" : "working" });
  }

  invalidate(sessionId: string): boolean {
    this.versions.set(sessionId, this.version(sessionId) + 1);
    return this.states.delete(sessionId);
  }
}
