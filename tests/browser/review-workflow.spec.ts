import { test, expect, type Page } from "@playwright/test";
import { createGitComment, diffIdentity, parseUnifiedDiff } from "../../src/lib/gitWorkspace";

const makeSession = (sessionId: string) => ({
  sessionId, title: `Review session ${sessionId}`, cwd: "Q:\\review", model: "model",
  isActive: true, isRemote: false, pinned: false, archived: false, tags: [], startTime: "", modifiedTime: "",
});
const diff = (path = "first.ts", view: "unstaged" | "staged" = "unstaged") => ({
  repoRoot: "Q:/review", path, originalPath: null, view, head: "head", base: null, baseCommit: null,
  mergeBase: null, contentId: `${view}-${path}`, context: "changes" as const, fullContextComplete: false,
  patch: "@@ -1,3 +1,3 @@\n before\n-old\n+new\n after\n", truncated: false, binary: false, kind: "file",
  added: 1, deleted: 1, unavailableReason: null, warnings: [],
});
const file = (path: string) => ({ path, originalPath: null, status: "M", kind: "file", added: 1, deleted: 1, binary: false });
const makeNote = (path: string, body: string) => {
  const snapshot = diff(path);
  return createGitComment(snapshot, parseUnifiedDiff(snapshot.patch), new Set([3]), body);
};

async function setup(page: Page) {
  const state = {
    sent: [] as { sessionId: string; content: string; attachments: { displayName: string; mimeType: string; data: string }[] }[],
    asks: [] as { sessionId: string; question: string }[],
    failSend: false,
    history: { a: [], b: [] } as Record<string, unknown[]>,
  };
  await page.addInitScript(() => {
    class ReviewSource extends EventTarget {
      onopen: (() => void) | null = null;
      listener = (event: Event) => {
        if (event instanceof CustomEvent) this.dispatchEvent(new MessageEvent("session-event", { data: JSON.stringify(event.detail) }));
      };
      constructor() { super(); window.addEventListener("review-test-event", this.listener); setTimeout(() => this.onopen?.(), 0); }
      close() { window.removeEventListener("review-test-event", this.listener); }
    }
    Object.defineProperty(window, "EventSource", { value: ReviewSource });
  });
  await page.route("**/api/**", async (route) => {
    const command = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const args = route.request().postDataJSON() ?? {};
    let value: unknown;
    switch (command) {
      case "list_sessions": value = [makeSession("a"), makeSession("b")]; break;
      case "resume_session": value = makeSession(args.sessionId); break;
      case "runtime_status": value = { connected: true, acceptingWork: true, activeSessions: 2 }; break;
      case "session_state": value = { sessionId: args.sessionId, mode: "interactive", processing: false }; break;
      case "session_processing": value = false; break;
      case "pending_permissions": case "pending_interactions": case "subagent_context": value = []; break;
      case "queue_items": value = { items: [], steeringMessages: [] }; break;
      case "git_repository": value = { isRepository: true, repoRoot: "Q:/review" }; break;
      case "session_history_window": value = { events: state.history[args.sessionId], hasMore: false, cursor: "", loadedPages: 1, humanMessages: 0 }; break;
      case "git_workspace": value = {
        state: "repository", repoRoot: "Q:/review", branch: "feature", head: "head", base: null, baseCommit: null,
        mergeBase: null, upstream: null, refs: [], warnings: [], detached: false, unborn: false,
        staged: [file("staged.ts")], unstaged: [file("first.ts"), file("second.ts")], untracked: [], compare: [], compareUnavailableReason: "Choose a target",
      }; break;
      case "git_diff": value = diff(args.path, args.view); break;
      case "ask_session":
        state.asks.push(args);
        value = { sessionId: args.sessionId, answer: "Consider the empty-input edge case." };
        break;
      case "send_message": {
        state.sent.push(args);
        if (state.failSend) return route.fulfill({ status: 500, body: "Simulated send failure" });
        const events = [
          { id: crypto.randomUUID(), type: "user.message", timestamp: "", data: { content: args.content, attachments: args.attachments } },
          { id: crypto.randomUUID(), type: "assistant.message", timestamp: "", data: { content: "We can continue discussing these notes." } },
          { id: crypto.randomUUID(), type: "session.idle", timestamp: "", data: {} },
        ];
        state.history[args.sessionId].push(...events);
        await route.fulfill({ json: "accepted" });
        await page.evaluate(({ sessionId, events }) => {
          for (const event of events) window.dispatchEvent(new CustomEvent("review-test-event", { detail: { type: "session_event", sessionId, event } }));
        }, { sessionId: args.sessionId, events });
        return;
      }
      default: return route.fulfill({ status: 404, body: `Unexpected ${command}` });
    }
    return route.fulfill({ json: value });
  });
  await page.goto("/?session=a");
  await expect(page.locator(".parent-session-view .composer textarea")).toBeEnabled();
  return state;
}

