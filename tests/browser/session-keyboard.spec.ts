import { test, expect, type Page } from "@playwright/test";

async function setup(page: Page, options: { cold?: boolean; processing?: boolean } = {}) {
  const row = (sessionId: string, extra = {}) => ({ sessionId, title: `Session ${sessionId}`, cwd: "Q:\\example",
    model: "model", isActive: true, isRemote: false, pinned: false, archived: false, tags: [], startTime: "", modifiedTime: "", ...extra });
  const sessions = [row("a", { folder: "Z" }), row("b", { pinned: true, isActive: !options.cold }),
    row("c", { folder: "A", isActive: !options.cold }), row("old", { archived: true })];
  const message = (id: string, content: string) => ({ id, type: "user.message", timestamp: "", data: { content, source: "user" } });
  const state = { requests: [] as { command: string; args: Record<string, unknown> }[], terminalInputs: [] as string[] };
  await page.addInitScript(() => {
    class Events extends EventTarget {
      onopen: (() => void) | null = null;
      constructor() { super(); setTimeout(() => this.onopen?.(), 0); }
      close() {}
    }
    Object.defineProperty(window, "EventSource", { value: Events });
  });
  await page.routeWebSocket("**/api/terminal**", (socket) => {
    socket.send(JSON.stringify({ type: "ready", cwd: "Q:\\example", shell: "Keyboard shell", hasControl: true, viewers: 1 }));
    socket.onMessage((data) => {
      const message = JSON.parse(String(data));
      if (message.type === "input") state.terminalInputs.push(message.data);
    });
  });
  await page.route("**/api/**", (route) => {
    const command = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const args = route.request().postDataJSON() ?? {};
    state.requests.push({ command, args });
    let result: unknown;
    switch (command) {
      case "list_sessions": result = sessions; break;
      case "resume_session": {
        const session = sessions.find((session) => session.sessionId === args.sessionId)!;
        session.isActive = true;
        result = session; break;
      }
      case "runtime_status": result = { connected: true, acceptingWork: true }; break;
      case "session_processing": result = options.processing ?? false; break;
      case "session_state": result = { sessionId: args.sessionId, processing: options.processing ?? false, mode: "interactive" }; break;
      case "abort_session": result = null; break;
      case "get_session_profile": result = { sessionId: args.sessionId, profile: null, applying: false, configurationBlocked: false, requiresReconnect: false, error: null }; break;
      case "pending_permissions": case "pending_interactions": case "subagent_context": result = []; break;
      case "queue_items": result = { items: [], steeringMessages: [] }; break;
      case "agent_tasks": result = { sessionId: args.sessionId, tasks: [] }; break;
      case "git_repository": result = { isRepository: false }; break;
      case "session_history_window": result = {
        events: [message(`${args.sessionId}-first`, `first ${args.sessionId}\nsecond line`),
          message(`${args.sessionId}-last`, `latest ${args.sessionId}`)],
        hasMore: false, cursor: "", loadedPages: 1, humanMessages: 2,
      }; break;
      case "available_models": result = { models: [] }; break;
      case "send_message": result = "accepted"; break;
      default: return route.fulfill({ status: 404, body: `Unexpected ${command}` });
    }
    return route.fulfill({ json: result });
  });
  await page.goto("/?session=a");
  const prompt = page.locator(".parent-session-view .composer textarea");
  await expect(prompt).toBeEnabled();
  await expect(page.locator(".message.user").last()).toContainText("latest a");
  return { state, prompt };
}

