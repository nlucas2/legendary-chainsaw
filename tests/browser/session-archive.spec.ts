import { test, expect, type Page } from "@playwright/test";

const makeSession = (id: string, title: string, extra = {}) => ({
  sessionId: id, title, cwd: "Q:\\example", model: "model", isActive: id === "current",
  isRemote: false, pinned: false, archived: false, tags: [] as string[], folder: undefined as string | undefined,
  startTime: "", modifiedTime: "", ...extra,
});

async function setup(page: Page, options: { allArchived?: boolean; url?: string } = {}) {
  const state = {
    sessions: [
      makeSession("current", "Build Rust Tauri App", { folder: "Copilot Sessions", tags: ["rust"] }),
      makeSession("other", "Review SDK references", { folder: "DBK", tags: ["security"] }),
      makeSession("loose", "Recover earlier work"),
      makeSession("pin", "Pinned investigation", { folder: "DBK", pinned: true, tags: ["active"] }),
      makeSession("old", "Older security review", { folder: "DBK", archived: true, tags: ["security"] }),
      makeSession("old-pin", "Pinned old investigation", { folder: "DBK", archived: true, pinned: true, tags: ["investigation"] }),
    ],
    requests: [] as { command: string; args: Record<string, unknown> }[],
    archiveError: "",
    responseDelay: 0,
    terminalConnections: 0,
  };
  if (options.allArchived) state.sessions.forEach((session) => { session.archived = true; });
  await page.addInitScript(() => {
    class ArchiveEventSource extends EventTarget {
      onopen: (() => void) | null = null;
      listener = (event: Event) => {
        if (event instanceof CustomEvent) this.dispatchEvent(new MessageEvent("session-event", { data: JSON.stringify(event.detail) }));
      };
      constructor() {
        super();
        window.addEventListener("archive-fixture-event", this.listener);
        setTimeout(() => this.onopen?.(), 0);
      }
      close() { window.removeEventListener("archive-fixture-event", this.listener); }
    }
    Object.defineProperty(window, "EventSource", { value: ArchiveEventSource });
  });
  const emit = (sessionId: string, archived: boolean) => page.evaluate(({ sessionId, archived }) =>
    window.dispatchEvent(new CustomEvent("archive-fixture-event", { detail: {
      type: "session_archive_changed", sessionId, archived,
    } })), { sessionId, archived });
  await page.routeWebSocket((url) => url.pathname === "/api/terminal", (socket) => {
    state.terminalConnections++;
    socket.send(JSON.stringify({ type: "ready", shell: "Mock shell", cwd: "Q:\\example", hasControl: true, restored: false, viewers: 1 }));
  });
  await page.route("**/api/**", async (route) => {
    const command = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const args = route.request().postDataJSON() ?? {};
    state.requests.push({ command, args });
    let result: unknown;
    switch (command) {
      case "list_sessions": result = state.sessions; break;
      case "resume_session": result = state.sessions.find((session) => session.sessionId === args.sessionId); break;
      case "runtime_status": result = { connected: true, acceptingWork: true, activeSessions: 1 }; break;
      case "session_state": result = { sessionId: args.sessionId, mode: "interactive", processing: false }; break;
      case "pending_permissions": case "pending_interactions": case "subagent_context": result = []; break;
      case "queue_items": result = { items: [], steeringMessages: [] }; break;
      case "git_repository": result = { isRepository: false }; break;
      case "agent_tasks": result = { sessionId: args.sessionId, tasks: [{
        id: "worker", name: "Reviewer", agentType: "task", toolCallId: "worker-call", model: "model",
        status: "running", canMessage: true,
      }] }; break;
      case "agent_history": result = {
        sessionId: args.sessionId, taskId: args.taskId, agentId: "worker-events", hasMore: false, cursor: null,
        events: [{ id: "worker-answer", type: "assistant.message", agentId: "worker-events", timestamp: "", data: { content: "Review in progress." } }],
      }; break;
      case "session_history_window": result = {
        events: [{ id: `${args.sessionId}-user`, type: "user.message", timestamp: "", data: { content: "Existing conversation" } }],
        hasMore: false, cursor: "", loadedPages: 1, humanMessages: 1,
      }; break;
      case "set_session_archived": {
        if (state.archiveError) return route.fulfill({ status: 500, body: state.archiveError });
        const session = state.sessions.find((session) => session.sessionId === args.sessionId)!;
        session.archived = args.archived;
        result = structuredClone(session);
        await emit(session.sessionId, session.archived);
        if (state.responseDelay) await new Promise((resolve) => setTimeout(resolve, state.responseDelay));
        break;
      }
      default: return route.fulfill({ status: 404, body: `Unexpected ${command}` });
    }
    return route.fulfill({ json: result });
  });
  await page.goto(options.url ?? "/?session=current");
  await expect(page.getByRole("combobox", { name: "Session view" })).toBeAttached();
  await expect.poll(() => state.requests.some((request) => request.command === "list_sessions")).toBe(true);
  return { state, emit };
}

