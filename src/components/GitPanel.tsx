import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpToLine, ChevronLeft, ChevronRight, GitBranch, RefreshCw, X } from "lucide-react";
import { daemonInvoke } from "../lib/daemon";
import {
  comparisonTargetGroups, gitFilesForView, gitViewLabels, loadGitComments, MAX_COMMENTS, GIT_COMMENTS_KEY, normalizeGitReferences, saveGitComments, visiblePath,
  type GitComment, type GitDiff, type GitReferences, type GitView, type GitWorkspace,
} from "../lib/gitWorkspace";
import { createGitDiffLoader } from "../lib/gitDiffLoader";
import { addGitWorkingPath, GIT_WORKING_PATHS_KEY, loadGitWorkingPaths, saveGitWorkingPaths,
  validateGitWorkingPath, type GitWorkingPaths } from "../lib/gitWorkingPaths";
import { applyGitPreviewCounts, cachedGitWorkspace, cacheGitWorkspace, gitWorkspaceCacheKey, mergeGitWorkspaceDetails } from "../lib/gitWorkspaceLoading";
import { GitFileReview } from "./GitFileReview";
import { GitDiffFeed, type GitDiffNavigation } from "./GitDiffFeed";
import { GitReviewNotes } from "./GitReviewNotes";
import type { ReviewChatContext } from "../lib/reviewChat";
import "./git-panel.css";

export interface GitPanelProps {
  sessionId: string;
  cwd: string;
  onClose: () => void;
  onAsk: (question: string, context?: ReviewChatContext) => void;
  onDiscuss: (context: ReviewChatContext) => void;
}

export function GitPanel(props: GitPanelProps) {
  const opener = useRef(document.activeElement);
  useEffect(() => () => {
    const previous = opener.current;
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
  }, []);
  return <WorkingPathsPanel key={props.sessionId} {...props} />;
}

function WorkingPathsPanel(props: GitPanelProps) {
  const [initial] = useState((): { config: GitWorkingPaths; error: string } => {
    try { return { config: loadGitWorkingPaths(localStorage, props.sessionId), error: "" }; }
    catch (cause) { return { config: { paths: [], selectedPath: null }, error: String(cause) }; }
  });
  const [config, setConfig] = useState(initial.config);
  const configRef = useRef(initial.config);
  const [pathError, setPathError] = useState(initial.error);
  const [unreadable, setUnreadable] = useState(!!initial.error);
  const [adding, setAdding] = useState(false);
  const [draftStore] = useState(() => new Map<string, string>());
  const check = useRef<AbortController | null>(null);
  const focusPath = useRef(false);
  useEffect(() => () => check.current?.abort(), []);
  useEffect(() => {
    if (!focusPath.current) return;
    focusPath.current = false;
    document.querySelector<HTMLSelectElement>('[role="dialog"][aria-label="Git workspace"] [aria-label="Git working path"]')
      ?.focus({ preventScroll: true });
  }, [config.selectedPath]);
  function reloadPaths() {
    try {
      const next = loadGitWorkingPaths(localStorage, props.sessionId);
      configRef.current = next;
      setConfig(next);
      setPathError(""); setUnreadable(false);
    } catch (cause) { setPathError(String(cause)); setUnreadable(true); }
  }
  useEffect(() => {
    const read = (event: StorageEvent) => {
      if (event.key === null || event.key === GIT_WORKING_PATHS_KEY + props.sessionId) reloadPaths();
    };
    window.addEventListener("storage", read);
    return () => window.removeEventListener("storage", read);
  }, [props.sessionId]);
  function changePaths(next: GitWorkingPaths) {
    if (unreadable) return;
    configRef.current = next;
    setConfig(next);
    try { saveGitWorkingPaths(localStorage, props.sessionId, next); setPathError(""); }
    catch (cause) { setPathError(`Working paths changed in this window but could not be saved: ${String(cause)}`); }
  }
  async function addPath(value: string): Promise<boolean> {
    if (check.current || adding || unreadable) return false;
    const controller = new AbortController();
    check.current = controller;
    setAdding(true); setPathError("");
    try {
      const path = validateGitWorkingPath(value);
      addGitWorkingPath(configRef.current, path);
      const result = await daemonInvoke<{ isRepository: boolean }>("git_repository", {
        sessionId: props.sessionId, workingPath: path,
      }, controller.signal);
      if (typeof result.isRepository !== "boolean") throw new Error("Git discovery returned no repository status.");
      if (!result.isRepository) throw new Error("This working directory is not in a Git working tree.");
      if (controller.signal.aborted) return false;
      const next = addGitWorkingPath(configRef.current, path);
      focusPath.current = next.selectedPath !== configRef.current.selectedPath;
      changePaths(next);
      return true;
    } catch (cause) {
      if (!controller.signal.aborted) setPathError(String(cause));
      return false;
    } finally {
      if (check.current === controller) check.current = null;
      if (!controller.signal.aborted) setAdding(false);
    }
  }
  const effectivePath = config.selectedPath ?? props.cwd;
  return <WorkspacePanel key={JSON.stringify([props.sessionId, effectivePath])} {...props}
    draftStore={draftStore}
    workingPath={config.selectedPath} workingPaths={config.paths} pathsError={pathError}
    pathsUnreadable={unreadable} addingPath={adding} onReloadPaths={reloadPaths}
    onWorkingPathChange={(selectedPath) => {
      if (selectedPath !== null && !configRef.current.paths.includes(selectedPath)) {
        setPathError("That working path was removed in another window. Choose another directory.");
        return;
      }
      focusPath.current = selectedPath !== configRef.current.selectedPath;
      changePaths({ ...configRef.current, selectedPath });
    }}
    onAddPath={addPath} onRemovePath={() => changePaths({
      paths: configRef.current.paths.filter((path) => path !== config.selectedPath),
      selectedPath: configRef.current.selectedPath === config.selectedPath ? null : configRef.current.selectedPath,
    })} />;
}

