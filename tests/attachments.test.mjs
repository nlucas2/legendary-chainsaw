import test from "node:test";
import assert from "node:assert/strict";
import { validateAttachments, attachmentPayload } from "../src/lib/attachments.ts";

test("attachment limits reject empty, oversized and excessive files", () => {
  assert.throws(() => validateAttachments([], [{ name: "empty", size: 0 }]), /empty/);
  assert.throws(() => validateAttachments([], [{ name: "large", size: 9 * 1024 * 1024 }]), /8 MiB/);
  assert.throws(() => validateAttachments(Array(5).fill({ size: 1 }), [{ name: "six", size: 1 }]), /at most/);
  assert.throws(() => validateAttachments([{ size: 8 * 1024 * 1024 }], [{ name: "next", size: 5 * 1024 * 1024 }]), /12 MiB/);
});

test("payload does not expose client UI draft metadata", () => {
  assert.deepEqual(attachmentPayload([{ id: "local", size: 3, type: "blob", data: "YWJj", mimeType: "text/plain", displayName: "note.txt" }]),
    [{ type: "blob", data: "YWJj", mimeType: "text/plain", displayName: "note.txt" }]);
});
