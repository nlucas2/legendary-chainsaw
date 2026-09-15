import { useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, RefreshCw, X } from "lucide-react";
import { daemonInvoke } from "../lib/daemon";
import {
  createGitComment, diffIdentity, gitAskDraft, gitViewLabels, lineLocation,
  loadGitComments, MAX_COMMENT_LENGTH, MAX_COMMENTS, parseUnifiedDiff,
  saveGitComments, visiblePath, visibleBidi,
  type GitComment, type GitDiff, type GitView, type GitWorkspace,
} from "../lib/gitWorkspace";
import "./git-panel.css";

export interface GitPanelProps {
  sessionId: string;
  cwd: string;
  onClose: () => void;
  onAsk: (question: string) => void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function GitPanel(props: GitPanelProps) {
  // A CWD change is a different inspection scope, even within the same session.
  return <WorkspacePanel key={JSON.stringify([props.sessionId, props.cwd])} {...props} />;
}

function WorkspacePanel({ sessionId, cwd, onClose, onAsk }: GitPanelProps) {
  const [workspace, setWorkspace] = useState<GitWorkspace | null>(null);
  const [base, setBase] = useState("");
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState<GitView>("unstaged");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [error, setError] = useState("");
  const [diffError, setDiffError] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [commentText, setCommentText] = useState("");
  const [comments, setComments] = useState<GitComment[]>([]);
  const [commentError, setCommentError] = useState("");
  const [notice, setNotice] = useState("");
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);

