import type { SessionEvent } from "./types.ts";

export interface SessionUsage {
  totalNanoAiu: number | null;
}

export function normalizeSessionUsage(value: unknown): SessionUsage {
  const total = typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>).totalNanoAiu
    : undefined;
  return {
    totalNanoAiu: typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : null,
  };
}

export function formatAiCredits(totalNanoAiu: number | null): string {
  if (totalNanoAiu === null || !Number.isFinite(totalNanoAiu) || totalNanoAiu < 0) return "Unavailable";
  // The SDK's factory accounting converts AI credits to nano-AIU with this scale.
  const credits = totalNanoAiu / 1_000_000_000;
  if (credits > 0 && credits < 0.000001) return "<0.000001";
  return credits.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

export function isSessionUsageEvent(event: SessionEvent): boolean {
  return [
    "assistant.usage", "assistant.idle", "session.usage_checkpoint", "session.shutdown",
    "subagent.completed", "subagent.failed",
  ].includes(event.type);
}
