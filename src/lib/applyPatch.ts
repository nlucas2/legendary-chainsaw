import type { DiffLine } from "./gitWorkspace.ts";

export const PATCH_PREVIEW_MAX_CHARS = 512 * 1024;
export const PATCH_PREVIEW_MAX_LINES = 10_000;
const MAX_FILES = 100;

export interface PatchFile {
  operation: "add" | "update" | "delete";
  path: string;
  moveTo?: string;
  lines: DiffLine[];
  added: number;
  removed: number;
}
export type PatchPreview = { files: PatchFile[]; error?: never } | { files?: never; error: string };

export function isApplyPatchTool(name: string): boolean {
  return /(?:^|[.:/])apply_patch$/.test(name);
}

export function patchArguments(value: unknown): { source: string; extra?: Record<string, unknown> } | null {
  if (typeof value === "string") return { source: value };
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  const candidates = entries.filter(([key, item]) => ["input", "patch"].includes(key) && typeof item === "string");
  if (candidates.length !== 1) return null;
  const [key, source] = candidates[0];
  if (typeof source !== "string") return null;
  const extra = Object.fromEntries(entries.filter(([name]) => name !== key));
  return { source, ...(Object.keys(extra).length ? { extra } : {}) };
}

/** Read only the patch request. Hunk anchors are not absolute source line numbers. */
export function parseApplyPatch(source: string): PatchPreview {
  if (source.length > PATCH_PREVIEW_MAX_CHARS) return { error: "Large patch: showing raw arguments instead of rendering the diff." };
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length > PATCH_PREVIEW_MAX_LINES) return { error: "Large patch: showing raw arguments instead of rendering the diff." };
  if (lines[0] !== "*** Begin Patch" || lines[lines.length - 1] !== "*** End Patch") {
    return { error: "Patch is incomplete or uses an unrecognized format; showing raw arguments." };
  }
  const files: PatchFile[] = [];
  let file: PatchFile | undefined;
  let eof = false;
  const invalid = (): PatchPreview => ({ error: "Could not interpret the complete patch; showing raw arguments." });
  const validPath = (path: string) => path.trim().length > 0 && !path.includes("\0");
  for (let i = 1; i < lines.length - 1; i++) {
    const text = lines[i];
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(text);
    if (header) {
      if (!validPath(header[2]) || files.length === MAX_FILES) return invalid();
      file = { operation: header[1] === "Add" ? "add" : header[1] === "Delete" ? "delete" : "update",
        path: header[2], lines: [], added: 0, removed: 0 };
      files.push(file);
      eof = false;
      continue;
    }
    if (!file || file.operation === "delete" || eof) return invalid();
    if (text.startsWith("*** Move to: ")) {
      if (file.operation !== "update" || file.moveTo || file.lines.length || !validPath(text.slice(13))) return invalid();
      file.moveTo = text.slice(13);
      continue;
    }
    const line: DiffLine = { index: file.lines.length, text, kind: "meta", oldLine: null, newLine: null };
    if (text.startsWith("+")) {
      line.kind = "add";
      file.added++;
      if (file.operation === "add") line.newLine = file.added;
    } else if (file.operation === "update") {
      if (text.startsWith("-")) { line.kind = "delete"; file.removed++; }
      else if (text.startsWith(" ")) line.kind = "context";
      else if (text === "@@" || text.startsWith("@@ ")) line.kind = "hunk";
      else if (text === "*** End of File") { line.kind = "meta"; eof = true; }
      else return invalid();
    } else return invalid();
    file.lines.push(line);
  }
  if (!files.length || files.some((file) => file.operation === "update" && !file.moveTo &&
      !file.lines.some((line) => line.kind === "add" || line.kind === "delete"))) return invalid();
  return { files };
}