  useEffect(() => {
    try { setComments(loadGitComments(localStorage)); }
    catch (error) { setCommentError(message(error)); }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError("");
    setWorkspace(null);
    setSelectedPath(null);
    setDiff(null);
    setDiffError("");
    setSelected(new Set());
    setNotice("");
    void daemonInvoke<GitWorkspace>("git_workspace", { sessionId, ...(base ? { base } : {}) }, controller.signal)
      .then((result) => { if (active) setWorkspace(result); })
      .catch((error) => { if (active && !controller.signal.aborted) setError(message(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [sessionId, cwd, base, revision]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setDiff(null);
    setDiffError("");
    setSelected(new Set());
    setNotice("");
    if (!selectedPath || !workspace) { setDiffLoading(false); return; }
    setDiffLoading(true);
    void daemonInvoke<GitDiff>("git_diff", {
      sessionId, view, path: selectedPath,
      ...(workspace.base && workspace.baseCommit ? { base: workspace.base } : {}),
    }, controller.signal)
      .then((result) => {
        if (!active) return;
        if (result.path !== selectedPath || result.view !== view || result.repoRoot !== workspace.repoRoot) {
          throw new Error("The Git response does not match this selection. Refresh before reviewing.");
        }
        if (view === "compare" && (result.baseCommit !== workspace.baseCommit ||
            result.mergeBase !== workspace.mergeBase || result.head !== workspace.head)) {
          throw new Error("The comparison target or HEAD changed after the file list loaded. Refresh the Git workspace before reviewing.");
        }
        setDiff(result);
      })
      .catch((error) => { if (active && !controller.signal.aborted) setDiffError(message(error)); })
      .finally(() => { if (active) setDiffLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [sessionId, selectedPath, view, workspace]);

  const files = workspace?.[view] ?? [];
  const lines = useMemo(() => parseUnifiedDiff(diff?.patch ?? ""), [diff]);
  const identity = diff ? diffIdentity(diff) : "";
  const currentComments = comments.filter((comment) => comment.identity === identity);
  const olderComments = diff ? comments.filter((comment) => {
    try {
      const parts = JSON.parse(comment.identity);
      return Array.isArray(parts) && parts[0] === diff.repoRoot && parts[1] === diff.path && comment.identity !== identity;
    } catch { return false; }
  }).length : 0;
  const canAsk = !!diff && !!diff.patch && !diffLoading && !loading;

  function changeView(next: GitView) {
    setSelectedPath(null);
    setDiff(null);
    setView(next);
    setCommentText("");
  }

  function storeComment() {
    if (!diff) return;
    try {
      const comment = createGitComment(diff, lines, selected, commentText);
      const latest = loadGitComments(localStorage);
      if (latest.length >= MAX_COMMENTS) throw new Error(`This client already has ${MAX_COMMENTS} Git comments. Remove older comments first.`);
      const next = [...latest, comment];
      saveGitComments(localStorage, next);
      setComments(next);
      setCommentText("");
      setCommentError("");
      setNotice("Comment saved in this browser only; nothing was posted or written to the repository.");
    } catch (error) { setCommentError(message(error)); }
  }

  function deleteComment(id: string) {
    try {
      const next = loadGitComments(localStorage).filter((comment) => comment.id !== id);
      saveGitComments(localStorage, next);
      setComments(next);
      setCommentError("");
    } catch (error) { setCommentError(message(error)); }
  }

  function ask(comment?: GitComment) {
    if (!diff || !canAsk) return;
    onAsk(gitAskDraft(diff, lines, selected, comment));
    setNotice("Review question opened as a draft. Nothing was sent.");
  }

  return (<>
    <div className="git-panel-backdrop" aria-hidden="true" />
    <section
      ref={panel} tabIndex={-1} className="git-panel" role="dialog" aria-label="Git workspace" aria-modal="true"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); onClose(); }
        if (event.key === "Tab" && panel.current) {
          const controls = Array.from(panel.current.querySelectorAll<HTMLElement>("button:not(:disabled), select:not(:disabled), textarea:not(:disabled), input:not(:disabled), summary, [tabindex='0']"))
            .filter((element) => element.getClientRects().length > 0);
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
          if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}
    >
      <header className="git-panel-header">
        <h2><GitBranch size={18} /> Git workspace <span>Read only</span></h2>
        <div className="git-panel-actions">
          <button type="button" onClick={() => setRevision((value) => value + 1)} disabled={loading} aria-label="Refresh Git workspace"><RefreshCw size={16} /> Refresh</button>
          <button type="button" onClick={onClose} aria-label="Close Git workspace"><X size={18} /></button>
        </div>
      </header>
      <p className="git-panel-cwd" title={cwd}>Session directory: {visiblePath(cwd)}</p>
      {loading && <p role="status">Inspecting local Git metadata…</p>}
      {error && <p role="alert" className="git-panel-error">{error}</p>}
      {workspace?.state === "noRepo" && <p className="git-panel-empty">This session is not in a Git working tree.</p>}
      {workspace?.warnings.map((warning, index) => <p className="git-panel-warning" key={index}>{warning}</p>)}
      {workspace?.state === "repository" && <>
        <div className="git-panel-metadata">
          <p><strong>{workspace.detached ? "Detached HEAD" : visiblePath(workspace.branch ?? "No branch")}</strong>
            {" · "}{workspace.unborn ? "Unborn branch (no commits)" : `HEAD ${workspace.head?.slice(0, 12) ?? "unavailable"}`}
            <br /><span title={workspace.repoRoot ?? ""}>{visiblePath(workspace.repoRoot ?? "")}</span>
          </p>
          <label>Comparison target
            <select aria-label="Comparison target" value={base} onChange={(event) => setBase(event.target.value)}>
              <option value="">{workspace.upstream ? `Upstream: ${visiblePath(workspace.upstream)}` : "Choose a local target (no upstream)"}</option>
              {workspace.refs.map((reference) => <option key={reference.name} value={reference.name}>{visiblePath(reference.name)}</option>)}
            </select>
          </label>
        </div>
        <p className="git-panel-explanation">
          Tracking upstream is a default, not necessarily your PR target. Select the intended target above.
          Only already-local refs are used; no fetch or GitHub request is made.
        </p>
        <nav className="git-panel-tabs" aria-label="Git change views">
          {(Object.keys(gitViewLabels) as GitView[]).map((tab) =>
            <button type="button" key={tab} aria-pressed={view === tab} onClick={() => changeView(tab)}>
              {gitViewLabels[tab]} <span>{workspace[tab].length}</span>
            </button>)}
        </nav>
        <p className="git-panel-view-description">
          {view === "compare" ? <>
            <strong>Committed changes only.</strong> merge-base(target, HEAD)..HEAD. Excludes staged, unstaged and untracked edits.
            {workspace.mergeBase && <> Merge base: <code>{workspace.mergeBase.slice(0, 12)}</code>.</>}
          </> : view === "staged" ? "Index vs HEAD — changes already staged. The panel cannot stage or commit."
            : view === "unstaged" ? "Working tree vs index — changes not yet staged."
              : "Untracked paths only. Their contents are not opened, avoiding symlink traversal and arbitrary file reads."}
        </p>
        {view === "compare" && workspace.compareUnavailableReason && <p className="git-panel-warning">{workspace.compareUnavailableReason}</p>}
        <div className="git-panel-content">
          <div className="git-panel-files" aria-label={`${gitViewLabels[view]} files`}>
            {!files.length && !(view === "compare" && workspace.compareUnavailableReason) && <p className="git-panel-empty">No files in this view.</p>}
            {files.map((file) =>
              <button type="button" className={`git-panel-file ${selectedPath === file.path ? "selected" : ""}`}
                key={file.path} title={visiblePath(file.path)} aria-pressed={selectedPath === file.path}
                onClick={() => { if (file.path !== selectedPath) setDiff(null); setSelectedPath(file.path); setCommentText(""); }}>
                <span className="git-panel-file-status">{file.status}</span>
                <span className="git-panel-file-path">
                  {file.originalPath && <small>{visiblePath(file.originalPath)} → </small>}{visiblePath(file.path)}
                  {file.kind !== "file" && <small> [{file.kind}]</small>}
                </span>
                <span className="git-panel-file-counts">{file.binary ? "binary" : <>
                  {file.added !== null && <span className="git-added">+{file.added}</span>}
                  {file.deleted !== null && <span className="git-deleted">−{file.deleted}</span>}
                </>}</span>
              </button>)}
          </div>
          <div className="git-panel-review">
            {!selectedPath && <p className="git-panel-empty">Select a file to load its bounded diff. Repository-wide patches are never loaded.</p>}
            {diffLoading && <p role="status">Loading selected file diff…</p>}
            {diffError && <p role="alert" className="git-panel-error">{diffError}</p>}
            {diff && <>
              <h3>{visiblePath(diff.path)} {diff.kind !== "file" && <small>({diff.kind})</small>}</h3>
              {diff.head !== workspace.head && <p className="git-panel-warning">HEAD changed since the file list was loaded. This preview uses HEAD {diff.head?.slice(0, 12)}; refresh the workspace.</p>}
              {diff.kind === "symlink" && <p className="git-panel-warning">Symlink: the patch shows link metadata/target text, not the target file's contents.</p>}
              {diff.unavailableReason && <p className="git-panel-warning">{diff.unavailableReason}</p>}
              {diff.warnings.map((warning, index) => <p className="git-panel-warning" key={index}>{warning}</p>)}
              {diff.truncated && <p className="git-panel-warning" role="status">Partial preview — this diff was truncated. Omitted code will not be included in the review draft.</p>}
              {diff.patch && <>
                <div className="git-panel-diff-actions">
                  <span>{selected.size} changed line{selected.size === 1 ? "" : "s"} selected</span>
                  <button type="button" disabled={!selected.size} onClick={() => setSelected(new Set())}>Clear selection</button>
                  <button type="button" disabled={!canAsk} onClick={() => ask()}>Ask about {selected.size ? "selected lines" : "this diff"}</button>
                </div>
                <div className="git-panel-diff" role="region" aria-label="Selected file unified diff" tabIndex={0}>
                  {lines.map((line) => {
                    const changed = line.kind === "add" || line.kind === "delete";
                    return <div key={line.index} className={`git-diff-line ${line.kind} ${selected.has(line.index) ? "selected" : ""}`}>
                      <span className="git-diff-select">{changed &&
                        <input type="checkbox" checked={selected.has(line.index)}
                          aria-label={`Select ${line.kind === "add" ? "added" : "deleted"} line ${lineLocation(line)}`}
                          onChange={() => setSelected((before) => {
                            const next = new Set(before);
                            if (next.has(line.index)) next.delete(line.index); else next.add(line.index);
                            return next;
                          })} />}</span>
                      <span className="git-diff-number" aria-hidden="true">{line.oldLine ?? ""}</span>
                      <span className="git-diff-number" aria-hidden="true">{line.newLine ?? ""}</span>
                      <code>{visibleBidi(line.text) || " "}</code>
                    </div>;
                  })}
                </div>
                <div className="git-panel-comment-editor">
                  <label htmlFor="git-review-comment">Local review comment</label>
                  <textarea id="git-review-comment" value={commentText} maxLength={MAX_COMMENT_LENGTH}
                    placeholder="Select changed lines, then leave a local note…"
                    onChange={(event) => setCommentText(event.target.value)} />
                  <button type="button" disabled={!selected.size || !commentText.trim() || selected.size > 40} onClick={storeComment}>Save local comment</button>
                  <small>{commentText.length}/{MAX_COMMENT_LENGTH} characters · up to 40 selected lines. Stored only in this browser, never posted to GitHub.</small>
                </div>
              </>}
              {olderComments > 0 && <p className="git-panel-warning">{olderComments} older comment(s) belong to a different view, base, HEAD or diff content and are not attached to these lines.</p>}
              {currentComments.length > 0 && <div className="git-panel-comments" aria-label="Local Git review comments">
                {currentComments.map((comment) => <article key={comment.id}>
                  <small>{comment.locations.map((line) => line.location).join(", ")}</small>
                  <p>{comment.body}</p>
                  <button type="button" disabled={!canAsk} onClick={() => ask(comment)}>Ask about comment</button>
                  <button type="button" onClick={() => deleteComment(comment.id)}>Remove local comment</button>
                </article>)}
              </div>}
            </>}
            {commentError && <p role="alert" className="git-panel-error">Local comments: {commentError}</p>}
            {notice && <p role="status">{notice}</p>}
          </div>
        </div>
      </>}
      {comments.length > 0 && <details className="git-panel-comment-store">
        <summary>Manage this browser's saved Git comments ({comments.length}/{MAX_COMMENTS})</summary>
        <p>Older comments stay stored but are not reattached when the view, base, HEAD or diff content changes.</p>
        {comments.map((comment) => <div key={comment.id}>
          <span>{comment.body.slice(0, 120)}{comment.body.length > 120 ? "…" : ""}</span>
          <button type="button" aria-label={`Delete saved comment ${comment.id}`} onClick={() => deleteComment(comment.id)}>Delete local note</button>
        </div>)}
      </details>}
      <footer>Read-only local inspection. No staging, commits, resets, pushes, ref changes or repository file writes. Submodule working-tree dirt is not scanned. Ask creates a draft; review it before sending.</footer>
    </section>
  </>);
}
