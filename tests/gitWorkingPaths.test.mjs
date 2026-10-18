import test from "node:test";
import assert from "node:assert/strict";
import { addGitWorkingPath, GIT_WORKING_PATHS_KEY, gitWorkingPathIdentity, loadGitWorkingPaths,
  MAX_GIT_WORKING_PATHS, saveGitWorkingPaths, validateGitWorkingPath } from "../src/lib/gitWorkingPaths.ts";
import { applyGitPreviewCounts, mergeGitWorkspaceDetails, cacheGitWorkspace, cachedGitWorkspace, gitWorkspaceCacheKey } from "../src/lib/gitWorkspaceLoading.ts";

const storage = () => {
  const values = new Map();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};
test("working paths are per-session and defaults follow the session directory", () => {
  const saved = storage();
  const first = addGitWorkingPath(loadGitWorkingPaths(saved, "a"), "Q:\\other-repo");
  saveGitWorkingPaths(saved, "a", first);
  assert.deepEqual(loadGitWorkingPaths(saved, "a"), { paths: ["Q:\\other-repo"], selectedPath: "Q:\\other-repo" });
  assert.deepEqual(loadGitWorkingPaths(saved, "b"), { paths: [], selectedPath: null });
  assert.equal(addGitWorkingPath(first, "Q:\\first").selectedPath, "Q:\\first");
  assert.deepEqual(addGitWorkingPath(first, "q:/OTHER-repo/"), first);
  assert.equal(gitWorkingPathIdentity("/Repo"), "/Repo");
  assert.notEqual(gitWorkingPathIdentity("/Repo"), gitWorkingPathIdentity("/repo"));
  assert.equal(validateGitWorkingPath("\\\\host\\share\\repo"), "\\\\host\\share\\repo");
});
test("invalid paths, corrupt state and storage failures never overwrite existing data", () => {
  for (const path of ["", "repo", "Q:repo", "Q:\\repo\0other", "\n", "x".repeat(4097)]) {
    assert.throws(() => validateGitWorkingPath(path));
  }
  const saved = storage();
  for (const invalid of ["not json", '{"version":2,"paths":[],"selectedPath":null}',
    '{"version":1,"paths":["Q:\\\\repo"],"selectedPath":"Q:\\\\other"}',
    '{"version":1,"paths":["Q:\\\\repo","q:/REPO"],"selectedPath":null}']) {
    saved.values.set(GIT_WORKING_PATHS_KEY + "a", invalid);
    assert.throws(() => loadGitWorkingPaths(saved, "a"));
    assert.equal(saved.values.get(GIT_WORKING_PATHS_KEY + "a"), invalid);
  }
  const full = { paths: Array.from({ length: MAX_GIT_WORKING_PATHS }, (_, index) => `Q:\\repo-${index}`), selectedPath: null };
  assert.throws(() => addGitWorkingPath(full, "Q:\\another"), /up to 8/);
  assert.throws(() => saveGitWorkingPaths({ setItem: () => { throw new Error("Storage blocked"); } }, "a", full), /Storage blocked/);
});

