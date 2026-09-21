import { test, expect, type Page } from "@playwright/test";

const makeSession = (id: string, title: string, extra = {}) => ({
  sessionId: id, title, cwd: "Q:\\example", model: "model", isActive: id === "current",
  isRemote: false, pinned: false, archived: false, tags: [] as string[], folder: undefined as string | undefined,
  startTime: "", modifiedTime: "", ...extra,
});

async function setup(page: Page, options: { allArchived?: boolean; url?: string; longLabels?: boolean } = {}) {
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
  if (options.longLabels) {
    Object.assign(state.sessions[0], {
      title: "This is just a dummy session, so what I want you to do is review the entire change carefully",
      cwd: "Q:\\gitp\\copilot-sessions-rs\\crates\\copilot-sessions-core",
    });
    Object.assign(state.sessions[3], {
      title: "Investigate the complete authentication and connection recovery workflow",
      folder: "copilot-session-authentication-and-connection-recovery",
      cwd: "Q:\\example\\" + "very-long-directory-name".repeat(5),
    });
  }
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
      case "session_processing": result = false; break;
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

  for (const viewport of [{ width: 440, height: 760 }, { width: 320, height: 568 }]) {
    test(`phone navigation wraps complete names and paths at ${viewport.width}px and closes where it opened`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      const { state } = await setup(page, { longLabels: true });
      const header = page.locator(".workspace-header");
      const opener = header.getByRole("button", { name: "Open sessions", exact: true });
      const sidebar = page.locator(".sidebar");
      const closer = sidebar.getByRole("button", { name: "Close sessions", exact: true });
      for (const collapsed of [false, true]) {
        if (collapsed) await header.getByRole("button", { name: "Collapse chat header" }).tap();
        const openBox = (await opener.boundingBox())!;
        await opener.tap();
        await expect.poll(async () => (await sidebar.boundingBox())!.x).toBeCloseTo(0, 0);
        const closeBox = (await closer.boundingBox())!;
        expect(closeBox.x).toBeCloseTo(openBox.x, 0);
        expect(closeBox.y).toBeCloseTo(openBox.y, 0);
        expect(closeBox.width).toBeGreaterThanOrEqual(44);
        expect(closeBox.height).toBeGreaterThanOrEqual(44);
        const current = sidebar.locator("[data-session-id='current']");
        await current.scrollIntoViewIfNeeded();
        await expect(current.locator(".session-main strong")).toHaveText(state.sessions[0].title);
        await expect(current.locator(".session-cwd")).toHaveText(state.sessions[0].cwd);
        await expect(current.locator(".session-location em")).toHaveCount(0);
        const titles = await current.locator(".session-main strong, .session-cwd").evaluateAll((elements) => elements.map((element) => {
          const rect = element.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(element);
          const text = range.getBoundingClientRect();
          return {
            whiteSpace: getComputedStyle(element).whiteSpace, overflow: getComputedStyle(element).textOverflow,
            height: rect.height, lineHeight: parseFloat(getComputedStyle(element).lineHeight),
            fits: text.right <= rect.right + 1 && text.bottom <= rect.bottom + 1,
          };
        }));
        expect(titles.every((entry) => entry.whiteSpace === "normal" && entry.overflow !== "ellipsis" && entry.fits)).toBe(true);
        expect(titles[0].height).toBeGreaterThan(titles[0].lineHeight * 1.5);
        const pinned = sidebar.locator("[data-session-id='pin']");
        await pinned.scrollIntoViewIfNeeded();
        await expect(pinned.locator(".session-location em")).toHaveText(state.sessions[3].folder!);
        expect(await pinned.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        await sidebar.locator(".session-list").evaluate((element) => { element.scrollTop = 0; });
        if (!collapsed) await page.screenshot({ path: testInfo.outputPath(`readable-session-list-${viewport.width}.png`) });
        await closer.tap();
        await expect(opener).toBeFocused();
        await expect(sidebar).not.toHaveClass(/open/);
      }
    });

    test(`phone sidebar fills ${viewport.width}px and prioritizes the scrollable session list`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await setup(page);
      const composer = page.locator(".parent-session-view .composer textarea");
      await expect(composer).toBeEnabled();
      await composer.fill("Keep my mobile draft");
      await page.getByRole("button", { name: "Open sessions", exact: true }).tap();
      const sidebar = page.locator(".sidebar");
      await expect(sidebar).toHaveClass("sidebar open");
      await expect.poll(async () => (await sidebar.boundingBox())!.x).toBeCloseTo(0, 0);
      const box = (await sidebar.boundingBox())!;
      expect(box.width).toBe(viewport.width);
      expect(box.height).toBe(viewport.height);
      const list = (await sidebar.locator(".session-list").boundingBox())!;
      expect(list.y).toBeLessThanOrEqual(164);
      expect(list.height / viewport.height).toBeGreaterThan(.60);
      const newButton = sidebar.getByRole("button", { name: /New session/ });
      const scheduled = sidebar.getByRole("button", { name: "Scheduled tasks", exact: true });
      expect((await newButton.boundingBox())!.y).toEqual((await scheduled.boundingBox())!.y);
      for (const control of [newButton, scheduled, sidebar.getByRole("textbox", { name: "Search sessions" }).locator(".."),
        sidebar.getByRole("combobox", { name: "Session view" }), sidebar.getByRole("button", { name: "Close sessions", exact: true })]) {
        expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
      const active = sidebar.locator("[data-session-id='current']");
      await active.scrollIntoViewIfNeeded();
      const actions = await active.locator(".session-action").evaluateAll((buttons) => buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        return { width: rect.width, height: rect.height, right: rect.right };
      }));
      expect(actions.every((rect) => rect.width >= 44 && rect.height >= 44 && rect.right <= viewport.width)).toBe(true);
      expect(await sidebar.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`phone-sidebar-${viewport.width}.png`) });
      await sidebar.getByRole("textbox", { name: "Search sessions" }).fill("Review SDK");
      await expect(sidebar.locator(".session-item")).toHaveCount(1);
      await sidebar.getByRole("button", { name: "Close sessions", exact: true }).tap();
      await expect(sidebar).not.toHaveClass(/open/);
      await expect(composer).toHaveValue("Keep my mobile draft");
      await page.getByRole("button", { name: "Open sessions", exact: true }).tap();
      await sidebar.locator(".session-open").tap();
      await expect(sidebar).not.toHaveClass(/open/);
      await expect(page.getByRole("heading", { name: "Review SDK references", exact: true })).toBeVisible();
    });
  }
});

