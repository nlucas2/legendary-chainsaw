import { gitDirectoryIdentity } from "./gitWorkspace.ts";

export const GIT_WORKING_PATHS_KEY = "copilot-sessions.git-working-paths.v1:";
export const MAX_GIT_WORKING_PATHS = 8;

export interface GitWorkingPaths {
  paths: string[];
  selectedPath: string | null;
}

export const gitWorkingPathIdentity = gitDirectoryIdentity;

export function validateGitWorkingPath(value: string): string {
  const path = value.trim();
  if (!path || path.length > 4096 || /[\u0000-\u001f\u007f]/.test(path)
    || !/^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/)/i.test(path)) {
    throw new Error("Enter an absolute working directory on the daemon's computer.");
  }
  return path;
}

function normalize(value: unknown): GitWorkingPaths {
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1
    || !("paths" in value) || !Array.isArray(value.paths) || value.paths.length > MAX_GIT_WORKING_PATHS
    || !value.paths.every((path): path is string => typeof path === "string")
    || !("selectedPath" in value) || (value.selectedPath !== null && typeof value.selectedPath !== "string")) {
    throw new Error("Saved Git working paths are unreadable. Their existing data was not overwritten.");
  }
  const paths = value.paths.map(validateGitWorkingPath);
  if (new Set(paths.map(gitWorkingPathIdentity)).size !== paths.length
    || (value.selectedPath !== null && !paths.includes(value.selectedPath))) {
    throw new Error("Saved Git working paths contain an invalid selection or duplicate directory.");
  }
  return { paths, selectedPath: value.selectedPath };
}

export function loadGitWorkingPaths(storage: Pick<Storage, "getItem">, sessionId: string): GitWorkingPaths {
  const saved = storage.getItem(GIT_WORKING_PATHS_KEY + sessionId);
  if (saved === null) return { paths: [], selectedPath: null };
  if (saved.length > 64 * 1024) throw new Error("Saved Git working paths exceed the inspection limit. Their existing data was not overwritten.");
  let value: unknown;
  try { value = JSON.parse(saved); }
  catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Saved Git working paths are unreadable. Their existing data was not overwritten.");
    }
    throw error;
  }
  return normalize(value);
}

export function saveGitWorkingPaths(storage: Pick<Storage, "setItem">, sessionId: string, value: GitWorkingPaths): void {
  const next = normalize({ version: 1, ...value });
  storage.setItem(GIT_WORKING_PATHS_KEY + sessionId, JSON.stringify({ version: 1, ...next }));
}

export function addGitWorkingPath(current: GitWorkingPaths, path: string): GitWorkingPaths {
  const nextPath = validateGitWorkingPath(path);
  const identity = gitWorkingPathIdentity(nextPath);
  const existing = current.paths.find((candidate) => gitWorkingPathIdentity(candidate) === identity);
  if (existing) return { ...current, selectedPath: existing };
  if (current.paths.length >= MAX_GIT_WORKING_PATHS) {
    throw new Error(`Keep up to ${MAX_GIT_WORKING_PATHS} additional Git working paths per session. Remove one before adding another.`);
  }
  return { paths: [...current.paths, nextPath], selectedPath: nextPath };
}
