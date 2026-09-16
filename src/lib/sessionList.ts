import type { SessionSummary } from "./types.ts";

export type SessionView = "current" | "archived" | "all";
export interface SessionGroup {
  key: string;
  name: string;
  pinned?: boolean;
  sessions: SessionSummary[];
}

export function filterSessions(sessions: SessionSummary[], search: string, view: SessionView): SessionSummary[] {
  const query = search.trim().toLowerCase();
  return sessions.filter((session) => {
    const archived = session.archived === true;
    if (view !== "all" && archived !== (view === "archived")) return false;
    return !query || [session.title, session.cwd, session.folder, ...session.tags]
      .some((value) => value?.toLowerCase().includes(query));
  });
}

export function groupSessions(sessions: SessionSummary[]): SessionGroup[] {
  const groups: SessionGroup[] = [];
  const pinned = sessions.filter((session) => session.pinned);
  if (pinned.length) groups.push({ key: "pinned", name: "Pinned", pinned: true, sessions: pinned });
  const folders = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    if (session.pinned || !session.folder) continue;
    const current = folders.get(session.folder) ?? [];
    current.push(session);
    folders.set(session.folder, current);
  }
  for (const folder of [...folders.keys()].sort((a, b) => a.localeCompare(b))) {
    groups.push({ key: `folder:${folder}`, name: folder, sessions: folders.get(folder)! });
  }
  const loose = sessions.filter((session) => !session.pinned && !session.folder);
  if (loose.length) groups.push({ key: "loose", name: "Unfiled", sessions: loose });
  return groups;
}

/** Narrow metadata events must win over responses to earlier list/resume requests. */
export class SessionArchiveChanges {
  private revision = 0;
  private changes = new Map<string, { revision: number; archived: boolean }>();

  checkpoint(): number { return this.revision; }

  record(sessionId: string, archived: boolean): void {
    this.changes.set(sessionId, { revision: ++this.revision, archived });
  }

  changedSince(sessionId: string, checkpoint: number): boolean {
    return (this.changes.get(sessionId)?.revision ?? 0) > checkpoint;
  }

  reconcile(session: SessionSummary, checkpoint: number): SessionSummary {
    const change = this.changes.get(session.sessionId);
    return change && change.revision > checkpoint ? { ...session, archived: change.archived } : session;
  }
}