async function openFile(page: Page, path = "first.ts") {
  await page.getByRole("button", { name: "Open Git workspace", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Git workspace", exact: true });
  await panel.getByTitle(path, { exact: true }).click();
  await expect(panel.getByRole("region", { name: "Selected file unified diff" })).toContainText("+new");
  return panel;
}
const decodeContext = (attachment: { data: string }) => JSON.parse(Buffer.from(attachment.data, "base64").toString("utf8"));

test("Discuss in chat preserves existing text and keeps removable context with its session draft", async ({ page }) => {
  const state = await setup(page);
  const composer = page.locator(".parent-session-view .composer textarea");
  await composer.fill("Keep my existing question");
  const git = await openFile(page);
  await git.getByLabel("Local review comment", { exact: true }).fill("A question not yet saved");
  await git.getByRole("button", { name: "Discuss this diff in chat", exact: true }).click();
  await expect(git).toHaveCount(0);
  await expect(composer).toHaveValue("Keep my existing question");
  await expect(page.locator(".composer .review-context-chip")).toContainText("first.ts");
  await page.locator(".composer .review-context-chip summary").click();
  await expect(page.locator(".composer .review-context-chip pre")).toContainText("A question not yet saved");
  expect(state.sent).toHaveLength(0);
  expect(state.asks).toHaveLength(0);
  await page.locator("[data-session-id='b'] .session-open").click();
  await expect(page.locator(".composer .review-context-chip")).toHaveCount(0);
  await page.locator("[data-session-id='a'] .session-open").click();
  await expect(composer).toHaveValue("Keep my existing question");
  await expect(page.locator(".composer .review-context-chip")).toHaveCount(1);
  await page.getByRole("button", { name: /^Remove review context/ }).click();
  await expect(page.locator(".composer .review-context-chip")).toHaveCount(0);
  await expect(composer).toHaveValue("Keep my existing question");
});

test("Quick ask stays transient and Continue in chat preserves the submitted Q&A plus note snapshot", async ({ page }) => {
  const state = await setup(page);
  const note = makeNote("first.ts", "Why does this change need a guard?");
  await page.evaluate((note) => localStorage.setItem("copilot-sessions.git-comments.v1", JSON.stringify([note])), note);
  const git = await openFile(page);
  await git.getByRole("button", { name: "Quick ask about comment", exact: true }).click();
  const ask = page.getByRole("dialog", { name: "Ask about conversation", exact: true });
  await expect(ask.getByLabel("Question", { exact: true })).toHaveValue(note.body);
  await expect(ask.locator(".review-context-chip")).toContainText("first.ts");
  expect(state.asks).toHaveLength(0);
  await ask.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(ask.getByRole("article", { name: "Transient answer" })).toContainText("empty-input edge case");
  expect(state.asks[0].question).toContain(note.body);
  expect(state.asks[0].question).toContain(note.id);
  expect(state.sent).toHaveLength(0);
  await ask.getByLabel("Question", { exact: true }).fill("This edit was never submitted");
  await ask.getByRole("button", { name: "Continue in chat", exact: true }).click();
  const composer = page.locator(".parent-session-view .composer textarea");
  await expect(page.locator(".composer .review-context-chip")).toContainText("Discussion");
  expect(state.sent).toHaveLength(0);
  await composer.fill("Please expand on the edge case.");
  await composer.press("Enter");
  await expect(page.locator(".message.assistant")).toContainText("continue discussing");
  expect(state.sent).toHaveLength(1);
  const continued = decodeContext(state.sent[0].attachments[0]);
  expect(continued.question).toBe(note.body);
  expect(continued.answer).toBe("Consider the empty-input edge case.");
  expect(JSON.parse(continued.reviewContext.text).note.id).toBe(note.id);
  expect(JSON.stringify(continued)).not.toContain("This edit was never submitted");
  await composer.fill("What about the other branch?");
  await composer.press("Enter");
  await expect.poll(() => state.sent.length).toBe(2);
  expect(state.sent[1].attachments).toHaveLength(0);
  expect(state.sent[1].sessionId).toBe("a");
  expect(state.history.a).toHaveLength(6);
});

test("all repository notes are attached in one batch with old snapshots labeled and no notes deleted", async ({ page }) => {
  const state = await setup(page);
  const first = makeNote("first.ts", "Check null input");
  const second = makeNote("second.ts", "Check this branch");
  const old = { ...makeNote("older.ts", "Older review concern"), id: "older-note", snapshot: undefined,
    identity: diffIdentity({ ...diff("older.ts", "staged"), head: "old-head" }) };
  const foreign = { ...makeNote("private.ts", "Different repository note"), id: "other-repository",
    identity: diffIdentity({ ...diff("private.ts"), repoRoot: "Q:/other" }) };
  await page.evaluate((notes) => localStorage.setItem("copilot-sessions.git-comments.v1", JSON.stringify(notes)), [first, second, old, foreign]);
  const git = await openFile(page);
  const notes = git.getByRole("region", { name: "Repository review notes" });
  await notes.getByRole("button", { name: "Review notes (3)", exact: true }).click();
  await expect(notes).toContainText("HEAD differs");
  await expect(notes).not.toContainText(foreign.body);
  await notes.getByRole("button", { name: "Bring all notes into chat", exact: true }).click();
  await expect(page.locator(".composer .review-context-chip")).toContainText("Review notes (3)");
  const composer = page.locator(".parent-session-view .composer textarea");
  await expect(composer).toHaveValue(/triage all attached review notes/);
  expect(state.sent).toHaveLength(0);
  await composer.press("Enter");
  await expect(page.locator(".message.assistant")).toBeVisible();
  const batch = decodeContext(state.sent[0].attachments[0]);
  expect(batch.notes.map((note: { id: string }) => note.id)).toEqual([first.id, second.id, old.id]);
  expect(batch.notes[2].warnings.join(" ")).toContain("HEAD differs");
  expect(batch.notes[2].context.truncated).toBe(true);
  expect(JSON.stringify(batch)).not.toContain(foreign.id);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("copilot-sessions.git-comments.v1")!).length)).toBe(4);
  expect(state.sent[0].attachments[0].mimeType).toBe("text/plain");
});

