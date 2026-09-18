import type { SessionInitialization, SessionInitializationSnapshot } from "./types.ts";

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
