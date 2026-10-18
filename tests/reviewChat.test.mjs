import test from "node:test";
import assert from "node:assert/strict";
import { createGitComment, diffIdentity, parseUnifiedDiff, loadGitComments, saveGitComments } from "../src/lib/gitWorkspace.ts";
import { gitReviewContext, gitNotesContext, noteSnapshotWarnings, savedGitIdentity, sameGitRepository } from "../src/lib/gitReview.ts";
import { reviewAttachment, withReviewAttachment, quickAskQuestion, continueReviewConversation, MAX_REVIEW_CONTEXT_BYTES } from "../src/lib/reviewChat.ts";
import { chatDraftReducer } from "../src/lib/chatDrafts.ts";
import { attachmentPayload } from "../src/lib/attachments.ts";

const diff = {
  repoRoot: "Q:/example", path: "src/new.ts", originalPath: null, view: "unstaged", head: "a",
  base: "refs/heads/main", baseCommit: "b", mergeBase: "c", contentId: "snapshot",
  patch: "@@ -1,3 +1,3 @@\n before\n-old\n+new\n after\n", truncated: false, binary: false,
  kind: "file", context: "changes", added: 1, deleted: 1, unavailableReason: null, warnings: [],
};
const workspace = { ...diff, state: "repository", staged: [], unstaged: [{ path: diff.path }], untracked: [], compare: [] };
const lines = parseUnifiedDiff(diff.patch);
const note = () => createGitComment(diff, lines, new Set([3]), "Why this change? 🦀");

test("new notes save bounded nearby context and legacy notes still load", () => {
  const current = note();
  assert.match(current.snapshot.excerpt, /before/);
  assert.match(current.snapshot.excerpt, /after/);
  const { snapshot, ...legacy } = current;
  const storage = { text: null, getItem() { return this.text; }, setItem(_key, text) { this.text = text; } };
  saveGitComments(storage, [current, { ...legacy, id: "legacy" }]);
  assert.equal(loadGitComments(storage)[0].snapshot.excerpt, snapshot.excerpt);
  assert.equal(loadGitComments(storage)[1].snapshot, undefined);
  const before = storage.text;
  assert.throws(() => saveGitComments(storage, [{ ...current, snapshot: { excerpt: 1 } }]), /Invalid saved Git context/);
  assert.equal(storage.text, before);
});

test("batch handoff includes every repository note across views, excludes other repos and labels snapshots", () => {
  const first = note();
  const olderDiff = { ...diff, path: "other.ts", view: "compare", head: "older", contentId: "old" };
  const older = { ...note(), id: "older-note", identity: diffIdentity(olderDiff), snapshot: undefined };
  const elsewhere = { ...note(), id: "elsewhere", identity: diffIdentity({ ...diff, repoRoot: "Q:/different" }) };
  const context = gitNotesContext([first, older, elsewhere], workspace);
  const data = JSON.parse(context.text);
  assert.deepEqual(data.notes.map((item) => item.id), [first.id, "older-note"]);
  assert.equal(data.notes[0].body, first.body);
  assert.match(data.notes[1].warnings.join(" "), /HEAD differs/);
  assert.match(data.notes[1].warnings.join(" "), /Legacy note/);
  assert.equal(data.notes[1].context.truncated, true);
  assert.equal(data.notes[1].snapshot.view, "compare");
  assert.doesNotMatch(context.text, /elsewhere|Q:\/different/);
  assert.equal(sameGitRepository("Q:\\Example\\", "q:/example"), true);
  assert.equal(sameGitRepository("/repo/A", "/repo/a"), false);
  assert.equal(savedGitIdentity({ identity: JSON.stringify(["q", "p", {}, null, null, null, null, "h"]) }), null);
});

test("single-note discussion contains exact snapshot and unsaved note text is not discarded", () => {
  const current = note();
  const context = gitReviewContext(diff, lines, new Set(), current);
  const data = JSON.parse(context.text);
  assert.equal(data.note.id, current.id);
  assert.equal(data.metadata.contentId, diff.contentId);
  assert.deepEqual(data.metadata.selectedLocations, ["new:2"]);
  assert.equal(context.suggestedQuestion, current.body);
  const unsaved = gitReviewContext(diff, lines, new Set([3]), undefined, "Unsaved question");
  assert.equal(JSON.parse(unsaved.text).note.saved, false);
  assert.equal(unsaved.suggestedQuestion, "Unsaved question");
  assert.match(quickAskQuestion("Explain?", context), /Explain\?/);
  assert.match(quickAskQuestion("Explain?", context), /snapshot/);
  assert.equal(quickAskQuestion("Ordinary ask"), "Ordinary ask");
});