test("Ctrl Alt Down and Up cycle sidebar order, wrap, and keep each session draft", async ({ page }) => {
  const { state, prompt } = await setup(page);
  const title = page.locator(".workspace-header h1");
  expect(await page.locator(".session-item").evaluateAll((items) => items.map((item) => item.getAttribute("data-session-id")))).toEqual(["b", "c", "a"]);
  await prompt.fill("Draft for A");
  await prompt.press("Control+Alt+ArrowDown");
  await expect(title).toHaveText("Session b");
  await expect(prompt).toBeEnabled();
  await expect(prompt).toBeFocused();
  await prompt.fill("Draft for B");
  await prompt.press("Control+Alt+ArrowDown");
  await expect(title).toHaveText("Session c");
  await expect(prompt).toBeEnabled();
  await prompt.press("Control+Alt+ArrowUp");
  await expect(title).toHaveText("Session b");
  await expect(prompt).toHaveValue("Draft for B");
  await expect(prompt).toBeEnabled();
  await prompt.press("Control+Alt+ArrowUp");
  await expect(title).toHaveText("Session a");
  await expect(prompt).toHaveValue("Draft for A");
  expect(state.requests.some((request) => ["send_message", "set_session_mode", "abort_session"].includes(request.command))).toBe(false);
});

test("forwarded browser Ctrl Tab and Ctrl Shift Tab never switch sessions or consume the key", async ({ page }) => {
  const { state, prompt } = await setup(page);
  await prompt.fill("Keep browser tab and session independent");
  for (const shiftKey of [false, true]) {
    const prevented = await prompt.evaluate((element, shiftKey) => {
      const event = new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, shiftKey, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    }, shiftKey);
    expect(prevented).toBe(false);
    await expect(page.locator(".workspace-header h1")).toHaveText("Session a");
    await expect(prompt).toHaveValue("Keep browser tab and session independent");
  }
  expect(state.requests.filter((request) => request.command === "resume_session")).toHaveLength(1);
});

test("Ctrl Alt Up/Down respect list filters and work from terminal focus without sending shell input", async ({ page }) => {
  const { state, prompt } = await setup(page);
  await prompt.press("Control+Alt+ArrowUp");
  await expect(page.locator(".workspace-header h1")).toHaveText("Session c");
  await expect(prompt).toBeEnabled();
  await page.getByRole("textbox", { name: "Search sessions" }).fill("Session b");
  await page.keyboard.press("Control+Alt+ArrowDown");
  await expect(page.locator(".workspace-header h1")).toHaveText("Session b");
  await expect(prompt).toBeEnabled();
  const before = state.requests.filter((request) => request.command === "resume_session").length;
  await prompt.press("Control+Alt+ArrowDown");
  expect(state.requests.filter((request) => request.command === "resume_session")).toHaveLength(before);
  await page.getByRole("textbox", { name: "Search sessions" }).fill("");
  await page.getByTitle("Open terminal", { exact: true }).click();
  const terminal = page.locator(".xterm-helper-textarea");
  await expect(terminal).toBeAttached();
  await terminal.focus();
  await terminal.press("Control+Alt+ArrowDown");
  await expect(page.locator(".workspace-header h1")).toHaveText("Session c");
  expect(state.terminalInputs).toEqual([]);
  expect(state.requests.some((request) => request.command === "resume_session" && request.args.sessionId === "old")).toBe(false);
});

test("session cycling does not escape dialogs or repeat on a held key", async ({ page }) => {
  const { state, prompt } = await setup(page);
  await prompt.dispatchEvent("keydown", { key: "ArrowDown", ctrlKey: true, altKey: true, repeat: true, bubbles: true });
  await prompt.dispatchEvent("keydown", { key: "ArrowDown", ctrlKey: true, altKey: true, isComposing: true, bubbles: true });
  await expect(page.locator(".workspace-header h1")).toHaveText("Session a");
  await page.getByRole("button", { name: "Additional options", exact: true }).click();
  const options = page.getByRole("dialog", { name: "Additional options", exact: true });
  await options.getByRole("button", { name: "Close additional options" }).press("Control+Alt+ArrowDown");
  await options.getByRole("button", { name: "Close additional options" }).press("Control+Tab");
  await expect(page.locator(".workspace-header h1")).toHaveText("Session a");
  expect(state.requests.filter((request) => request.command === "resume_session")).toHaveLength(1);
});

