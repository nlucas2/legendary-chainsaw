import type { GitDiff, GitFile, GitWorkspace } from "./gitWorkspace";

function fileKey(file: GitFile): string {
  return JSON.stringify([file.path, file.originalPath, file.status, file.kind]);
}

function enrichCounts(changes: GitFile[], details: GitFile[]): GitFile[] {
  const matches = new Map(details.map((file) => [fileKey(file), file]));
  let changed = false;
  const result = changes.map((file) => {
    const full = matches.get(fileKey(file));
    if (!full || (file.added === full.added && file.deleted === full.deleted && file.binary === full.binary)) return file;
    changed = true;
    return { ...file, added: full.added, deleted: full.deleted, binary: full.binary };
  });
  return changed ? result : changes;
}

export function mergeGitWorkspaceDetails(changes: GitWorkspace, details: GitWorkspace): GitWorkspace {
  if (changes.state !== "repository" || details.state !== "repository"
    || changes.repoRoot !== details.repoRoot || changes.head !== details.head || changes.branch !== details.branch) {
    throw new Error("The repository changed while comparison metadata was loading. Refresh the Git workspace.");
  }
  if (details.detailsLoaded === false) throw new Error("Git comparison metadata is still incomplete.");
  const views = ["staged", "unstaged", "untracked"] as const;
  const pathsChanged = details.changesLoaded !== false && views.some((view) => {
    const keys = new Set(changes[view].map(fileKey));
    return keys.size !== details[view].length || details[view].some((file) => !keys.has(fileKey(file)));
  });
  return {
    ...details,
    detailsLoaded: true,
    changesLoaded: changes.changesLoaded ?? true,
    staged: details.changesLoaded === false ? changes.staged : enrichCounts(changes.staged, details.staged),
    unstaged: details.changesLoaded === false ? changes.unstaged : enrichCounts(changes.unstaged, details.unstaged),
    untracked: details.changesLoaded === false ? changes.untracked : enrichCounts(changes.untracked, details.untracked),
    warnings: [...new Set([...changes.warnings, ...details.warnings,
      ...(pathsChanged ? ["Working changes moved while comparison metadata loaded. Refresh to update the file list."] : [])])],
  };
}

export function applyGitPreviewCounts(workspace: GitWorkspace, diff: GitDiff): GitWorkspace {
  if (workspace.repoRoot !== diff.repoRoot || workspace.head !== diff.head
    || (diff.view === "compare" && (workspace.baseCommit !== diff.baseCommit || workspace.mergeBase !== diff.mergeBase))) {
    return workspace;
  }
  let changed = false;
  const files = workspace[diff.view].map((file) => {
    if (file.path !== diff.path || file.originalPath !== diff.originalPath
      || (file.added === diff.added && file.deleted === diff.deleted && file.binary === diff.binary)) return file;
    changed = true;
    return { ...file, added: diff.added, deleted: diff.deleted, binary: diff.binary };
  });
  return changed ? { ...workspace, [diff.view]: files } : workspace;
}

const snapshots = new Map<string, GitWorkspace>();
export function gitWorkspaceCacheKey(sessionId: string, cwd: string, base: string): string {
  return JSON.stringify([sessionId, cwd, base]);
}
export function cachedGitWorkspace(key: string): GitWorkspace | null {
  return snapshots.get(key) ?? null;
}
export function cacheGitWorkspace(key: string, workspace: GitWorkspace): void {
  snapshots.delete(key);
  snapshots.set(key, workspace);
  while (snapshots.size > 12) snapshots.delete(snapshots.keys().next().value!);
}
