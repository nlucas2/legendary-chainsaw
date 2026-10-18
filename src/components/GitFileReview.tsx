import { useEffect, useId, useMemo, useRef, useState } from "react";
import { daemonInvoke } from "../lib/daemon";
import {
  assertGitDiffMatches, createGitComment, diffIdentity, loadGitComments,
  MAX_COMMENT_LENGTH, MAX_COMMENTS, MAX_SELECTION, parseUnifiedDiff, saveGitComments, visiblePath,
  type GitComment, type GitContext, type GitDiff, type GitView, type GitWorkspace,
} from "../lib/gitWorkspace";
import { gitReviewContext } from "../lib/gitReview";
import type { ReviewChatContext } from "../lib/reviewChat";
import { GitDiffLines } from "./GitDiffLines";
import { GitInlineNote } from "./GitInlineNote";

const MAX_NOTE_DRAFTS = 32;

export interface GitFileReviewProps {
  sessionId: string;
  workspace: GitWorkspace;
  view: GitView;
  path: string;
  comments: GitComment[];
  onCommentsChange: (comments: GitComment[]) => void;
  onAsk: (question: string, context?: ReviewChatContext) => void;
  onDiscuss: (context: ReviewChatContext) => void;
  load: (run: () => Promise<GitDiff>, signal: AbortSignal) => Promise<GitDiff>;
  continuous?: boolean;
  onLoaded?: (path: string) => void;
  onDiffLoaded?: (diff: GitDiff) => void;
  /** Keep above repository/file remounts; keys are verified diffIdentity values. */
  draftStore?: Map<string, string>;
}

