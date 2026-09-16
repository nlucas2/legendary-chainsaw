import { useMemo, useState } from "react";
import { gitViewLabels, loadGitComments, visiblePath, type GitComment, type GitWorkspace } from "../lib/gitWorkspace";
import { gitNotesContext, noteSnapshotWarnings, repositoryNotes, savedGitIdentity, savedNoteContext } from "../lib/gitReview";
import type { ReviewChatContext } from "../lib/reviewChat";
import "./review-workflow.css";

export function GitReviewNotes({ workspace, comments, onCommentsChange, onDelete, onAsk, onDiscuss }: {
  workspace: GitWorkspace;
  comments: GitComment[];
  onCommentsChange: (comments: GitComment[]) => void;
  onDelete: (id: string) => void;
  onAsk: (question: string, context?: ReviewChatContext) => void;
  onDiscuss: (context: ReviewChatContext) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");
  const notes = useMemo(() => repositoryNotes(comments, workspace.repoRoot ?? "").map((note) => ({
    ...note, warnings: noteSnapshotWarnings(note.identity, workspace).join(" "),
  })), [comments, workspace]);
  const invalid = useMemo(() => comments.filter((comment) => !savedGitIdentity(comment)).length, [comments]);
  function handoff(comment?: GitComment, quick = false) {
    try {
      const latest = loadGitComments(localStorage);
      onCommentsChange(latest);
      const selected = comment ? latest.find((item) => item.id === comment.id) : undefined;
      if (comment && !selected) throw new Error("This note was removed in another window. Refresh the notes.");
      const context = selected ? savedNoteContext(selected, workspace) : gitNotesContext(latest, workspace);
      if (quick) onAsk(context.suggestedQuestion, context);
      else onDiscuss(context);
      setError("");
    } catch (cause) { setError(String(cause)); }
  }
  return <section className="git-review-notes" aria-label="Repository review notes">
    <div className="git-review-notes-toolbar">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>Review notes ({notes.length})</button>
      <button type="button" disabled={!notes.length} onClick={() => handoff()}>Bring all notes into chat</button>
    </div>
    <p className="git-panel-explanation">Select code lines, save notes across files, then bring this repository's notes into chat for discussion or triage. Nothing is sent automatically.</p>
    {error && <p role="alert" className="git-panel-error">{error}</p>}
    {invalid > 0 && <p className="git-panel-warning">{invalid} saved note(s) have unreadable snapshot metadata and cannot be included. They remain in the saved-note manager below.</p>}
    {expanded && <div className="git-review-notes-list">
      <p>Notes span all change views in this repository. Saved snapshots are not automatically rebased or marked resolved when attached.</p>
      {!notes.length && <p>No local review notes for this repository yet.</p>}
      {notes.map(({ comment, identity, warnings }) => <article key={comment.id} aria-label={`Review note ${comment.id}`}>
        <header><strong title={comment.id}>Note {comment.id.slice(0, 12)}</strong><span>{gitViewLabels[identity.view]}</span></header>
        <p><code>{visiblePath(identity.path)}</code> · {comment.locations.map((line) => line.location).join(", ")}</p>
        <p className="git-review-note-body">{comment.body}</p>
        <small>{warnings}{!comment.snapshot && " Only selected-line excerpts were saved for this older note."}</small>
        <div className="git-review-notes-toolbar">
          <button type="button" onClick={() => handoff(comment, true)}>Quick ask about note</button>
          <button type="button" onClick={() => handoff(comment)}>Discuss note in chat</button>
          <button type="button" onClick={() => onDelete(comment.id)}>Remove note</button>
        </div>
      </article>)}
    </div>}
  </section>;
}