function useCompactGit() {
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return compact;
}

function shortRef(name: string) {
  return visiblePath(name.replace(/^refs\/(?:heads|remotes)\//, ""));
}

function mobileFileLabel(path: string) {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? visiblePath(path)
    : `${visiblePath(path.slice(separator + 1))} — ${visiblePath(path.slice(0, separator))}`;
}

interface WorkspacePanelProps extends GitPanelProps {
  draftStore: Map<string, string>;
  workingPath: string | null;
  workingPaths: string[];
  pathsError: string;
  pathsUnreadable: boolean;
  addingPath: boolean;
  onReloadPaths: () => void;
  onWorkingPathChange: (path: string | null) => void;
  onAddPath: (path: string) => Promise<boolean>;
  onRemovePath: () => void;
}

function WorkspacePanel({ sessionId, cwd, onClose, onAsk, onDiscuss, workingPath, workingPaths,
  pathsError, pathsUnreadable, addingPath, onReloadPaths, onWorkingPathChange, onAddPath, onRemovePath, draftStore }: WorkspacePanelProps) {
  const compact = useCompactGit();
  const selectedCwd = workingPath ?? cwd;
  const [workspace, setWorkspace] = useState<GitWorkspace | null>(() => cachedGitWorkspace(gitWorkspaceCacheKey(sessionId, selectedCwd, "")));
  const [base, setBase] = useState("");
  const [refQuery, setRefQuery] = useState("");
  const [refResults, setRefResults] = useState<GitReferences | null>(null);
  const [refLoading, setRefLoading] = useState(false);
  const [refError, setRefError] = useState("");
  const [refRevision, setRefRevision] = useState(0);
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState<GitView>("unstaged");
  const [layout, setLayout] = useState<"file" | "continuous">("file");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [navigation, setNavigation] = useState<GitDiffNavigation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState("");
  const [detailsRevision, setDetailsRevision] = useState(0);
  const [newWorkingPath, setNewWorkingPath] = useState("");
  const [comments, setComments] = useState<GitComment[]>([]);
  const [commentError, setCommentError] = useState("");
  const [loadDiff] = useState(() => createGitDiffLoader<GitDiff>());
  const panel = useRef<HTMLElement>(null);
  const header = useRef<HTMLElement>(null);
  const fileList = useRef<HTMLDivElement>(null);
  const options = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    panel.current?.focus();
  }, []);
  useEffect(() => {
    const element = panel.current;
    if (!element || !header.current) return;
    const resize = new ResizeObserver(() => {
      element.style.setProperty("--git-header-height", `${header.current?.offsetHeight ?? 0}px`);
    });
    resize.observe(header.current);
    return () => resize.disconnect();
  }, []);
  useEffect(() => {
    const read = () => {
      try { setComments(loadGitComments(localStorage)); setCommentError(""); }
      catch (cause) { setCommentError(String(cause)); }
    };
    const onStorage = (event: StorageEvent) => { if (event.key === null || event.key === GIT_COMMENTS_KEY) read(); };
    read();
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setDetailsError("");
    const key = gitWorkspaceCacheKey(sessionId, selectedCwd, base);
    setWorkspace(cachedGitWorkspace(key));
    setSelectedPath(null);
    setNavigation(null);
    void daemonInvoke<GitWorkspace>("git_workspace", {
      sessionId, scope: "changes", ...(workingPath ? { workingPath } : {}), ...(base ? { base } : {}),
    }, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) { cacheGitWorkspace(key, result); setWorkspace(result); }
      })
      .catch((cause) => { if (!controller.signal.aborted) setError(String(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [sessionId, selectedCwd, workingPath, base, revision]);
  useEffect(() => {
    if (loading || workspace?.state !== "repository" || workspace.detailsLoaded !== false) {
      setDetailsLoading(false);
      return;
    }
    const changes = workspace;
    const controller = new AbortController();
    const key = gitWorkspaceCacheKey(sessionId, selectedCwd, base);
    setDetailsLoading(true); setDetailsError("");
    void daemonInvoke<GitWorkspace>("git_workspace", {
      sessionId, scope: "details", ...(workingPath ? { workingPath } : {}), ...(base ? { base } : {}),
    }, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      const merged = mergeGitWorkspaceDetails(changes, result);
      cacheGitWorkspace(key, merged);
      setWorkspace((current) => {
        if (!current || current.state !== "repository" || current.repoRoot !== changes.repoRoot
          || current.head !== changes.head || current.branch !== changes.branch) return current;
        return mergeGitWorkspaceDetails(current, result);
      });
    }).catch((cause) => {
      if (!controller.signal.aborted) setDetailsError(String(cause));
    }).finally(() => { if (!controller.signal.aborted) setDetailsLoading(false); });
    return () => controller.abort();
  }, [sessionId, selectedCwd, workingPath, base, revision, detailsRevision, loading,
    workspace?.state, workspace?.detailsLoaded, workspace?.repoRoot, workspace?.head, workspace?.branch]);
  useEffect(() => {
    setRefResults(null); setRefError("");
    if (!refQuery.trim() || !workspace?.refsHasMore) { setRefLoading(false); return; }
    const controller = new AbortController();
    setRefLoading(true);
    const timer = setTimeout(() => {
      void daemonInvoke<unknown>("git_refs", { sessionId, query: refQuery.trim(), ...(workingPath ? { workingPath } : {}) }, controller.signal)
        .then((value) => { if (!controller.signal.aborted) setRefResults(normalizeGitReferences(value)); })
        .catch((cause) => { if (!controller.signal.aborted) setRefError(String(cause)); })
        .finally(() => { if (!controller.signal.aborted) setRefLoading(false); });
    }, 250);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [sessionId, selectedCwd, workingPath, refQuery, workspace?.refsHasMore, revision, refRevision]);

  const fileViews = useMemo(() => ({
    staged: gitFilesForView(workspace, "staged"),
    unstaged: gitFilesForView(workspace, "unstaged"),
    compare: gitFilesForView(workspace, "compare"),
    untracked: gitFilesForView(workspace, "untracked"),
  }), [workspace]);
  const files = fileViews[view];
  const targets = useMemo(() => {
    const query = refQuery.trim().toLowerCase();
    const refs = query
      ? workspace?.refsHasMore ? refResults?.refs ?? [] : workspace?.refs.filter((reference) => reference.name.toLowerCase().includes(query)) ?? []
      : workspace?.refs ?? [];
    const chosen = workspace?.refs.find((ref) => ref.name === base);
    return comparisonTargetGroups(chosen && !refs.some((ref) => ref.name === chosen.name) ? [chosen, ...refs] : refs,
      workspace?.upstream ?? null);
  }, [workspace, refQuery, refResults, base]);
  const selectedIndex = files.findIndex((file) => file.path === selectedPath);
  const selectedFile = files[selectedIndex];
  const onActivePathChange = useCallback((path: string) => setSelectedPath(path), []);
  const onDiffLoaded = useCallback((diff: GitDiff) => {
    setWorkspace((current) => current ? applyGitPreviewCounts(current, diff) : current);
  }, []);
  useEffect(() => {
    if (compact || layout !== "continuous" || !fileList.current) return;
    const current = fileList.current.querySelector<HTMLElement>("[aria-current='location']");
    if (!current) return;
    const listBox = fileList.current.getBoundingClientRect();
    const currentBox = current.getBoundingClientRect();
    if (currentBox.top < listBox.top) fileList.current.scrollTop += currentBox.top - listBox.top;
    else if (currentBox.bottom > listBox.bottom) fileList.current.scrollTop += currentBox.bottom - listBox.bottom;
  }, [selectedPath, layout, compact]);
  function selectFile(path: string) {
    setSelectedPath(path);
    if (layout === "continuous") setNavigation((previous) => ({ path, sequence: (previous?.sequence ?? 0) + 1 }));
    else if (compact) panel.current?.scrollTo({ top: 0 });
  }
  function changeView(next: GitView) {
    setSelectedPath(null);
    setNavigation(null);
    setView(next);
    if (compact) panel.current?.scrollTo({ top: 0 });
  }
  function changeLayout(next: "file" | "continuous") {
    setNavigation(null);
    setLayout(next);
    panel.current?.scrollTo({ top: 0 });
  }
  function backToTop() {
    setNavigation(null);
    panel.current?.scrollTo({ top: 0, behavior: "instant" });
  }
  function deleteComment(id: string) {
    try {
      const next = loadGitComments(localStorage).filter((comment) => comment.id !== id);
      saveGitComments(localStorage, next);
      setComments(next);
      setCommentError("");
    } catch (cause) { setCommentError(String(cause)); }
  }
  const reviewProps = workspace ? { sessionId, workspace, view, comments, draftStore, onCommentsChange: setComments, onAsk, onDiscuss, onDiffLoaded, load: loadDiff } : null;
  const comparisonControls = workspace?.state === "repository" && <>
    <div className="git-ref-search">
      <label>Search comparison refs<input aria-label="Search comparison refs" value={refQuery} maxLength={256}
        disabled={loading || workspace.detailsLoaded === false}
        onChange={(event) => setRefQuery(event.target.value)} placeholder="Branch or remote name" /></label>
      <small>{workspace.detailsLoaded === false ? detailsError ? "Comparison refs are unavailable; retry metadata loading." : "Loading local comparison refs. Working changes are already available."
        : !workspace.refsHasMore ? "Filter the available local branch and remote-tracking refs."
        : !refQuery.trim() ? "Showing a bounded set of suggestions. Search any locally available branch or remote-tracking ref."
        : refLoading ? "Searching local refs..." : refResults
          ? `${refResults.refs.length} matches${refResults.hasMore ? " shown; narrow the search for more specific results" : ""}.`
          : refError ? "Ref search unavailable." : "Searching local refs..."}</small>
      {refError && <p role="alert" className="git-panel-error">{refError} <button type="button" onClick={() => setRefRevision((value) => value + 1)}>Retry ref search</button></p>}
      {refResults?.warnings.map((warning, index) => <p className="git-panel-warning" key={index}>{warning}</p>)}
    </div>
    <div className="git-panel-metadata">
      <p><strong>{workspace.detached ? "Detached HEAD" : visiblePath(workspace.branch ?? "No branch")}</strong>
        {" · "}{workspace.unborn ? "Unborn branch (no commits)" : `HEAD ${workspace.head?.slice(0, 12) ?? "unavailable"}`}
        <br /><span title={visiblePath(workspace.repoRoot ?? "")}>{visiblePath(workspace.repoRoot ?? "")}</span>
      </p>
      <label>Comparison target
        <select aria-label="Comparison target" value={base} disabled={refLoading || loading || workspace.detailsLoaded === false} onChange={(event) => {
          setBase(event.target.value);
          if (compact && options.current) options.current.open = false;
        }}>
          <option value="">{workspace.detailsLoaded === false ? detailsError ? "Comparison targets unavailable" : "Loading comparison targets..."
            : workspace.upstream ? `Upstream: ${compact ? shortRef(workspace.upstream) : visiblePath(workspace.upstream)}` : "Choose a local target (no upstream)"}</option>
          {base && workspace.detailsLoaded === false && !workspace.refs.some((reference) => reference.name === base)
            && <option value={base}>{shortRef(base)} (loading...)</option>}
          {targets.suggested.length > 0 && <optgroup label="Likely PR targets">
            {targets.suggested.map((reference) => <option key={reference.name} value={reference.name}>
              {compact ? shortRef(reference.name) : visiblePath(reference.name)}{reference.name.endsWith("/HEAD") ? " (remote default)" : ""}
            </option>)}
          </optgroup>}
          {targets.other.length > 0 && <optgroup label="Other local refs">
            {targets.other.map((reference) => <option key={reference.name} value={reference.name}>{compact ? shortRef(reference.name) : visiblePath(reference.name)}</option>)}
          </optgroup>}
        </select>
      </label>
    </div>
    <p className="git-panel-explanation">Tracking upstream is a default, not necessarily your PR target. Main branches and remote defaults are listed first. Only already-local refs are used; no fetch or GitHub request is made.</p>
  </>;
  const workingPathControls = <>
    <div className="git-working-paths">
      <label>Working path<select aria-label="Git working path" value={workingPath ?? ""} disabled={addingPath || pathsUnreadable}
        onChange={(event) => onWorkingPathChange(event.target.value || null)}>
        <option value="">Session directory — {visiblePath(cwd)}</option>
        {workingPaths.map((path) => <option key={path} value={path}>{visiblePath(path)}</option>)}
      </select></label>
      {workingPath && <button type="button" disabled={addingPath || pathsUnreadable} onClick={onRemovePath}
        title="Remove this path from the Git list only; no files are deleted." aria-label="Remove Git working path">Remove path</button>}
      <details className="git-add-working-path">
        <summary>Add working path</summary>
        <form onSubmit={(event) => {
          event.preventDefault();
          void onAddPath(newWorkingPath).then((added) => { if (added) setNewWorkingPath(""); });
        }}>
          <label>Directory on daemon<input aria-label="Working directory to add" value={newWorkingPath} maxLength={4096}
            disabled={addingPath || pathsUnreadable} placeholder="Q:\another-repo"
            onChange={(event) => setNewWorkingPath(event.target.value)} /></label>
          <button type="submit" disabled={addingPath || pathsUnreadable || !newWorkingPath.trim()}>{addingPath ? "Checking path..." : "Add path"}</button>
          <small>Inspect another repository without changing the session or terminal directory. Saved for this session in this browser.</small>
        </form>
      </details>
    </div>
    {pathsError && <p role="alert" className="git-panel-error">{pathsError}
      {pathsUnreadable && <button type="button" onClick={onReloadPaths}>Reload working paths</button>}</p>}
  </>;
  return <>
    <div className="git-panel-backdrop" aria-hidden="true" />
    <section ref={panel} tabIndex={-1} className="git-panel" role="dialog" aria-label="Git workspace" aria-modal="true"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); onClose(); }
        if (event.key === "Tab" && panel.current) {
          const controls = Array.from(panel.current.querySelectorAll<HTMLElement>("button:not(:disabled), select:not(:disabled), textarea:not(:disabled), input:not(:disabled), summary, [tabindex='0']"))
            .filter((element) => element.getClientRects().length > 0);
          const first = controls[0], last = controls[controls.length - 1];
          if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
          if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <header ref={header} className="git-panel-header">
        <div className="git-panel-title-row">
          <h2><GitBranch size={18} /><span className="git-panel-title">Git workspace</span><span className="git-read-only">Read only</span></h2>
          <div className="git-panel-actions">
            <button type="button" onClick={backToTop} aria-label="Back to top" title="Back to top"><ArrowUpToLine size={16} /><span className="git-top-label">Top</span></button>
            <button type="button" onClick={() => setRevision((value) => value + 1)} disabled={loading} aria-label="Refresh Git workspace" title="Refresh Git workspace"><RefreshCw size={16} /><span className="git-refresh-label">Refresh</span></button>
            <button type="button" onClick={onClose} aria-label="Close Git workspace"><X size={18} /></button>
          </div>
        </div>
        {workingPathControls}
        {compact && workspace?.state === "repository" && <div className="git-mobile-toolbar">
          <div className="git-mobile-view-controls">
            <label>Changes<select aria-label="Git change view" value={view} onChange={(event) => changeView(event.target.value as GitView)}>
              {(Object.keys(gitViewLabels) as GitView[]).map((tab) => <option key={tab} value={tab}
                disabled={tab === "compare" && workspace.detailsLoaded === false}>
                {gitViewLabels[tab]} ({tab === "compare" && workspace.detailsLoaded === false ? "…" : fileViews[tab].length})</option>)}
            </select></label>
            <label>View<select aria-label="Diff layout" value={layout} onChange={(event) => {
              changeLayout(event.target.value as "file" | "continuous");
            }}>
              <option value="file">One file</option><option value="continuous">Continuous diffs</option>
            </select></label>
          </div>
          {files.length > 0 && <div className="git-mobile-file-controls">
            <label>File{selectedIndex >= 0 ? ` ${selectedIndex + 1} of ${files.length}` : ` (${files.length})`}
              <select aria-label="Choose file" title={selectedPath ? visiblePath(selectedPath) : undefined}
                value={selectedPath ?? ""} onChange={(event) => selectFile(event.target.value)}>
                <option value="" disabled>{layout === "continuous" ? "Jump to a file..." : "Select a file..."}</option>
                {files.map((file) => <option key={file.path} value={file.path}>{mobileFileLabel(file.path)}{file.view === "untracked" ? " (untracked)" : ""}</option>)}
              </select>
            </label>
            <button type="button" aria-label="Previous file" disabled={selectedIndex <= 0} onClick={() => selectFile(files[selectedIndex - 1].path)}><ChevronLeft size={18} /></button>
            <button type="button" aria-label="Next file" disabled={selectedIndex < 0 || selectedIndex >= files.length - 1} onClick={() => selectFile(files[selectedIndex + 1].path)}><ChevronRight size={18} /></button>
          </div>}
          <details ref={options} className="git-mobile-options">
            <summary>Comparison &amp; repository <span title={workspace.base ? visiblePath(workspace.base) : undefined}>
              {workspace.base ? shortRef(workspace.base) : "No target"}
            </span></summary>
            <div className="git-mobile-options-body">
              <p className="git-panel-cwd">Working directory: {visiblePath(selectedCwd)}</p>
              {comparisonControls}
            </div>
          </details>
        </div>}
      </header>
      <div className="git-panel-body">
      {!compact && <p className="git-panel-cwd" title={visiblePath(selectedCwd)}>
        {workingPath ? "Working directory" : "Session directory"}: {visiblePath(selectedCwd)}</p>}
      {workspace?.state === "repository" ? <p className="git-workspace-status" role="status">
        {error ? "Last snapshot; the local refresh failed."
          : loading ? "Refreshing local changes; showing the last snapshot..."
          : detailsError ? "Local changes are ready; comparison metadata is unavailable."
          : detailsLoading || workspace.detailsLoaded === false ? "Local changes are ready. Loading comparison metadata in the background..."
          : "Local changes and comparison metadata are ready."}
      </p> : loading && <p role="status">Inspecting local changes...</p>}
      {error && <p role="alert" className="git-panel-error">{error}</p>}
      {detailsError && <p role="alert" className="git-panel-error">Comparison metadata: {detailsError}
        {" "}<button type="button" onClick={() => setDetailsRevision((value) => value + 1)}>Retry comparison metadata</button>
        {base && <button type="button" onClick={() => setBase("")}>Use default comparison target</button>}</p>}
      {workspace?.state === "noRepo" && <p className="git-panel-empty">{workingPath ? "This working path is not in a Git working tree." : "This session is not in a Git working tree."}</p>}
      {workspace?.warnings.map((warning, index) => <p className="git-panel-warning" key={index}>{warning}</p>)}
      {workspace?.state === "repository" && <>
        <GitReviewNotes workspace={workspace} comments={comments} onCommentsChange={setComments}
          onDelete={deleteComment} onAsk={onAsk} onDiscuss={onDiscuss} />
        {!compact && <>
        {comparisonControls}
        <nav className="git-panel-tabs" aria-label="Git change views">
          {(Object.keys(gitViewLabels) as GitView[]).map((tab) => <button type="button" key={tab} aria-pressed={view === tab}
            disabled={tab === "compare" && workspace.detailsLoaded === false} onClick={() => changeView(tab)}>
            {gitViewLabels[tab]} <span>{tab === "compare" && workspace.detailsLoaded === false ? "…" : fileViews[tab].length}</span>
          </button>)}
        </nav>
        <div className="git-layout-switch" role="group" aria-label="Diff layout">
          <button type="button" aria-pressed={layout === "file"} onClick={() => changeLayout("file")}>One file</button>
          <button type="button" aria-pressed={layout === "continuous"} onClick={() => changeLayout("continuous")}>Continuous diffs</button>
          <span>{layout === "continuous" ? "More files load as you scroll. The file list follows your position; select a filename to jump to its diff." : "Select a file to review."}</span>
        </div>
        </>}
        <p className="git-panel-view-description">
          {view === "compare" ? <><strong>Committed changes only.</strong> merge-base(target, HEAD)..HEAD. Excludes staged, unstaged and untracked edits.
            {workspace.mergeBase && <> Merge base: <code>{workspace.mergeBase.slice(0, 12)}</code>.</>}
          </> : view === "staged" ? "Index vs HEAD — changes already staged. The panel cannot stage or commit."
            : view === "unstaged" ? "Working tree changes not yet staged, including new untracked files. Tracked edits compare against the index; untracked text is shown as additions."
              : "New, untracked files only. Regular text files can be previewed as additions; unsafe paths and unsupported contents remain unavailable."}
        </p>
        {view === "compare" && workspace.detailsLoaded !== false && workspace.compareUnavailableReason
          && <p className="git-panel-warning">{workspace.compareUnavailableReason}</p>}
        <div className={`git-panel-content${layout === "continuous" ? " continuous" : ""}`}>
          <div ref={fileList} className="git-panel-files" hidden={compact && (layout === "continuous" || selectedPath !== null)} aria-label={`${gitViewLabels[view]} files`}>
            {!files.length && (view === "compare" && workspace.detailsLoaded === false
              ? <p className="git-panel-empty" role="status">{detailsError ? "Comparison changes are unavailable until metadata is reloaded." : "Loading committed comparison changes..."}</p>
              : !(view === "compare" && workspace.compareUnavailableReason) && <p className="git-panel-empty">No files in this view.</p>)}
            {files.map((file) => <button type="button" className={`git-panel-file ${selectedPath === file.path ? "selected" : ""}`}
              key={file.path} title={visiblePath(file.path)} aria-pressed={selectedPath === file.path}
              aria-current={layout === "continuous" && selectedPath === file.path ? "location" : undefined}
              onClick={() => selectFile(file.path)}>
              <span className="git-panel-file-status">{file.status}</span>
              <span className="git-panel-file-path">{file.originalPath && <small>{visiblePath(file.originalPath)} → </small>}{visiblePath(file.path)}
                {file.view === "untracked" && <small> [untracked]</small>}
                {file.kind !== "file" && file.kind !== "untracked" && <small> [{file.kind}]</small>}
              </span>
              <span className="git-panel-file-counts">{file.binary ? "binary" : <>
                {file.view === "untracked" && file.added === null && <span className="git-added">new</span>}
                {file.added !== null && <span className="git-added">+{file.added}</span>}
                {file.deleted !== null && <span className="git-deleted">−{file.deleted}</span>}
              </>}</span>
            </button>)}
          </div>
          <div className="git-panel-review">
            {reviewProps && (layout === "continuous"
              ? <GitDiffFeed key={`${view}:${base}:${revision}`} {...reviewProps} files={files} scrollRoot={panel.current}
                navigation={navigation} onActivePathChange={onActivePathChange} />
              : selectedFile ? <GitFileReview key={`${selectedFile.view}:${selectedFile.path}`} {...reviewProps} view={selectedFile.view} path={selectedFile.path} />
                : !compact && files.length > 0 ? <p className="git-panel-empty">Select a file to load its bounded diff. Repository-wide patches are never loaded.</p> : null)}
            {compact && layout === "continuous" && !files.length && <p className="git-panel-empty">No files in this view.</p>}
          </div>
        </div>
      </>}
      {commentError && <p role="alert" className="git-panel-error">Local comments: {commentError}</p>}
      {comments.length > 0 && <details className="git-panel-comment-store">
        <summary>Manage this browser's saved Git comments ({comments.length}/{MAX_COMMENTS})</summary>
        <p>Older comments stay stored but are not reattached when the view, base, HEAD or diff content changes.</p>
        {comments.map((comment) => <div key={comment.id}>
          <span>{comment.body.slice(0, 120)}{comment.body.length > 120 ? "..." : ""}</span>
          <button type="button" aria-label={`Delete saved comment ${comment.id}`} onClick={() => deleteComment(comment.id)}>Delete local note</button>
        </div>)}
      </details>}
      <footer>Read-only local inspection. No staging, commits, resets, pushes, ref changes or repository file writes. Submodule working-tree dirt is not scanned. Quick ask is transient; Discuss in chat prepares a normal message with a saved context attachment. Nothing is sent automatically.</footer>
      </div>
    </section>
  </>;
}
