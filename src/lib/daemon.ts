import type { DaemonEvent } from "./types";

const LOCAL_DAEMON = "http://127.0.0.1:3847";
const CLIENT_ID_KEY = "copilot-sessions.client-id";

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
): Promise<T> {
  const response = await fetch(
    `${daemonBaseUrl()}/api/${encodeURIComponent(command)}`,
    {
      method: "POST",
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
): () => void {
  const source = new EventSource(`${daemonBaseUrl()}/api/events`, {
    withCredentials: true,
  });
  source.onopen = () => onConnection(true);
  source.onerror = () => onConnection(false);
  source.addEventListener("session-event", (raw) => {
    try {
      onEvent(JSON.parse((raw as MessageEvent<string>).data) as DaemonEvent);
    } catch (error) {
      console.error("Invalid daemon event", error);
    }
  });
  return () => source.close();
}

export function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}