test("pending comparison metadata does not claim a saved target or file disappeared", () => {
  const compare = { ...note(), identity: diffIdentity({ ...diff, view: "compare" }) };
  const identity = savedGitIdentity(compare);
  const partial = { ...workspace, detailsLoaded: false, baseCommit: null, mergeBase: null, unstaged: [] };
  const pending = noteSnapshotWarnings(identity, partial).join(" ");
  assert.match(pending, /Comparison metadata is not loaded/);
  assert.doesNotMatch(pending, /target differs|not listed/);
  const complete = noteSnapshotWarnings(identity, { ...partial, detailsLoaded: true }).join(" ");
  assert.match(complete, /target differs/);
  assert.match(complete, /not listed/);
});

test("review chips use native UTF-8 text blobs, with safe names and no extra API attachment fields", () => {
  const context = gitReviewContext(diff, lines, new Set([3]), note());
  const attachment = reviewAttachment(context);
  assert.equal(attachment.mimeType, "text/plain");
  assert.equal(Buffer.from(attachment.data, "base64").toString("utf8"), context.text);
  assert.equal(attachment.size, Buffer.byteLength(context.text));
  assert.doesNotMatch(attachment.displayName, /[<>:"/\\|?*]/);
  assert.equal(attachmentPayload([attachment])[0].reviewContext, undefined);
  assert.deepEqual(withReviewAttachment([attachment], attachment), [attachment]);
  const otherFiles = Array.from({ length: 5 }, (_, index) => ({ ...attachment, id: `file-${index}` }));
  assert.throws(() => withReviewAttachment(otherFiles, attachment), /at most 5/);
  assert.throws(() => reviewAttachment({ ...context, text: "x".repeat(MAX_REVIEW_CONTEXT_BYTES + 1) }), /512 KiB/);
});

test("review context survives draft stash, failure, session switches and restore without overwriting newer text", () => {
  const attachment = reviewAttachment(gitReviewContext(diff, lines, new Set([3]), note()));
  const draft = { text: "Discuss this", attachments: [attachment] };
  let state = chatDraftReducer({}, { type: "edit", sessionId: "a", update: () => draft });
  state = chatDraftReducer(state, { type: "stash", sessionId: "a" });
  state = chatDraftReducer(state, { type: "stash", sessionId: "a" });
  assert.equal(state.a.current.attachments[0].reviewContext.text, attachment.reviewContext.text);
  state = chatDraftReducer(state, { type: "submitted", sessionId: "a" });
  state = chatDraftReducer(state, { type: "edit", sessionId: "a", update: (current) => ({ ...current, text: "Newer thought" }) });
  state = chatDraftReducer(state, { type: "failed", sessionId: "a", id: "failed", draft, error: "Failed" });
  assert.equal(state.a.current.text, "Newer thought");
  assert.equal(state.a.saved[0].draft.attachments[0].reviewContext.id, attachment.reviewContext.id);
  state = chatDraftReducer(state, { type: "restore", sessionId: "a", id: "failed" });
  assert.equal(state.a.current.attachments[0].data, attachment.data);
  assert.equal(state.b, undefined);
});

test("Continue in chat preserves submitted question, answer, original code and note IDs", () => {
  const current = note();
  const original = gitReviewContext(diff, lines, new Set(), current);
  const continuation = continueReviewConversation("Actual submitted question", "The answer 🦀", original);
  const data = JSON.parse(continuation.text);
  assert.equal(data.question, "Actual submitted question");
  assert.equal(data.answer, "The answer 🦀");
  assert.equal(JSON.parse(data.reviewContext.text).note.id, current.id);
  assert.equal(JSON.parse(data.reviewContext.text).metadata.contentId, diff.contentId);
  assert.equal(continuation.repository, diff.repoRoot);
});
