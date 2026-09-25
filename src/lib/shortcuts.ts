type ShortcutEvent = Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "isComposing">;

export function isTerminalCopy(event: ShortcutEvent, hasSelection: boolean): boolean {
  return hasSelection && !event.isComposing && !event.altKey && !event.shiftKey
    && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c";
}

export function adjacentSession<T extends { sessionId: string }>(
  sessions: readonly T[], currentId: string | null, direction: -1 | 1,
): T | undefined {
  if (!sessions.length) return undefined;
  const index = sessions.findIndex((session) => session.sessionId === currentId);
  if (index < 0) return direction === 1 ? sessions[0] : sessions[sessions.length - 1];
  return sessions[(index + direction + sessions.length) % sessions.length];
}