test("resizing the desktop sidebar gives full titles and paths room instead of retaining a narrow preview", async ({ page }) => {
  const { state } = await setup(page, { longLabels: true });
  const current = page.locator("[data-session-id='current']");
  await current.scrollIntoViewIfNeeded();
  const title = current.locator(".session-main strong");
  const cwd = current.locator(".session-cwd");
  const narrow = (await title.boundingBox())!;
  await expect(cwd).toHaveText(state.sessions[0].cwd);
  await page.getByRole("separator", { name: "Resize sessions sidebar" }).press("End");
  await expect(page.getByRole("separator", { name: "Resize sessions sidebar" })).toHaveAttribute("aria-valuenow", "560");
  const wide = (await title.boundingBox())!;
  expect(wide.width).toBeGreaterThan(narrow.width + 200);
  expect(wide.height).toBeLessThan(narrow.height);
  for (const text of [title, cwd]) {
    expect(await text.evaluate((element) => element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1)).toBe(true);
  }
});

test("desktop sidebar drag and keyboard sizing persist, reset, and stay bounded beside every terminal layout", async ({ page }, testInfo) => {
  const { state } = await setup(page);
  const sidebar = page.locator(".sidebar");
  const divider = page.getByRole("separator", { name: "Resize sessions sidebar" });
  await expect(divider).toHaveAttribute("aria-valuenow", "272");
  const original = (await divider.boundingBox())!;
  await page.mouse.move(original.x + 3, original.y + 150);
  await page.mouse.down();
  await page.mouse.move(original.x + 123, original.y + 150, { steps: 8 });
  await page.mouse.up();
  await expect(divider).toHaveAttribute("aria-valuenow", "392");
  expect((await sidebar.boundingBox())!.width).toBe(392);
  await divider.press("Shift+ArrowRight");
  await expect(divider).toHaveAttribute("aria-valuenow", "442");
  await page.reload();
  await expect(divider).toHaveAttribute("aria-valuenow", "442");
  await expect(page.locator(".parent-session-view .composer textarea")).toBeEnabled();
  await page.getByTitle("Open terminal", { exact: true }).click();
  await expect(page.locator(".terminal-title strong")).toHaveText("Mock shell");
  for (const dock of ["above", "below", "beside"]) {
    await page.getByRole("button", { name: `Terminal ${dock} chat`, exact: true }).click();
    expect((await sidebar.boundingBox())!.width).toBe(442);
    const terminal = (await page.locator(".terminal-pane").boundingBox())!;
    const chat = (await page.locator(".workspace").boundingBox())!;
    expect(chat.x).toBe(442);
    expect(terminal.x + terminal.width).toBeLessThanOrEqual(1441);
  }
  expect(state.terminalConnections).toBe(1);
  await page.screenshot({ path: testInfo.outputPath("resized-sidebar-terminal.png") });
  await page.setViewportSize({ width: 821, height: 900 });
  await expect(divider).toHaveAttribute("aria-valuenow", "246");
  const narrowTerminal = (await page.locator(".terminal-pane").boundingBox())!;
  expect(narrowTerminal.x + narrowTerminal.width).toBeLessThanOrEqual(822);
  expect(await page.evaluate(() => localStorage.getItem("copilot-sessions.sidebar-width"))).toBe("442");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(divider).toHaveAttribute("aria-valuenow", "442");
  await divider.press("Home");
  await expect(divider).toHaveAttribute("aria-valuenow", "200");
  await divider.press("End");
  await expect(divider).toHaveAttribute("aria-valuenow", "560");
  await divider.dblclick();
  await expect(divider).toHaveAttribute("aria-valuenow", "272");
  expect(await page.evaluate(() => localStorage.getItem("copilot-sessions.sidebar-width"))).toBeNull();
  await divider.press("ArrowRight");
  await divider.press("Enter");
  await expect(divider).toHaveAttribute("aria-valuenow", "272");
});

test("sidebar storage failures are visible and a desktop preference never constrains the phone drawer", async ({ page }) => {
  await page.addInitScript(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "copilot-sessions.sidebar-width") throw new Error("Storage unavailable");
      set.call(this, key, value);
    };
  });
  await setup(page);
  const divider = page.getByRole("separator", { name: "Resize sessions sidebar" });
  await divider.press("Shift+ArrowRight");
  await expect(divider).toHaveAttribute("aria-valuenow", "322");
  await expect(page.locator(".sidebar [role='alert']")).toContainText("Could not save sidebar width");
  await page.setViewportSize({ width: 768, height: 900 });
  await expect(divider).toBeHidden();
  await page.getByRole("button", { name: "Open sessions", exact: true }).click();
  expect((await page.locator(".sidebar").boundingBox())!.width).toBeCloseTo(310, 1);
  await page.setViewportSize({ width: 390, height: 600 });
  expect((await page.locator(".sidebar").boundingBox())!.width).toBeCloseTo(390, 1);
  expect((await page.locator(".sidebar").boundingBox())!.height).toBeCloseTo(600, 1);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(divider).toHaveAttribute("aria-valuenow", "322");
});
