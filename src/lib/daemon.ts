import type { DaemonEvent } from "./types";

const LOCAL_DAEMON = "http://127.0.0.1:3847";
const CLIENT_ID_KEY = "copilot-sessions.client-id";
const EVENT_SEQUENCE_KEY = "copilot-sessions.event-sequence";

export function daemonClientId(): string {
  try {
    const existing = sessionStorage.getItem(CLIENT_ID_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    sessionStorage.setItem(CLIENT_ID_KEY, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

export function daemonBaseUrl(): string {
  if (isTauri()) {
    return LOCAL_DAEMON;
  }
  if (window.location.protocol === "http:" || window.location.protocol === "https:") {
    return window.location.origin;
  }
  return LOCAL_DAEMON;
}

export function daemonWebSocketUrl(path: string): string {
  const base = new URL(daemonBaseUrl());
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = path;
  return base.toString();
}

export class DaemonError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export async function daemonInvoke<T>(
  command: string,
  args: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(
    `${daemonBaseUrl()}/api/${encodeURIComponent(command)}`,
    {
      method: "POST",
      signal,
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    },
  );
  if (!response.ok) {
    throw new DaemonError((await response.text()) || response.statusText, response.status);
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function daemonLogin(token: string): Promise<void> {
  const response = await fetch(`${daemonBaseUrl()}/api/login`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) {
    throw new DaemonError((await response.text()) || response.statusText, response.status);
  }
}

export function subscribeToDaemon(
  onEvent: (event: DaemonEvent) => void,
  onConnection: (connected: boolean) => void,
  diagnostics = false,
): () => void {
  const url = new URL(`${daemonBaseUrl()}/api/events`);
  if (diagnostics) url.searchParams.set("diagnostics", "true");
  let latestSequence: number | undefined;
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  const persistCursor = () => {
    persistTimer = undefined;
    if (latestSequence === undefined) return;
    try {
      sessionStorage.setItem(EVENT_SEQUENCE_KEY, String(latestSequence));
    } catch {
      // EventSource's Last-Event-ID still resumes an open connection.
    }
  };
  try {
    const sequence = sessionStorage.getItem(EVENT_SEQUENCE_KEY);
    if (sequence) url.searchParams.set("after", sequence);
  } catch {
    // EventSource still provides in-connection replay through Last-Event-ID.
  }
  const source = new EventSource(url, {
    withCredentials: true,
  });
  source.onopen = () => onConnection(true);
  source.onerror = () => onConnection(false);
  source.addEventListener("session-event", (raw) => {
    try {
      const event = JSON.parse((raw as MessageEvent<string>).data) as DaemonEvent;
      onEvent(event);
      if (typeof event.sequence === "number") {
        latestSequence = event.sequence;
        persistTimer ??= setTimeout(persistCursor, 250);
      }
    } catch (error) {
      console.error("Invalid daemon event", error);
    }
  });
  return () => {
    source.close();
    if (persistTimer !== undefined) clearTimeout(persistTimer);
    persistCursor();
  };
}

export function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}