test("Current, Archived and All preserve searchable folder/tag groups", async ({ page }) => {
  await setup(page);
  const view = page.getByRole("combobox", { name: "Session view" });
  await expect(view).toHaveValue("current");
  await expect(page.locator(".session-item")).toHaveCount(4);
  await expect(page.locator("[data-session-id='old']")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Unfiled sessions" })).toContainText("Recover earlier work");
  await page.getByPlaceholder("Search sessions").fill("security");
  await expect(page.locator(".session-item")).toHaveCount(1);
  await expect(page.locator(".session-item")).toContainText("Review SDK references");
  await view.selectOption("archived");
  await expect(page.locator(".session-item")).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Folder DBK", exact: true })).toContainText("Older security review");
  await page.getByPlaceholder("Search sessions").fill("");
  await expect(page.getByRole("region", { name: "Pinned sessions" })).toContainText("Pinned old investigation");
  await view.selectOption("all");
  await expect(page.locator(".session-item")).toHaveCount(6);
});

test("archiving an unopened session does not open it and restoring preserves organization", async ({ page }) => {
  const { state } = await setup(page);
  const composer = page.locator(".parent-session-view .composer textarea");
  await expect(composer).toBeEnabled();
  await composer.fill("Keep this working draft");
  const before = structuredClone(state.sessions.find((session) => session.sessionId === "other")!);
  const row = page.locator("[data-session-id='other']");
  await row.hover();
  await row.getByRole("button", { name: "Archive Review SDK references", exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(composer).toHaveValue("Keep this working draft");
  expect(state.requests.filter((request) => request.command === "resume_session").map((request) => request.args.sessionId)).toEqual(["current"]);
  expect(state.sessions.find((session) => session.sessionId === "other")).toEqual({ ...before, archived: true });
  const view = page.getByRole("combobox", { name: "Session view" });
  await view.selectOption("archived");
  await row.hover();
  await row.getByRole("button", { name: "Restore Review SDK references", exact: true }).click();
  await expect(row).toHaveCount(0);
  await view.selectOption("current");
  await expect(page.getByRole("region", { name: "Folder DBK", exact: true })).toContainText("Review SDK references");
  expect(state.sessions.find((session) => session.sessionId === "other")).toEqual(before);
  expect(state.requests.filter((request) => request.command === "set_session_archived").map((request) => request.args)).toEqual([
    { sessionId: "other", archived: true }, { sessionId: "other", archived: false },
  ]);
});

test("archiving the open session keeps chat and terminal mounted and offers restore", async ({ page }) => {
  const { state } = await setup(page);
  const composer = page.locator(".parent-session-view .composer textarea");
  await expect(composer).toBeEnabled();
  await composer.fill("Unsent draft must survive");
  await page.getByTitle("Open terminal", { exact: true }).click();
  await expect(page.locator(".terminal-title strong")).toHaveText("Mock shell");
  const row = page.locator("[data-session-id='current']");
  await row.hover();
  await row.getByRole("button", { name: "Archive Build Rust Tauri App", exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(page.locator(".session-archived-banner")).toContainText("running work are unchanged");
  await expect(page.getByRole("heading", { name: "Build Rust Tauri App", exact: true })).toBeVisible();
  await expect(composer).toHaveValue("Unsent draft must survive");
  expect(state.terminalConnections).toBe(1);
  await page.getByRole("button", { name: "Restore session", exact: true }).click();
  await expect(page.locator(".session-archived-banner")).toHaveCount(0);
  await expect(row).toBeVisible();
  expect(state.terminalConnections).toBe(1);
  expect(state.requests.some((request) => ["delete_session", "abort_session", "prepare_update", "send_message"].includes(request.command))).toBe(false);
});

test("restore and Undo preserve original pins and tags without opening archived sessions", async ({ page }) => {
  const { state } = await setup(page);
  const original = structuredClone(state.sessions.find((session) => session.sessionId === "old-pin")!);
  const view = page.getByRole("combobox", { name: "Session view" });
  await view.selectOption("archived");
  const row = page.locator("[data-session-id='old-pin']");
  await row.hover();
  await row.getByRole("button", { name: "Restore Pinned old investigation", exact: true }).click();
  await expect(row).toHaveCount(0);
  await view.selectOption("current");
  await expect(page.getByRole("region", { name: "Pinned sessions" })).toContainText("Pinned old investigation");
  expect(state.sessions.find((session) => session.sessionId === "old-pin")).toEqual({ ...original, archived: false });
  await page.locator(".session-archive-notice").getByRole("button", { name: "Undo", exact: true }).click();
  await expect(row).toHaveCount(0);
  expect(state.sessions.find((session) => session.sessionId === "old-pin")).toEqual(original);
  expect(state.requests.filter((request) => request.command === "resume_session").map((request) => request.args.sessionId)).toEqual(["current"]);
});

test("archiving a parent keeps the selected subagent and both drafts intact", async ({ page }) => {
  await setup(page);
  const parentComposer = page.locator(".parent-session-view .composer textarea");
  await expect(parentComposer).toBeEnabled();
  await parentComposer.fill("Parent draft");
  await page.getByRole("button", { name: "Subagents for Build Rust Tauri App", exact: true }).click();
  await page.locator("#subagents-current").getByRole("button", { name: /Reviewer/ }).click();
  const childComposer = page.getByRole("textbox", { name: "Message Reviewer", exact: true });
  await childComposer.fill("Child draft");
  const row = page.locator("[data-session-id='current']");
  await row.hover();
  await row.getByRole("button", { name: "Archive Build Rust Tauri App", exact: true }).click();
  await expect(page.locator(".session-archived-banner")).toBeVisible();
  await expect(childComposer).toHaveValue("Child draft");
  await page.getByRole("button", { name: "Back to parent", exact: true }).click();
  await expect(parentComposer).toHaveValue("Parent draft");
});

test("a persistence error leaves the row visible and a later remote change wins over an old response", async ({ page }) => {
  const { state, emit } = await setup(page);
  const row = page.locator("[data-session-id='other']");
  await row.hover();
  state.archiveError = "Could not save archive metadata";
  await row.getByRole("button", { name: "Archive Review SDK references", exact: true }).click();
  await expect(page.locator(".sidebar [role='alert']")).toContainText("Could not save");
  await expect(row).toBeVisible();
  expect(state.sessions.find((session) => session.sessionId === "other")!.archived).toBe(false);
  state.archiveError = "";
  state.responseDelay = 650;
  await row.hover();
  await row.getByRole("button", { name: "Archive Review SDK references", exact: true }).click();
  await expect(row).toHaveCount(0);
  state.sessions.find((session) => session.sessionId === "other")!.archived = false;
  await emit("other", false);
  await expect(row).toBeVisible();
  await row.hover();
  await expect(row.getByRole("button", { name: "Archive Review SDK references", exact: true })).toBeEnabled();
  await expect(row).toBeVisible();
  await expect(page.locator(".session-archive-notice")).toHaveCount(0);
});

test("archived sessions survive reload without being automatically opened on ordinary startup", async ({ page }) => {
  const { state } = await setup(page, { allArchived: true, url: "/" });
  await expect(page.locator(".session-item")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "View archived sessions", exact: true })).toBeVisible();
  expect(state.requests.some((request) => request.command === "resume_session")).toBe(false);
  await page.getByRole("combobox", { name: "Session view" }).selectOption("archived");
  await expect(page.locator(".session-item")).toHaveCount(6);
  expect(state.requests.some((request) => request.command === "resume_session")).toBe(false);
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Session view" })).toHaveValue("current");
  await expect(page.locator(".session-item")).toHaveCount(0);
  await page.goto("/?session=old");
  await expect(page.getByRole("combobox", { name: "Session view" })).toHaveValue("archived");
  await expect(page.locator(".session-archived-banner")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Older security review", exact: true })).toBeVisible();
});

test("folder boundaries stay subtle and the Unfiled group is collapsible", async ({ page }, testInfo) => {
  await setup(page);
  await page.locator(".daemon-state").click();
  await page.getByRole("button", { name: /^Dark / }).click();
  await page.getByRole("button", { name: "Close settings" }).click();
  const unfiled = page.getByRole("region", { name: "Unfiled sessions" });
  const heading = unfiled.getByRole("button", { name: "Unfiled 1", exact: true });
  await heading.focus();
  await heading.press("Enter");
  await expect(heading).toHaveAttribute("aria-expanded", "false");
  await expect(unfiled.locator(".session-item")).toHaveCount(0);
  await heading.press("Space");
  await expect(unfiled.locator(".session-item")).toHaveCount(1);
  const boundaries = await page.locator(".session-group + .session-group").evaluateAll((groups) => groups.map((group) => ({
    border: getComputedStyle(group).borderTopWidth, gap: parseFloat(getComputedStyle(group).marginTop),
    padding: parseFloat(getComputedStyle(group).paddingTop),
  })));
  expect(boundaries).toHaveLength(3);
  expect(boundaries.every((group) => group.border === "1px" && group.gap >= 8 && group.padding >= 8)).toBe(true);
  await page.locator(".sidebar").screenshot({ path: testInfo.outputPath("session-folder-separators.png") });
});

test.describe("touch archive controls", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test("archive and restore are reachable without hover or opening the target conversation", async ({ page }) => {
    const { state } = await setup(page);
    await page.getByRole("button", { name: "Open sessions", exact: true }).tap();
    const sidebar = page.locator(".sidebar");
    const row = sidebar.locator("[data-session-id='other']");
    await row.getByRole("button", { name: "Archive Review SDK references", exact: true }).tap();
    await expect(row).toHaveCount(0);
    await sidebar.getByRole("combobox", { name: "Session view" }).selectOption("archived");
    await row.getByRole("button", { name: "Restore Review SDK references", exact: true }).tap();
    await expect(row).toHaveCount(0);
    expect(state.requests.filter((request) => request.command === "resume_session").map((request) => request.args.sessionId)).toEqual(["current"]);
    expect(await sidebar.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  });
});
