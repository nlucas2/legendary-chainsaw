import test from "node:test";
import assert from "node:assert/strict";
import { isApplyPatchTool, parseApplyPatch, patchArguments, PATCH_PREVIEW_MAX_CHARS, PATCH_PREVIEW_MAX_LINES } from "../src/lib/applyPatch.ts";

test("patch tool detection and extraction do not guess between conflicting argument fields", () => {
  for (const name of ["apply_patch", "functions.apply_patch", "namespace/apply_patch"]) assert.equal(isApplyPatchTool(name), true);
  for (const name of ["apply_patch_extra", "not_apply_patch", "patch"]) assert.equal(isApplyPatchTool(name), false);
  assert.deepEqual(patchArguments("source"), { source: "source" });
  assert.deepEqual(patchArguments({ input: "source", explanation: "Keep this too" }),
    { source: "source", extra: { explanation: "Keep this too" } });
  assert.deepEqual(patchArguments({ patch: "source" }), { source: "source" });
  for (const value of [null, [], 3, { command: "source" }, { input: "one", patch: "two" }]) assert.equal(patchArguments(value), null);
});

test("multi-file patches expose additions, removals, moves and anchors without inventing update line numbers", () => {
  const patch = "*** Begin Patch\n*** Update File: src/a.rs\n*** Move to: src/b.rs\n@@ fn main\n before\n-old\n+new\n@@ second hunk\n-more\n+less\n*** End of File\n*** Add File: new.txt\n+first\n+\n+*** looks like metadata but is content\n*** Delete File: gone.txt\n*** End Patch\n";
  const parsed = parseApplyPatch(patch);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.files.length, 3);
  const [update, added, deleted] = parsed.files;
  assert.equal(update.moveTo, "src/b.rs");
  assert.equal(update.added, 2);
  assert.equal(update.removed, 2);
  assert.deepEqual(update.lines.map((line) => line.kind), ["hunk", "context", "delete", "add", "hunk", "delete", "add", "meta"]);
  assert.ok(update.lines.every((line) => line.newLine === null && line.oldLine === null));
  assert.equal(added.added, 3);
  assert.deepEqual(added.lines.map((line) => line.newLine), [1, 2, 3]);
  assert.equal(added.lines[1].text, "+");
  assert.equal(deleted.operation, "delete");
  assert.deepEqual(deleted.lines, []);
  assert.equal(deleted.removed, 0, "no fabricated deleted contents");
});

test("CRLF, Windows paths and metadata-only operations are retained without reading files", () => {
  const patch = "*** Begin Patch\r\n*** Update File: Q:\\repo\\old.txt\r\n*** Move to: Q:\\repo\\new.txt\r\n*** Add File: empty.txt\r\n*** Delete File: has spaces.txt\r\n*** End Patch\r\n";
  const parsed = parseApplyPatch(patch);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.files[0].path, "Q:\\repo\\old.txt");
  assert.equal(parsed.files[0].moveTo, "Q:\\repo\\new.txt");
  assert.deepEqual(parsed.files.map((file) => file.lines), [[], [], []]);
});

test("unsupported, incomplete and malformed patches fall back as a whole instead of presenting a misleading partial diff", () => {
  for (const patch of [
    "", "*** Begin Patch\n*** Add File: file\n+partial",
    "*** Begin Patch\n*** End Patch",
    "*** Begin Patch\n*** Update File: file\nunprefixed\n*** End Patch",
    "*** Begin Patch\n*** Add File: file\n-not added\n*** End Patch",
    "*** Begin Patch\n*** Delete File: file\n+not a deletion\n*** End Patch",
    "*** Begin Patch\n*** Update File: file\n*** End Patch",
    "*** Begin Patch\n*** Update File: file\n+a\n*** Move to: other\n*** End Patch",
    "*** Begin Patch\n*** Add File: \n+test\n*** End Patch",
    "*** Begin Patch\n*** Add File: fine\n+fine\n*** Unexpected\n*** End Patch",
  ]) {
    const result = parseApplyPatch(patch);
    assert.ok(result.error, patch);
    assert.equal(result.files, undefined);
  }
});

test("patch rendering budgets leave oversized source intact for raw viewing", () => {
  assert.match(parseApplyPatch("x".repeat(PATCH_PREVIEW_MAX_CHARS + 1)).error, /Large patch/);
  const many = "*** Begin Patch\n*** Add File: file\n" + "+x\n".repeat(PATCH_PREVIEW_MAX_LINES) + "*** End Patch";
  assert.match(parseApplyPatch(many).error, /Large patch/);
  const files = "*** Begin Patch\n" + Array.from({ length: 101 }, (_, i) => `*** Delete File: file-${i}\n`).join("") + "*** End Patch";
  assert.ok(parseApplyPatch(files).error);
});