export function GitFileReview({ sessionId, workspace, view, path, comments, onCommentsChange, onAsk, onDiscuss, load, continuous, onLoaded, onDiffLoaded, draftStore }: GitFileReviewProps) {
  const [loadedDiff, setDiff] = useState<{ value: GitDiff; scope: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [context, setContext] = useState<GitContext>("changes");
  const [revision, setRevision] = useState(0);
  const scope = JSON.stringify([sessionId, workspace.repoRoot, view, path, context, revision,
    workspace.head, ...(view === "compare" ? [workspace.base, workspace.baseCommit, workspace.mergeBase] : [])]);
  const draftScope = JSON.stringify([sessionId, workspace.repoRoot, view, path]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [commentText, setCommentText] = useState("");
  const [commentError, setCommentError] = useState("");
  const [notice, setNotice] = useState("");
  const [noteAnchor, setNoteAnchor] = useState<HTMLElement | null>(null);
  const selectionDiff = useRef<GitDiff | null>(null);
  const focusTarget = useRef<HTMLElement | null>(null);
  const file = useRef<HTMLElement>(null);
  const draftCache = useRef(draftStore);
  draftCache.current = draftStore;
  const reportDiff = useRef(onDiffLoaded);
  useEffect(() => { reportDiff.current = onDiffLoaded; }, [onDiffLoaded]);
  const draft = useRef({ scope: draftScope, identity: "", text: "" });
  const commentId = useId();
  const diff = loadedDiff?.scope === scope ? loadedDiff.value : null;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setDiff(null);
    setSelected(new Set());
    selectionDiff.current = null;
    setNoteAnchor(null);
    setNotice("");
    void load(async () => {
      const result = await daemonInvoke<GitDiff>("git_diff", {
        sessionId, view, path,
        ...(workspace.repoRoot !== null ? { workingPath: workspace.repoRoot } : {}),
        ...(context === "full" ? { context } : {}),
        ...(view === "compare" && workspace.base && workspace.baseCommit ? { base: workspace.base } : {}),
      }, controller.signal);
      assertGitDiffMatches(result, workspace, view, path, context);
      return result;
    }, controller.signal).then((result) => {
      if (!controller.signal.aborted) {
        const identity = diffIdentity(result);
        const restored = draftCache.current?.get(identity);
        const text = restored ?? (draft.current.scope === draftScope ? draft.current.text : "");
        if (restored !== undefined || !text) draft.current = { scope: draftScope, identity, text };
        setCommentText(text);
        setDiff({ value: result, scope });
        reportDiff.current?.(result);
      }
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(String(cause));
    }).finally(() => {
      if (!controller.signal.aborted) { setLoading(false); onLoaded?.(path); }
    });
    return () => controller.abort();
  }, [scope, load, onLoaded]);

  useEffect(() => {
    const opened = (event: Event) => {
      if (!(event instanceof CustomEvent) || !(event.detail instanceof HTMLElement) || event.detail === file.current) return;
      if (event.detail.closest(".git-panel, [role='dialog']") === file.current?.closest(".git-panel, [role='dialog']")) setNoteAnchor(null);
    };
    window.addEventListener("git-inline-note-open", opened);
    return () => window.removeEventListener("git-inline-note-open", opened);
  }, []);

  const lines = useMemo(() => parseUnifiedDiff(diff?.patch ?? ""), [diff]);
  const identity = diff ? diffIdentity(diff) : "";
  const currentComments = comments.filter((comment) => comment.identity === identity);
  const olderComments = diff ? comments.filter((comment) => {
    try {
      const parts: unknown = JSON.parse(comment.identity);
      return Array.isArray(parts) && parts[0] === diff.repoRoot && parts[1] === diff.path && comment.identity !== identity;
    } catch { return false; }
  }).length : 0;
  const canAsk = !!diff?.patch && !loading;
  const validSelection = canAsk && selectionDiff.current === diff && selected.size > 0
    && [...selected].every((index) => lines[index] && ["add", "delete", "context"].includes(lines[index].kind));
  function changeSelection(next: Set<number>) {
    selectionDiff.current = diff;
    setSelected(next);
    if (!next.size) setNoteAnchor(null);
  }
  function commitSelection(anchor: HTMLElement) {
    if (!diff || loading) return;
    focusTarget.current = anchor.closest<HTMLElement>("[role='listbox']");
    setNoteAnchor(anchor);
    window.dispatchEvent(new CustomEvent("git-inline-note-open", { detail: file.current }));
  }
  function closeEditor() {
    setNoteAnchor(null);
    focusTarget.current?.focus({ preventScroll: true });
  }
  function changeCommentText(text: string) {
    const cache = draftCache.current;
    if (cache) {
      cache.set(identity, text);
      for (const oldest of cache.keys()) {
        if (cache.size <= MAX_NOTE_DRAFTS) break;
        cache.delete(oldest);
      }
    }
    draft.current = { scope: draftScope, identity, text };
    setCommentText(text);
  }
  function storeComment() {
    try {
      if (!diff || !validSelection) throw new Error("Select code lines in the current diff before saving a note.");
      const comment = createGitComment(diff, lines, selected, commentText);
      const latest = loadGitComments(localStorage);
      if (latest.length >= MAX_COMMENTS) throw new Error(`This client already has ${MAX_COMMENTS} Git comments. Remove older comments first.`);
      const next = [...latest, comment];
      saveGitComments(localStorage, next);
      onCommentsChange(next);
      const cache = draftCache.current;
      cache?.delete(identity);
      if (draft.current.scope === draftScope && draft.current.identity !== identity
        && cache?.get(draft.current.identity) === draft.current.text) cache.delete(draft.current.identity);
      draft.current = { scope: draftScope, identity, text: "" };
      setCommentText("");
      setCommentError("");
      setNotice("Comment saved in this browser only; nothing was posted or written to the repository.");
      return true;
    } catch (cause) { setCommentError(String(cause)); return false; }
  }
  function deleteComment(id: string) {
    try {
      const next = loadGitComments(localStorage).filter((comment) => comment.id !== id);
      saveGitComments(localStorage, next);
      onCommentsChange(next);
      setCommentError("");
    } catch (cause) { setCommentError(String(cause)); }
  }
  function ask(comment?: GitComment, discuss = false) {
    if (!diff || !canAsk) return;
    try {
      const context = gitReviewContext(diff, lines, selected, comment, commentText);
      if (discuss) onDiscuss(context);
      else onAsk(context.suggestedQuestion, context);
      setNotice("Review context prepared. Nothing was sent.");
      setCommentError("");
    } catch (cause) { setCommentError(String(cause)); }
  }
  return <article ref={file} className={`git-file-review${continuous ? " continuous" : ""}`} aria-label={`Diff for ${visiblePath(path)}`} data-diff-path={path}>
    <header className="git-file-review-header">
      <h3>{visiblePath(path)} {diff && diff.kind !== "file" && <small>({diff.kind})</small>}</h3>
      {view !== "untracked" && <label className="git-full-context">
        <input type="checkbox" checked={context === "full"} onChange={(event) => setContext(event.target.checked ? "full" : "changes")} />
        Whole-file context
      </label>}
    </header>
    {loading && <p role="status">Loading selected file diff...</p>}
    {error && <p role="alert" className="git-panel-error">{error} <button type="button" onClick={() => setRevision((value) => value + 1)}>Retry diff</button></p>}
    {diff && <>
      {view === "untracked" && <p className="git-panel-view-description">New, untracked file — previewed as additions. Viewing or commenting does not stage the file.</p>}
      {diff.head !== workspace.head && <p className="git-panel-warning">HEAD changed since the file list was loaded. This preview uses HEAD {diff.head?.slice(0, 12)}; refresh the workspace.</p>}
      {diff.kind === "symlink" && <p className="git-panel-warning">Symlink: the patch shows link metadata/target text, not the target file's contents.</p>}
      {context === "full" && <p className="git-panel-view-description">
        {diff.fullContextComplete ? "Complete file context." : "Whole-file context requested; the preview may be partial or metadata-only."}{" "}
        Deleted lines show the old version; added and context lines show the selected new version.
      </p>}
      {diff.unavailableReason && <p className="git-panel-warning">{diff.unavailableReason}</p>}
      {diff.warnings.map((warning, index) => <p className="git-panel-warning" key={index}>{warning}</p>)}
      {diff.truncated && <p className="git-panel-warning" role="status">Partial preview — this diff was truncated. Omitted code will not be included in the review draft.</p>}
      {diff.patch && <>
        <div className="git-panel-diff-actions">
          <span>{selected.size} code line{selected.size === 1 ? "" : "s"} selected</span>
          <button type="button" disabled={!selected.size} onClick={() => changeSelection(new Set())}>Clear selection</button>
          <button type="button" disabled={!canAsk} onClick={() => ask()}>Quick ask about {selected.size ? "selected lines" : "this diff"}</button>
          <button type="button" disabled={!canAsk} onClick={() => ask(undefined, true)}>Discuss {selected.size ? "selected lines" : "this diff"} in chat</button>
        </div>
        {selected.size > MAX_SELECTION && <p role="status" className="git-panel-warning">Select 40 or fewer code lines to save one note. Clear the selection or start a smaller range.</p>}
        <GitDiffLines lines={lines} selected={selected} onChange={changeSelection}
          onSelectionStart={() => setNoteAnchor(null)} onSelectionCommit={commitSelection} />
        <GitInlineNote anchor={validSelection ? noteAnchor : null} onClose={closeEditor}>
          {(floating) => <>
            {floating && <small className="git-note-file" title={visiblePath(path)}>{visiblePath(path)}</small>}
            <label htmlFor={commentId}>Local review comment</label>
            <small>Local only - saved in this browser, never written to the repository.</small>
            <textarea id={commentId} value={commentText} maxLength={MAX_COMMENT_LENGTH}
              placeholder="Select or highlight code lines, then leave a local note..."
              onChange={(event) => changeCommentText(event.target.value)} />
            <div className="git-note-actions">
              <button type="button" disabled={!validSelection || !commentText.trim() || selected.size > MAX_SELECTION}
                onClick={() => { if (storeComment() && floating) closeEditor(); }}>Save local comment</button>
              {floating && <button type="button" onClick={closeEditor}>Close note editor</button>}
            </div>
            <small>{selected.size}/{MAX_SELECTION} selected lines · {commentText.length}/{MAX_COMMENT_LENGTH} characters. Save notes across files, then use "Bring all notes into chat". Notes stay in this browser until explicitly attached.</small>
            {commentError && <p role="alert" className="git-panel-error">Local comments: {commentError}</p>}
          </>}
        </GitInlineNote>
      </>}
      {olderComments > 0 && <p className="git-panel-warning">{olderComments} older comment(s) belong to a different view, base, HEAD or diff content and are not attached to these lines.</p>}
      {currentComments.length > 0 && <div className="git-panel-comments" aria-label="Local Git review comments">
        {currentComments.map((comment) => <article key={comment.id}>
          <small>{comment.locations.map((line) => line.location).join(", ")}</small>
          <p>{comment.body}</p>
          <button type="button" disabled={!canAsk} onClick={() => ask(comment)}>Quick ask about comment</button>
          <button type="button" disabled={!canAsk} onClick={() => ask(comment, true)}>Discuss comment in chat</button>
          <button type="button" onClick={() => deleteComment(comment.id)}>Remove local comment</button>
        </article>)}
      </div>}
    </>}
    {commentError && !diff?.patch && <p role="alert" className="git-panel-error">Local comments: {commentError}</p>}
    {notice && <p role="status">{notice}</p>}
  </article>;
}
