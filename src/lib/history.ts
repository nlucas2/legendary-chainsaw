import type { SessionEvent } from "./types.ts";
import { isHumanMessage } from "./messageOrigin.ts";

export function mergeEvents(events: SessionEvent[], incoming: SessionEvent[]): SessionEvent[] {
  if (incoming.length === 0) return events;
  const merged = [...events];
  const positions = new Map(merged.map((event, index) => [event.id, index]));
  for (const event of incoming) {
    const index = positions.get(event.id);
    if (index === undefined) {
      positions.set(event.id, merged.length);
      merged.push(event);
    } else {
      merged[index] = event;
    }
  }
  return merged;
}

export function reconcileOptimisticUserEvents(
  events: SessionEvent[],
  incoming: SessionEvent[],
): SessionEvent[] {
  const realMessages = incoming.filter(isHumanMessage);
  if (realMessages.length === 0) return events;
  const remaining = [...events];
  for (const message of realMessages) {
    const content = message.data.content;
    if (typeof content !== "string") continue;
    const optimisticIndex = remaining.findIndex(
      (event) =>
        event.id.startsWith("optimistic-user-") &&
        event.data.content === content,
    );
    if (optimisticIndex >= 0) remaining.splice(optimisticIndex, 1);
  }
  return remaining;
}

export function mergeHistoryEvents(history: SessionEvent[], current: SessionEvent[]): SessionEvent[] {
  const historyIds = new Set(history.map((event) => event.id));
  const positions = new Map(current.map((event, index) => [event.id, index]));
  const merged: SessionEvent[] = [];
  const seen = new Set<string>();
  let cursor = 0;
  const append = (event: SessionEvent) => {
    if (!seen.has(event.id)) {
      seen.add(event.id);
      merged.push(event);
    }
  };
  const appendCurrentUntil = (end: number) => {
    while (cursor < end) {
      const event = current[cursor++];
      if (!historyIds.has(event.id)) append(event);
    }
  };
  // Shared IDs anchor cached prefixes and ephemeral live events to the log.
  // Wall-clock timestamps are not ordering keys and can move backwards.
  const firstShared = history.find((event) => positions.has(event.id));
  if (firstShared) appendCurrentUntil(positions.get(firstShared.id)!);
  for (const event of history) {
    const index = positions.get(event.id);
    if (index !== undefined) {
      appendCurrentUntil(index);
      append(current[index]);
      cursor = Math.max(cursor, index + 1);
    } else {
      append(event);
    }
  }
  appendCurrentUntil(current.length);
  return merged;
}
