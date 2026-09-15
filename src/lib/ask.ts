export interface AskResult {
  sessionId: string;
  answer: string;
}

export function normalizeAskResult(value: unknown, sessionId: string): AskResult {
  if (!value || typeof value !== "object"
    || !("sessionId" in value) || value.sessionId !== sessionId
    || !("answer" in value) || typeof value.answer !== "string") {
    throw new Error("The runtime returned an invalid or mismatched /ask answer.");
  }
  return { sessionId, answer: value.answer };
}

export class AskRequests {
  private pending = new Map<string, symbol>();

  start(sessionId: string, question: string): symbol {
    if (!question.trim()) throw new Error("Enter a question first.");
    if (this.pending.has(sessionId)) throw new Error("An /ask query is already running for this session.");
    const token = Symbol(sessionId);
    this.pending.set(sessionId, token);
    return token;
  }

  finish(sessionId: string, token: symbol): boolean {
    if (this.pending.get(sessionId) !== token) return false;
    this.pending.delete(sessionId);
    return true;
  }
}

export const askRequests = new AskRequests();

export interface NativeAskEvent {
  sessionId: string;
  requestId: string;
  phase: "started" | "chunk" | "completed" | "failed" | "aborted";
  chunk?: string;
  answer?: string;
  error?: string;
}

const listeners = new Map<string, Set<(event: NativeAskEvent) => void>>();
const queryKey = (sessionId: string, requestId: string) => JSON.stringify([sessionId, requestId]);

// Subscribe only when the runtime explicitly correlates a request with this ID.
// SDK 1.0.13-preview.1 cannot do that, so AskPanel uses its own RPC final answer.
export function subscribeAskEvents(
  sessionId: string,
  requestId: string,
  listener: (event: NativeAskEvent) => void,
): () => void {
  const key = queryKey(sessionId, requestId);
  const subscribers = listeners.get(key) ?? new Set();
  subscribers.add(listener);
  listeners.set(key, subscribers);
  return () => {
    subscribers.delete(listener);
    if (!subscribers.size) listeners.delete(key);
  };
}

export function ingestAskEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const envelope = event as Record<string, unknown>;
  if (envelope.type !== "session_event" || typeof envelope.sessionId !== "string") return false;
  const native = envelope.event as Record<string, unknown> | undefined;
  if (native?.type !== "ui.ephemeral_query" || !native.data || typeof native.data !== "object") return false;
  const data = native.data as Record<string, unknown>;
  if (typeof data.requestId !== "string" || !data.requestId || typeof data.phase !== "string"
    || !["started", "chunk", "completed", "failed", "aborted"].includes(data.phase)) return false;
  if ((data.phase === "chunk" && typeof data.chunk !== "string")
    || (data.phase === "completed" && typeof data.answer !== "string")
    || (data.phase === "failed" && typeof data.error !== "string")) return false;
  const subscribers = listeners.get(queryKey(envelope.sessionId, data.requestId));
  if (!subscribers?.size) return false;
  const update: NativeAskEvent = {
    sessionId: envelope.sessionId, requestId: data.requestId, phase: data.phase as NativeAskEvent["phase"],
    chunk: typeof data.chunk === "string" ? data.chunk : undefined,
    answer: typeof data.answer === "string" ? data.answer : undefined,
    error: typeof data.error === "string" ? data.error : undefined,
  };
  for (const listener of subscribers) listener(update);
  return true;
}