test("Up and Down browse this session's history, retain edits and attachments, and return to the unfinished draft", async ({ page }) => {
  const { state, prompt } = await setup(page);
  await prompt.fill("Unfinished draft");
  await page.locator('.composer input[type="file"]').setInputFiles({ name: "draft.txt", mimeType: "text/plain", buffer: Buffer.from("draft attachment") });
  await expect(page.locator(".attachment-chip")).toContainText("draft.txt");
  await prompt.evaluate((element) => element.setSelectionRange(3, 3));
  await prompt.press("ArrowUp");
  await expect(prompt).toHaveValue("latest a");
  await prompt.fill("edited latest a");
  await prompt.press("ArrowUp");
  await expect(prompt).toHaveValue("first a\nsecond line");
  await prompt.press("ArrowUp");
  await expect(prompt).toHaveValue("first a\nsecond line");
  await prompt.press("ArrowDown");
  await expect(prompt).toHaveValue("first a\nsecond line");
  await prompt.press("Control+End");
  await prompt.press("ArrowDown");
  await expect(prompt).toHaveValue("edited latest a");
  await prompt.press("ArrowDown");
  await expect(prompt).toHaveValue("Unfinished draft");
  await expect(page.locator(".attachment-chip")).toContainText("draft.txt");
  await prompt.press("Control+Alt+ArrowDown");
  await expect(prompt).toBeEnabled();
  await prompt.press("ArrowUp");
  await expect(prompt).toHaveValue("latest b");
  await prompt.press("ArrowDown");
  await expect(prompt).toHaveValue("");
  expect(state.requests.some((request) => request.command === "send_message")).toBe(false);
});

test("history navigation leaves multiline, soft-wrapped, selected, modified, and composing text movement alone", async ({ page }) => {
  const { prompt } = await setup(page);
  const multiline = "first line\nmiddle line\nlast line";
  await prompt.fill(multiline);
  await prompt.evaluate((element) => element.setSelectionRange(15, 15));
  await prompt.press("ArrowUp");
  await expect(prompt).toHaveValue(multiline);
  await prompt.selectText();
  await prompt.press("ArrowUp");
  await expect(prompt).toHaveValue(multiline);
  await prompt.press("Shift+ArrowUp");
  await prompt.dispatchEvent("keydown", { key: "ArrowUp", isComposing: true, bubbles: true });
  await expect(prompt).toHaveValue(multiline);
  const wrapped = "wrapped words ".repeat(200);
  await prompt.fill(wrapped);
  await prompt.evaluate((element) => element.setSelectionRange(900, 900));
  await prompt.press("ArrowUp");
  await expect(prompt).toHaveValue(wrapped);
  await prompt.press("ArrowDown");
  await expect(prompt).toHaveValue(wrapped);
  await prompt.evaluate((element) => element.setSelectionRange(5, 5));
  await prompt.press("ArrowUp");
  await expect(prompt).toHaveValue("latest a");
  await prompt.press("ArrowDown");
  await expect(prompt).toHaveValue(wrapped);
});