test("failed sends restore review context for retry", async ({ page }) => {
  const state = await setup(page);
  state.failSend = true;
  const git = await openFile(page);
  await git.getByRole("button", { name: "Discuss this diff in chat", exact: true }).click();
  const composer = page.locator(".parent-session-view .composer textarea");
  await composer.press("Enter");
  await expect(page.locator(".composer [role='alert']")).toContainText("Simulated send failure");
  await expect(page.locator(".composer .review-context-chip")).toHaveCount(1);
  state.failSend = false;
  await composer.press("Enter");
  await expect(page.locator(".message.assistant")).toBeVisible();
  expect(state.sent).toHaveLength(2);
  expect(state.sent[1].attachments).toEqual(state.sent[0].attachments);
});

test("attachment-limit errors keep the source review open and the original draft intact", async ({ page }) => {
  const state = await setup(page);
  const composer = page.locator(".parent-session-view .composer textarea");
  await composer.fill("Existing message");
  await page.locator(".composer input[type='file']").setInputFiles(Array.from({ length: 5 }, (_, index) => ({
    name: `file-${index}.txt`, mimeType: "text/plain", buffer: Buffer.from("small file"),
  })));
  await expect(page.locator(".composer .attachment-chip")).toHaveCount(5);
  const git = await openFile(page);
  await git.getByRole("button", { name: "Discuss this diff in chat", exact: true }).click();
  await expect(git.getByRole("alert")).toContainText("at most 5");
  await expect(git).toBeVisible();
  await expect(composer).toHaveValue("Existing message");
  expect(state.sent).toHaveLength(0);
});

test("highlighted code can be saved as notes across files before one chat handoff", async ({ page }, testInfo) => {
  const state = await setup(page);
  const git = await openFile(page);
  await expect(git.locator(".git-panel-diff input[type='checkbox']")).toHaveCount(0);
  await git.getByRole("option", { name: "Added line new:2", exact: true }).click();
  await git.getByLabel("Local review comment", { exact: true }).fill("First local concern");
  await page.screenshot({ path: testInfo.outputPath("review-highlight-and-note.png") });
  await git.getByRole("button", { name: "Save local comment", exact: true }).click();
  await git.getByTitle("second.ts", { exact: true }).click();
  await git.getByRole("option", { name: "Context line old:1 new:1", exact: true }).click();
  await git.getByLabel("Local review comment", { exact: true }).fill("Context line question");
  await git.getByRole("button", { name: "Save local comment", exact: true }).click();
  await git.getByRole("button", { name: "Bring all notes into chat", exact: true }).click();
  await expect(page.locator(".composer .review-context-chip")).toContainText("Review notes (2)");
  await page.screenshot({ path: testInfo.outputPath("review-notes-chat-draft.png") });
  expect(state.sent).toHaveLength(0);
  await page.locator(".parent-session-view .composer textarea").press("Enter");
  await expect(page.locator(".message.assistant")).toBeVisible();
  const batch = decodeContext(state.sent[0].attachments[0]);
  expect(batch.notes.map((note: { body: string }) => note.body)).toEqual(["First local concern", "Context line question"]);
  expect(batch.notes[0].context.excerpt).toContain("before");
  expect(batch.notes[1].locations[0].location).toBe("old:1 new:1");
});

test.describe("mobile review handoffs", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test("quick questions and context chips stay within the mobile pane", async ({ page }) => {
    const state = await setup(page);
    const git = await openFile(page);
    await git.getByRole("button", { name: "Quick ask about this diff", exact: true }).tap();
    const ask = page.getByRole("dialog", { name: "Ask about conversation", exact: true });
    await ask.getByLabel("Question", { exact: true }).fill("Explain this diff");
    await ask.getByRole("button", { name: "Ask", exact: true }).tap();
    await expect(ask.getByRole("article", { name: "Transient answer" })).toContainText("empty-input");
    expect(await ask.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await ask.getByRole("button", { name: "Continue in chat", exact: true }).tap();
    const chip = page.locator(".composer .review-context-chip");
    await expect(chip).toBeVisible();
    expect(await chip.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(state.sent).toHaveLength(0);
    await chip.getByRole("button", { name: /^Remove review context/ }).tap();
    await expect(chip).toHaveCount(0);
  });
});
