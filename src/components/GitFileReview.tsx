import { useEffect, useId, useMemo, useState } from "react";
import { daemonInvoke } from "../lib/daemon";
import {
  assertGitDiffMatches, createGitComment, diffIdentity, loadGitComments,
  MAX_COMMENT_LENGTH, MAX_COMMENTS, parseUnifiedDiff, saveGitComments, visiblePath,
  type GitComment, type GitContext, type GitDiff, type GitView, type GitWorkspace,
} from "../lib/gitWorkspace";
import { gitReviewContext } from "../lib/gitReview";
import type { ReviewChatContext } from "../lib/reviewChat";
import { GitDiffLines } from "./GitDiffLines";

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
}

export function GitFileReview({ sessionId, workspace, view, path, comments, onCommentsChange, onAsk, onDiscuss, load, continuous, onLoaded }: GitFileReviewProps) {
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [context, setContext] = useState<GitContext>("changes");
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [commentText, setCommentText] = useState("");
  const [commentError, setCommentError] = useState("");
  const [notice, setNotice] = useState("");
  const commentId = useId();
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setDiff(null);
    setSelected(new Set());
    setNotice("");
    void load(async () => {
      const result = await daemonInvoke<GitDiff>("git_diff", {
        sessionId, view, path,
        ...(context === "full" ? { context } : {}),
        ...(workspace.base && workspace.baseCommit ? { base: workspace.base } : {}),
      }, controller.signal);
      assertGitDiffMatches(result, workspace, view, path, context);
      return result;
    }, controller.signal).then((result) => {
      if (!controller.signal.aborted) setDiff(result);
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(String(cause));
    }).finally(() => {
      if (!controller.signal.aborted) { setLoading(false); onLoaded?.(path); }
    });
    return () => controller.abort();
  }, [sessionId, workspace, view, path, context, revision, load, onLoaded]);

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
  function storeComment() {
    if (!diff) return;
    try {
      const comment = createGitComment(diff, lines, selected, commentText);
      const latest = loadGitComments(localStorage);
      if (latest.length >= MAX_COMMENTS) throw new Error(`This client already has ${MAX_COMMENTS} Git comments. Remove older comments first.`);
      const next = [...latest, comment];
      saveGitComments(localStorage, next);
      onCommentsChange(next);
      setCommentText("");
      setCommentError("");
      setNotice("Comment saved in this browser only; nothing was posted or written to the repository.");
    } catch (cause) { setCommentError(String(cause)); }
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
  return <article className={`git-file-review${continuous ? " continuous" : ""}`} aria-label={`Diff for ${visiblePath(path)}`} data-diff-path={path}>
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
          <button type="button" disabled={!selected.size} onClick={() => setSelected(new Set())}>Clear selection</button>
          <button type="button" disabled={!canAsk} onClick={() => ask()}>Quick ask about {selected.size ? "selected lines" : "this diff"}</button>
          <button type="button" disabled={!canAsk} onClick={() => ask(undefined, true)}>Discuss {selected.size ? "selected lines" : "this diff"} in chat</button>
        </div>
        {selected.size > 40 && <p role="status" className="git-panel-warning">Select 40 or fewer code lines to save one note. Clear the selection or start a smaller range.</p>}
        <GitDiffLines lines={lines} selected={selected} onChange={setSelected} />
        <div className="git-panel-comment-editor">
          <label htmlFor={commentId}>Local review comment</label>
          <textarea id={commentId} value={commentText} maxLength={MAX_COMMENT_LENGTH}
            placeholder="Select or highlight code lines, then leave a local note..."
            onChange={(event) => setCommentText(event.target.value)} />
          <button type="button" disabled={!selected.size || !commentText.trim() || selected.size > 40} onClick={storeComment}>Save local comment</button>
          <small>{commentText.length}/{MAX_COMMENT_LENGTH} characters · up to 40 selected lines. Save notes across files, then use "Bring all notes into chat". Notes stay in this browser until explicitly attached.</small>
        </div>
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
    {commentError && <p role="alert" className="git-panel-error">Local comments: {commentError}</p>}
    {notice && <p role="status">{notice}</p>}
  </article>;
}
