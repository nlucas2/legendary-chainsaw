import type { SessionInitialization, SessionInitializationSnapshot, SessionSummary } from "./types.ts";

/** Native indexing and already-running list requests can lag a successful create. */
export class SessionStartupIndex {
  private created = new Set<string>();
  private deleted = new Set<string>();

  add(sessionId: string): void {
    this.created.add(sessionId);
    this.deleted.delete(sessionId);
  }

  remove(sessionId: string): void {
    this.created.delete(sessionId);
    this.deleted.add(sessionId);
  }

  reconcile(current: SessionSummary[], incoming: SessionSummary[]): SessionSummary[] {
    const previous = new Map(current.map((session) => [session.sessionId, session]));
    const next = incoming.filter((session) => !this.deleted.has(session.sessionId)).map((session) => {
      const local = previous.get(session.sessionId);
      // A native stub without readiness must not detach a newly created workspace
      // or trigger resume (which waits for warmup and can replay pending work).
      if (local?.initialization && !session.initialization && this.created.has(session.sessionId)) {
        return { ...session, initialization: local.initialization, isActive: local.isActive };
      }
      return session;
    });
    const listed = new Set(next.map((session) => session.sessionId));
    const missing = current.filter((session) => !listed.has(session.sessionId)
      && !this.deleted.has(session.sessionId)
      && (this.created.has(session.sessionId) || session.initialization?.phase === "initializing"));
    // Native timestamped rows already have their normal recency ordering.
    const awaitingTimestamp = (session: SessionSummary) =>
      this.created.has(session.sessionId) && !session.modifiedTime;
    return [...missing, ...next.filter(awaitingTimestamp), ...next.filter((session) => !awaitingTimestamp(session))];
  }
}

export function validInitialization(value: unknown): value is SessionInitialization {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return ["initializing", "ready", "failed"].includes(String(data.phase))
    && typeof data.stage === "string"
    && (data.error === undefined || typeof data.error === "string");
}

export function startupSnapshot(value: unknown, sessionId: string): SessionInitializationSnapshot {
  if (!value || typeof value !== "object") throw new Error("The daemon returned an invalid startup status.");
  const data = value as Record<string, unknown>;
  if (data.sessionId !== sessionId || !validInitialization(data.initialization)) {
    throw new Error("The daemon returned invalid or mismatched session startup status.");
  }
  if (data.session !== undefined && (!data.session || typeof data.session !== "object"
    || !("sessionId" in data.session) || data.session.sessionId !== sessionId)) {
    throw new Error("The startup response belongs to another session.");
  }
  return value as SessionInitializationSnapshot;
}

export function startupStageLabel(status: SessionInitialization): string {
  if (status.phase === "failed") return "Session initialization failed";
  if (status.phase === "ready") return "Session is ready";
  if (status.stage === "model") return "Resolving session model...";
  if (status.stage === "tools") return "Initializing tools and MCP servers...";
  return "Preparing the session...";
}