test.describe("cold keyboard previews", () => {
  test("keyboard cycling previews inactive sessions without reading their history or initializing until Enter", async ({ page }) => {
    const { state, prompt } = await setup(page, { cold: true });
    await prompt.fill("Keep A draft untouched");
    const preview = page.getByRole("region", { name: "Keyboard session preview", exact: true });
    await prompt.press("Control+Alt+ArrowDown");
    await expect(preview.getByRole("heading", { name: "Session b", exact: true })).toBeVisible();
    await expect(preview.getByRole("button", { name: "Open session", exact: true })).toBeFocused();
    await expect(page.locator("[data-session-id='b']")).toHaveClass(/keyboard-preview/);
    await expect(prompt).toBeHidden();
    await page.keyboard.press("Control+Alt+ArrowDown");
    await expect(preview.getByRole("heading", { name: "Session c", exact: true })).toBeVisible();
    expect(state.requests.some((request) => ["resume_session", "session_history_window", "session_initialization"].includes(request.command)
      && ["b", "c"].includes(String(request.args.sessionId)))).toBe(false);
    await page.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);
    await expect(prompt).toBeVisible();
    await expect(prompt).toHaveValue("Keep A draft untouched");
    await expect(prompt).toBeFocused();
    await prompt.press("Control+Alt+ArrowDown");
    await page.keyboard.press("Enter");
    await expect(preview).toHaveCount(0);
    await expect(page.locator(".workspace-header h1")).toHaveText("Session b");
    await expect(prompt).toBeEnabled();
    expect(state.requests.filter((request) => request.command === "resume_session" && request.args.sessionId === "b")).toHaveLength(1);
    expect(state.requests.some((request) => request.command === "resume_session" && request.args.sessionId === "c")).toBe(false);
    expect(state.requests.some((request) => ["send_message", "abort_session"].includes(request.command))).toBe(false);
  });

  test("cycling past cold previews returns to the ready session and clicking cold sessions opens immediately", async ({ page }) => {
    const { state, prompt } = await setup(page, { cold: true });
    const preview = page.getByRole("region", { name: "Keyboard session preview", exact: true });
    await prompt.press("Control+Alt+ArrowDown");
    await expect(preview).toBeVisible();
    await page.keyboard.press("Control+Alt+ArrowDown");
    await page.keyboard.press("Control+Alt+ArrowDown");
    await expect(preview).toHaveCount(0);
    await expect(page.locator(".workspace-header h1")).toHaveText("Session a");
    expect(state.requests.filter((request) => request.command === "resume_session")).toHaveLength(1);
    await page.locator("[data-session-id='b'] .session-open").click();
    await expect(page.locator(".workspace-header h1")).toHaveText("Session b");
    await expect(prompt).toBeEnabled();
    await expect(preview).toHaveCount(0);
    await prompt.press("Control+Alt+ArrowDown");
    await expect(preview.getByRole("heading", { name: "Session c", exact: true })).toBeVisible();
    await page.locator("[data-session-id='c'] .session-open").click();
    await expect(preview).toHaveCount(0);
    await expect(page.locator(".workspace-header h1")).toHaveText("Session c");
    await expect(prompt).toBeEnabled();
    await prompt.press("Control+Alt+ArrowUp");
    await expect(preview).toHaveCount(0);
    await expect(page.locator(".workspace-header h1")).toHaveText("Session b");
  });

  test("cold preview from terminal focus preserves the terminal and cancellation never sends a shell command", async ({ page }) => {
    const { state } = await setup(page, { cold: true });
    await page.getByTitle("Open terminal", { exact: true }).click();
    const terminal = page.locator(".xterm-helper-textarea");
    await terminal.focus();
    await terminal.press("Control+Alt+ArrowDown");
    const preview = page.getByRole("region", { name: "Keyboard session preview", exact: true });
    await expect(preview).toBeVisible();
    await expect(preview.getByRole("button", { name: "Open session", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);
    await expect(page.locator(".terminal-title strong")).toHaveText("Keyboard shell");
    expect(state.terminalInputs).toEqual([]);
    expect(state.requests.some((request) => request.command === "resume_session" && request.args.sessionId === "b")).toBe(false);
  });
});

test.describe("customizable shortcuts", () => {
  async function openShortcutEditor(page: Page) {
    await page.locator(".daemon-state").click();
    await page.getByRole("button", { name: /^Keyboard shortcuts/ }).click();
    return page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });
  }

  test("cleared shortcuts stay Unbound across reload and remapping replaces defaults without firing during recording", async ({ page }) => {
    const { state, prompt } = await setup(page);
    let editor = await openShortcutEditor(page);
    let next = editor.getByRole("region", { name: "Next session", exact: true });
    await next.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(next).toContainText("Unbound");
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("copilot-sessions.keybindings")!).bindings.nextSession)).toEqual([]);
    await editor.getByRole("button", { name: "Close", exact: true }).click();
    await prompt.press("Control+Alt+ArrowDown");
    await expect(page.locator(".workspace-header h1")).toHaveText("Session a");
    await page.reload();
    await expect(prompt).toBeEnabled();
    editor = await openShortcutEditor(page);
    next = editor.getByRole("region", { name: "Next session", exact: true });
    await expect(next).toContainText("Unbound");
    const resumes = state.requests.filter((request) => request.command === "resume_session").length;
    await next.getByRole("button", { name: "Change", exact: true }).click();
    await editor.getByRole("textbox", { name: "Press shortcut keys", exact: true }).press("F8");
    await expect(next.locator("kbd")).toHaveText("F8");
    await expect(next.getByRole("button", { name: "Change", exact: true })).toBeFocused();
    expect(state.requests.filter((request) => request.command === "resume_session")).toHaveLength(resumes);
    await editor.getByRole("button", { name: "Close", exact: true }).click();
    await prompt.press("Control+Alt+ArrowDown");
    await expect(page.locator(".workspace-header h1")).toHaveText("Session a");
    await prompt.press("F8");
    await expect(page.locator(".workspace-header h1")).toHaveText("Session b");
    await expect(prompt).toBeEnabled();
    editor = await openShortcutEditor(page);
    next = editor.getByRole("region", { name: "Next session", exact: true });
    await next.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(next).toContainText("Ctrl Alt Down");
    await editor.getByRole("button", { name: "Close", exact: true }).click();
    await prompt.press("F8");
    await expect(page.locator(".workspace-header h1")).toHaveText("Session b");
    await prompt.press("Control+Alt+ArrowDown");
    await expect(page.locator(".workspace-header h1")).toHaveText("Session c");
  });

  test("conflicting bindings are rejected, individual aliases can be removed, and reset all restores defaults", async ({ page }) => {
    const { state } = await setup(page);
    const editor = await openShortcutEditor(page);
    const next = editor.getByRole("region", { name: "Next session", exact: true });
    await next.getByRole("button", { name: "Change", exact: true }).click();
    const record = editor.getByRole("textbox", { name: "Press shortcut keys", exact: true });
    await record.press("Control+t");
    await expect(editor.getByRole("alert")).toContainText("already assigned");
    expect(await page.evaluate(() => localStorage.getItem("copilot-sessions.keybindings"))).toBeNull();
    await record.press("Escape");
    await expect(editor).toBeVisible();
    await expect(record).toHaveCount(0);
    await expect(next.getByRole("button", { name: "Change", exact: true })).toBeFocused();
    await next.getByRole("button", { name: "Remove Ctrl Tab from Next session", exact: true }).click();
    await expect(next.locator("kbd")).toHaveCount(1);
    await expect(next.locator("kbd")).toHaveText("Ctrl Alt Down");
    await next.getByRole("button", { name: "Add binding", exact: true }).click();
    await record.press("F8");
    await expect(next.locator("kbd")).toHaveCount(2);
    await editor.getByRole("button", { name: "Reset all shortcuts", exact: true }).click();
    await expect(next.locator("kbd")).toHaveCount(2);
    await expect(next).not.toContainText("F8");
    expect(await page.evaluate(() => localStorage.getItem("copilot-sessions.keybindings"))).toBeNull();
    expect(state.requests.some((request) => ["send_message", "abort_session"].includes(request.command))).toBe(false);
  });

  test("unbinding Stop, prompt history, and Steer removes their default behavior but buttons and typing still work", async ({ page }) => {
    const { state, prompt } = await setup(page, { processing: true });
    await expect(page.locator(".composer-status strong")).toHaveText("Copilot is working");
    const editor = await openShortcutEditor(page);
    for (const name of ["Stop current turn", "Earlier prompt", "Steer the running turn"]) {
      await editor.getByRole("region", { name, exact: true }).getByRole("button", { name: "Clear", exact: true }).click();
    }
    await editor.getByRole("button", { name: "Close", exact: true }).click();
    await prompt.fill("Unsent");
    await prompt.press("Escape");
    await prompt.press("Control+.");
    await prompt.press("ArrowUp");
    await prompt.press("Control+Enter");
    await expect(prompt).toHaveValue("Unsent");
    expect(state.requests.some((request) => ["send_message", "abort_session"].includes(request.command))).toBe(false);
    await page.locator(".composer-status").getByRole("button", { name: "Stop", exact: true }).click();
    await expect.poll(() => state.requests.filter((request) => request.command === "abort_session").length).toBe(1);
  });

  test("shortcut settings sync across windows and persistence errors remain visible without pretending they were saved", async ({ page }) => {
    const { prompt } = await setup(page);
    const editor = await openShortcutEditor(page);
    await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", {
      key: "copilot-sessions.keybindings", newValue: JSON.stringify({ version: 1, bindings: { nextSession: [] } }), storageArea: localStorage,
    })));
    await expect(editor.getByRole("region", { name: "Next session", exact: true })).toContainText("Unbound");
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === "copilot-sessions.keybindings") throw new Error("Synthetic storage denial");
        return original.call(this, key, value);
      };
    });
    await editor.getByRole("region", { name: "Toggle terminal", exact: true }).getByRole("button", { name: "Clear", exact: true }).click();
    await expect(editor.getByRole("alert")).toContainText("Changes apply only to this window");
    await editor.getByRole("button", { name: "Close", exact: true }).click();
    await prompt.press("Control+Shift+t");
    await expect(page.locator(".terminal-pane")).toHaveCount(0);
  });

  test("invalid shortcut preferences can be reset explicitly instead of trapping the editor", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("copilot-sessions.keybindings", "{invalid"));
    await setup(page);
    const editor = await openShortcutEditor(page);
    await expect(editor.getByRole("alert")).toContainText("Could not load shortcuts");
    await editor.getByRole("button", { name: "Reset all shortcuts", exact: true }).click();
    await expect(editor.getByRole("alert")).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("copilot-sessions.keybindings"))).toBeNull();
  });

  test.describe("touch layout shortcut settings", () => {
    test.use({ hasTouch: true, isMobile: true });
    test("desktop-width tablets keep the editor, while phone layout has no entry point or hidden editor", async ({ page }) => {
      await page.setViewportSize({ width: 1024, height: 900 });
      await setup(page);
      const editor = await openShortcutEditor(page);
      await expect(editor).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(editor).toHaveCount(0);
      await page.getByRole("button", { name: "Open sessions", exact: true }).click();
      await page.locator(".daemon-state").click();
      await expect(page.getByRole("button", { name: /^Keyboard shortcuts/ })).toHaveCount(0);
      await page.getByRole("button", { name: "Close settings", exact: true }).click();
      await page.getByRole("button", { name: "Close sessions", exact: true }).first().click();
      await page.locator(".workspace-header h1").click();
      await page.keyboard.press("?");
      await expect(editor).toHaveCount(0);
    });
  });
});

test("Ctrl R is not intercepted and keyboard help describes the new controls", async ({ page }) => {
  const { prompt } = await setup(page);
  await prompt.fill("Keep this draft");
  const intercepted = await prompt.evaluate((element) => {
    const event = new KeyboardEvent("keydown", { key: "r", ctrlKey: true, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(intercepted).toBe(false);
  await expect(prompt).toHaveValue("Keep this draft");
  await page.locator(".daemon-state").click();
  await page.getByRole("button", { name: /^Keyboard shortcuts/ }).click();
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });
  await expect(help).toContainText("Ctrl Tab");
  await expect(help).toContainText("Ctrl Shift Tab");
  await expect(help).toContainText("Ctrl Alt Down");
  await expect(help).toContainText("Ctrl Alt Up");
  await expect(help).toContainText("Earlier prompt");
  await expect(help).not.toContainText("Ctrl R");
});