const workspace = (extra = {}) => ({
  state: "repository", repoRoot: "Q:/repo", branch: "feature", head: "a".repeat(40),
  staged: [{ path: "staged" }], unstaged: [{ path: "working" }], untracked: [{ path: "new" }],
  compare: [], refs: [], warnings: [], detailsLoaded: false, ...extra,
});
test("background details preserve the fast local snapshot and reject stale repository identity", () => {
  const changes = workspace({ warnings: ["local warning"] });
  const details = workspace({ detailsLoaded: true, refs: [{ name: "main" }], compare: [{ path: "committed" }],
    staged: [], unstaged: [], untracked: [], warnings: ["local warning", "details warning"] });
  const result = mergeGitWorkspaceDetails(changes, details);
  assert.equal(result.staged, changes.staged);
  assert.equal(result.unstaged, changes.unstaged);
  assert.equal(result.untracked, changes.untracked);
  assert.equal(result.refs, details.refs);
  assert.equal(result.compare, details.compare);
  assert.deepEqual(result.warnings, ["local warning", "details warning",
    "Working changes moved while comparison metadata loaded. Refresh to update the file list."]);
  for (const mismatch of [{ repoRoot: "Q:/other" }, { head: "b".repeat(40) }, { branch: "other" },
    { state: "noRepo" }, { detailsLoaded: false }]) {
    assert.throws(() => mergeGitWorkspaceDetails(changes, { ...details, ...mismatch }));
  }
});
test("deferred counts enrich matching file rows without adopting new paths or different rename/status records", () => {
  const file = { path: "file.txt", originalPath: null, status: "M", kind: "file", added: null, deleted: null, binary: false };
  const changes = workspace({ staged: [], untracked: [], unstaged: [file] });
  const details = workspace({ detailsLoaded: true, staged: [], untracked: [],
    unstaged: [{ ...file, added: 12, deleted: 3 }] });
  const complete = mergeGitWorkspaceDetails(changes, details);
  assert.deepEqual(complete.unstaged, [{ ...file, added: 12, deleted: 3 }]);
  assert.deepEqual(complete.warnings, []);
  assert.equal(complete.unstaged[0].path, file.path);
  const moved = mergeGitWorkspaceDetails(changes, {
    ...details, unstaged: [{ ...file, status: "R", originalPath: "old.txt", added: 2, deleted: 2 }],
  });
  assert.equal(moved.unstaged, changes.unstaged);
  assert.match(moved.warnings.join(" "), /Working changes moved/);
});
test("details-only replies do not claim that working files disappeared", () => {
  const changes = workspace({ changesLoaded: true });
  const details = workspace({ detailsLoaded: true, changesLoaded: false,
    staged: [], unstaged: [], untracked: [] });
  const complete = mergeGitWorkspaceDetails(changes, details);
  assert.equal(complete.staged, changes.staged);
  assert.equal(complete.unstaged, changes.unstaged);
  assert.equal(complete.untracked, changes.untracked);
  assert.equal(complete.changesLoaded, true);
  assert.deepEqual(complete.warnings, []);
});
test("on-demand preview counts update only the matching repository, HEAD, view and rename", () => {
  const file = { path: "file.txt", originalPath: null, status: "M", kind: "file", added: null, deleted: null, binary: false };
  const initial = workspace({ unstaged: [file] });
  const diff = { repoRoot: initial.repoRoot, head: initial.head, view: "unstaged",
    path: file.path, originalPath: null, added: 7, deleted: 2, binary: false };
  const counted = applyGitPreviewCounts(initial, diff);
  assert.deepEqual(counted.unstaged, [{ ...file, added: 7, deleted: 2 }]);
  assert.equal(applyGitPreviewCounts(counted, diff), counted);
  for (const changed of [{ repoRoot: "Q:/other" }, { head: "b".repeat(40) },
    { path: "other.txt" }, { originalPath: "renamed.txt" }]) {
    assert.equal(applyGitPreviewCounts(initial, { ...diff, ...changed }), initial);
  }
  const details = workspace({ changesLoaded: false, detailsLoaded: true, staged: [], unstaged: [], untracked: [] });
  assert.equal(mergeGitWorkspaceDetails(counted, details).unstaged, counted.unstaged);
});
test("cached previews are bounded and isolated by session, directory and base", () => {
  const key = gitWorkspaceCacheKey("session", "Q:\\repo", "");
  const value = workspace();
  cacheGitWorkspace(key, value);
  assert.equal(cachedGitWorkspace(key), value);
  for (const other of [gitWorkspaceCacheKey("other", "Q:\\repo", ""),
    gitWorkspaceCacheKey("session", "Q:\\other", ""), gitWorkspaceCacheKey("session", "Q:\\repo", "main")]) {
    assert.equal(cachedGitWorkspace(other), null);
  }
  for (let index = 0; index < 12; index++) cacheGitWorkspace(`fixture-${index}`, workspace());
  assert.equal(cachedGitWorkspace(key), null);
});
