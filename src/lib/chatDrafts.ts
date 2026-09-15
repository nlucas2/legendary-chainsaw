import type { AttachmentDraft } from "./attachments.ts";

export interface ChatDraft {
  text: string;
  attachments: AttachmentDraft[];
}

interface SavedDraft {
  id: string;
  draft: ChatDraft;
  error?: string;
}

interface SessionDrafts {
  current: ChatDraft;
  saved: SavedDraft[];
  stash?: ChatDraft;
  error?: string;
}

export type DraftState = Record<string, SessionDrafts>;
export type DraftAction =
  | { type: "edit"; sessionId: string; update: (draft: ChatDraft) => ChatDraft }
  | { type: "submitted"; sessionId: string }
  | { type: "stash"; sessionId: string }
  | { type: "failed"; sessionId: string; id: string; draft: ChatDraft; error: string }
  | { type: "restore" | "discard"; sessionId: string; id: string }
  | { type: "delete"; sessionId: string };

export const EMPTY_DRAFT: ChatDraft = { text: "", attachments: [] };
export const EMPTY_SESSION_DRAFTS: SessionDrafts = { current: EMPTY_DRAFT, saved: [] };

export function draftIsEmpty(draft: ChatDraft): boolean {
  return draft.text.length === 0 && draft.attachments.length === 0;
}

export function chatDraftReducer(state: DraftState, action: DraftAction): DraftState {
  if (action.type === "delete") {
    const next = { ...state };
    delete next[action.sessionId];
    return next;
  }
  const session = state[action.sessionId] ?? EMPTY_SESSION_DRAFTS;
  let next: SessionDrafts;
  switch (action.type) {
    case "edit":
      next = { ...session, current: action.update(session.current) };
      break;
    case "submitted":
      next = { ...session, current: EMPTY_DRAFT, error: undefined };
      break;
    case "stash":
      next = { ...session, current: session.stash ?? EMPTY_DRAFT, stash: session.current };
      break;
    case "failed":
      next = draftIsEmpty(session.current)
        ? { ...session, current: action.draft, error: action.error }
        : { ...session, saved: [...session.saved, { id: action.id, draft: action.draft, error: action.error }] };
      break;
    case "restore": {
      const saved = session.saved.find((entry) => entry.id === action.id);
      if (!saved) return state;
      const remaining = session.saved.filter((entry) => entry.id !== action.id);
      if (!draftIsEmpty(session.current)) {
        remaining.push({ id: saved.id, draft: session.current, error: session.error });
      }
      next = { ...session, current: saved.draft, saved: remaining, error: saved.error };
      break;
    }
    case "discard":
      next = { ...session, saved: session.saved.filter((entry) => entry.id !== action.id) };
      break;
  }
  return { ...state, [action.sessionId]: next };
}
