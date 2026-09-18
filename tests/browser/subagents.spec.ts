import { test, expect, type Page } from "@playwright/test";

const session = (id: string) => ({
  sessionId: id, title: `Session ${id}`, isActive: true, isRemote: false, pinned: false, tags: [],
  startTime: "", modifiedTime: "", cwd: "Q:\\example", model: "parent-model",
});
const task = (id: string, name: string, status: string) => ({
  id, name, status, agentType: "task", toolCallId: `tool-${id}`, model: "child-model",
  canMessage: status === "running" || status === "idle", unavailableReason: status === "completed" ? "This agent has completed." : undefined,
});
const event = (id: string, type: string, content: string, agentId?: string) => ({
  id, type, timestamp: "2026-09-14T22:00:00Z", agentId, data: { content, messageId: id },
});

async function setup(page: Page) {
  const sent: Record<string, unknown>[] = [];
  const requests: { command: string; sessionId: string }[] = [];
  const tasks: Record<string, ReturnType<typeof task>[]> = {
    a: [task("shared-id", "Builder", "running"), task("idle", "Reviewer", "idle"), task("done", "Old agent", "completed")],
    b: [task("shared-id", "Builder", "idle")],
  };
  let rejectSend = false;
  await page.addInitScript(() => {
    class TestEventSource extends EventTarget {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      listener = (event: Event) => {
        if (event instanceof CustomEvent) this.dispatchEvent(new MessageEvent("session-event", { data: JSON.stringify(event.detail) }));
      };
      constructor() {
        super();
        window.addEventListener("test-daemon", this.listener);
        setTimeout(() => this.onopen?.(), 0);
      }
      close() { window.removeEventListener("test-daemon", this.listener); }
    }
    Object.defineProperty(window, "EventSource", { value: TestEventSource });
  });
  await page.route("**/api/**", async (route) => {
    const command = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const args = route.request().postDataJSON() ?? {};
    requests.push({ command, sessionId: args.sessionId });
    let result: unknown;
    switch (command) {
      case "list_sessions": result = [session("a"), session("b")]; break;
      case "resume_session": result = session(args.sessionId); break;
      case "runtime_status": result = { connected: true, acceptingWork: true, activeSessions: 2 }; break;
      case "session_state": result = { sessionId: args.sessionId, mode: "interactive", processing: false }; break;
      case "pending_permissions":
      case "pending_interactions":
      case "subagent_context": result = []; break;
      case "queue_items": result = { items: [], steeringMessages: [] }; break;
      case "delete_session": result = null; break;
      case "session_references": result = { commands: {}, skills: {}, mcp: {}, mcpTools: {}, tools: {}, instructions: {}, contextAttribution: {}, tasks: {} }; break;
      case "context_attribution": result = { contextAttribution: null }; break;
      case "git_repository": result = { isRepository: true, repoRoot: "Q:\\example" }; break;
      case "session_history_window": result = {
        events: [event("root", "user.message", "Parent conversation")], hasMore: false, cursor: "",
        loadedPages: 1, humanMessages: 1,
      }; break;
      case "agent_tasks": result = { sessionId: args.sessionId, tasks: tasks[args.sessionId] }; break;
      case "agent_history": result = {
        sessionId: args.sessionId, taskId: args.taskId, agentId: `agent-${args.sessionId}-${args.taskId}`,
        events: [event("child-answer", "assistant.message", `Hello from ${args.sessionId}/${args.taskId}`, `agent-${args.sessionId}-${args.taskId}`)],
        cursor: null, hasMore: false,
      }; break;
      case "send_agent_message":
        sent.push(args);
        result = rejectSend ? { sent: false, error: "Agent is no longer accepting messages" } : { sent: true };
        break;
      default: return route.fulfill({ status: 404, json: { error: `Unexpected command ${command}` } });
    }
    await route.fulfill({ json: result });
  });
  await page.goto("/?session=a");
  await expect(page.locator(".parent-session-view .composer textarea")).toBeEnabled();
  return { sent, requests, tasks, reject: () => { rejectSend = true; } };
}

async function expand(page: Page, id: string) {
  await page.getByRole("button", { name: `Subagents for Session ${id}`, exact: true }).click();
  return page.locator(`#subagents-${id}`);
}

test("each session expands only its own active agents, with finished agents opt-in", async ({ page }) => {
  const state = await setup(page);
  expect(state.requests.filter((request) => request.command === "agent_tasks")).toHaveLength(0);
  const a = await expand(page, "a");
  await expect(a.getByRole("button", { name: /Builder/ })).toBeVisible();
  await expect(a.getByRole("button", { name: /Reviewer/ })).toBeVisible();
  await expect(a.getByRole("button", { name: /Old agent/ })).toHaveCount(0);
  const b = await expand(page, "b");
  await expect(b.getByRole("button", { name: /Builder/ })).toBeVisible();
  await expect(b.getByRole("button", { name: /Reviewer/ })).toHaveCount(0);
  await a.getByLabel("Show finished").check();
  await expect(a.getByRole("button", { name: /Old agent/ })).toBeVisible();
  await page.getByRole("button", { name: "Subagents for Session a", exact: true }).click();
  await expect(a).toBeHidden();
  await expect(b).toBeVisible();
});

test("child navigation preserves the parent draft and routes direct messages by parent and task", async ({ page }) => {
  const state = await setup(page);
  await page.locator(".parent-session-view .composer textarea").fill("Keep the parent draft");
  const a = await expand(page, "a");
  await a.getByRole("button", { name: /Builder/ }).click();
  await expect(page.getByRole("heading", { name: "Builder", exact: true })).toBeVisible();
  await expect(page.locator(".agent-conversation .message.assistant")).toContainText("Hello from a/shared-id");
  await page.getByRole("textbox", { name: "Message Builder", exact: true }).fill("Guidance only for A");
  await page.getByRole("textbox", { name: "Message Builder", exact: true }).press("Enter");
  await expect.poll(() => state.sent.length).toBe(1);
  expect(state.sent[0]).toEqual({ sessionId: "a", taskId: "shared-id", message: "Guidance only for A" });
  expect(state.requests.filter((request) => request.command === "send_message")).toHaveLength(0);
  await page.getByRole("button", { name: "Back to parent" }).click();
  await expect(page.locator(".parent-session-view .composer textarea")).toHaveValue("Keep the parent draft");
  const b = await expand(page, "b");
  await b.getByRole("button", { name: /Builder/ }).click();
  await expect(page.locator(".agent-conversation .message.assistant")).toContainText("Hello from b/shared-id");
  await page.getByRole("textbox", { name: "Message Builder", exact: true }).fill("Guidance only for B");
  await page.getByRole("textbox", { name: "Message Builder", exact: true }).press("Enter");
  await expect.poll(() => state.sent.length).toBe(2);
  expect(state.sent[1].sessionId).toBe("b");
});

test("live child events exclude parent/sibling output and failed sends keep drafts", async ({ page }) => {
  const state = await setup(page);
  const a = await expand(page, "a");
  await a.getByRole("button", { name: /Builder/ }).click();
  await expect(page.locator(".agent-conversation .message.assistant")).toBeVisible();
  for (const [agentId, content] of [[undefined, "Root secret"], ["sibling", "Sibling secret"], ["agent-a-shared-id", "Actual child stream"]] as const) {
    await page.evaluate((event) => window.dispatchEvent(new CustomEvent("test-daemon", { detail: {
      type: "session_event", sessionId: "a", event,
    } })), event(`delta-${content}`, "assistant.message_delta", content, agentId));
  }
  await expect(page.locator(".agent-conversation")).toContainText("Actual child stream");
  await expect(page.locator(".agent-conversation")).not.toContainText("Root secret");
  await expect(page.locator(".agent-conversation")).not.toContainText("Sibling secret");
  state.reject();
  const prompt = page.getByRole("textbox", { name: "Message Builder", exact: true });
  await prompt.fill("Preserve failed guidance");
  await prompt.press("Enter");
  await expect(prompt).toHaveValue("Preserve failed guidance");
  await expect(page.locator(".agent-conversation [role=alert]")).toContainText("no longer accepting");
  await a.getByLabel("Show finished").check();
  await a.getByRole("button", { name: /Old agent/ }).click();
  await expect(page.getByRole("textbox", { name: "Message Old agent", exact: true })).toBeDisabled();
});

test("subagent instruction attribution survives history and live updates without calling agents You", async ({ page }) => {
  await setup(page);
  const owner = "agent-a-shared-id";
  await page.route("**/api/agent_history", (route) => route.fulfill({ json: {
    sessionId: "a", taskId: "shared-id", agentId: owner, cursor: null, hasMore: false,
    events: [
      { ...event("agent-instruction", "user.message", "Only four files move.\n\nPlease narrow the remaining mapping.", owner), data: {
        content: "Only four files move.\n\nPlease narrow the remaining mapping.", source: "agent-primary",
      } },
      event("unknown-instruction", "user.message", "Older instruction without sender metadata", owner),
      { ...event("human-instruction", "user.message", "I typed this follow-up", owner), data: {
        content: "I typed this follow-up", source: "user",
      } },
      event("answer", "assistant.message", "I will narrow the mapping.", owner),
    ],
  } }));
  const a = await expand(page, "a");
  await a.getByRole("button", { name: /Builder/ }).click();
  const child = page.locator(".agent-conversation");
  await expect(child.locator(".message.user .message-role")).toHaveText(["Agent instruction", "Instruction", "You"]);
  await expect(child.locator("[data-message-origin='agent'] .message-role span")).toHaveAttribute("title", /agent-primary/);
  await expect(child.locator("[data-message-origin='agent'] .user-message-text")).toHaveCSS("white-space", "pre-wrap");
  await expect(child.locator("[data-root-human]")).toHaveCount(0);
  await page.evaluate((input) => window.dispatchEvent(new CustomEvent("test-daemon", { detail: {
    type: "session_event", sessionId: "a", event: input,
  } })), { ...event("live-skill", "user.message", "Skill material", owner), data: { content: "Skill material", source: "skill-pdf" } });
  await expect(child.locator(".message.user .message-role")).toHaveText(["Agent instruction", "Instruction", "You", "Skill instructions"]);
  await child.getByRole("button", { name: "Refresh conversation" }).click();
  await expect(child.locator(".message.user .message-role")).toHaveText(["Agent instruction", "Instruction", "You", "Skill instructions"]);
  await child.getByRole("button", { name: "Back to parent" }).click();
  const parent = page.locator(".parent-session-view");
  await expect(parent.locator("[data-root-human] .message-role")).toHaveText("You");
  await page.evaluate((input) => window.dispatchEvent(new CustomEvent("test-daemon", { detail: {
    type: "session_event", sessionId: "a", event: input,
  } })), { ...event("root-agent-message", "user.message", "A forwarded agent instruction"), data: {
    content: "A forwarded agent instruction", source: "agent-reviewer",
  } });
  await expect(parent.locator("[data-message-origin='agent'] .message-role")).toHaveText("Agent instruction");
  await expect(parent.locator("[data-root-human]")).toHaveCount(1);
});

test("agent and parent keyboard commands cannot accidentally submit or modify the parent", async ({ page }) => {
  const state = await setup(page);
  const a = await expand(page, "a");
  await a.getByRole("button", { name: /Builder/ }).click();
  const prompt = page.getByRole("textbox", { name: "Message Builder", exact: true });
  await prompt.fill("Child-only draft");
  await prompt.press("Alt+2");
  await prompt.press("Control+q");
  await prompt.press("Control+.");
  await page.getByRole("button", { name: "Subagents for Session a", exact: true }).click();
  await expect(page.locator(".agent-conversation")).toBeVisible();
  await prompt.press("Control+Enter");
  await expect.poll(() => state.sent.length).toBe(1);
  expect(state.requests.filter((request) => ["set_session_mode", "send_message", "abort_session"].includes(request.command))).toHaveLength(0);
  await page.getByRole("button", { name: "Back to parent" }).click();
  await expect(page.locator(".parent-session-view .composer textarea")).toBeFocused();
});

test("terminal shortcuts work from the composer and terminal without sending shortcut bytes", async ({ page }) => {
  const inputs: string[] = [];
  await page.routeWebSocket((url) => url.pathname === "/api/terminal", (socket) => {
    socket.send(JSON.stringify({ type: "ready", shell: "Test shell", cwd: "Q:\\example", restored: false, hasControl: true, viewers: 1 }));
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "input") inputs.push(message.data);
    });
  });
  await setup(page);
  const composer = page.locator(".parent-session-view .composer textarea");
  await composer.fill("Do not change my draft");
  await composer.press("Alt+t");
  await expect(page.locator(".terminal-pane")).toHaveCount(0);
  await composer.press("Control+Shift+t");
  await expect(page.locator(".terminal-pane")).toBeVisible();
  const terminal = page.locator(".xterm-helper-textarea");
  await expect(terminal).toBeFocused();
  await page.keyboard.type("echo ready");
  await expect.poll(() => inputs.join("")).toBe("echo ready");
  const before = [...inputs];
  await terminal.press("Control+Shift+t");
  await expect(page.locator(".terminal-pane")).toHaveCount(0);
  await expect(composer).toBeFocused();
  expect(inputs).toEqual(before);
  await expect(composer).toHaveValue("Do not change my draft");
  await composer.press("Control+Shift+t");
  await expect(page.locator(".terminal-pane")).toBeVisible();
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.press("Control+Shift+t");
  await expect(page.locator(".terminal-pane")).toHaveCount(0);
  expect(inputs).toEqual(before);
  await composer.dispatchEvent("keydown", { key: "t", ctrlKey: true, shiftKey: true, repeat: true });
  await expect(page.locator(".terminal-pane")).toHaveCount(0);
  await page.locator(".daemon-state").click();
  await page.getByRole("button", { name: "Close settings" }).press("Control+Shift+t");
  await expect(page.locator(".terminal-pane")).toHaveCount(0);
});

test("terminal shortcut also works while viewing a child without changing its draft", async ({ page }) => {
  await page.routeWebSocket((url) => url.pathname === "/api/terminal", (socket) => {
    socket.send(JSON.stringify({ type: "ready", shell: "Test shell", cwd: "Q:\\example", hasControl: true, restored: false, viewers: 1 }));
  });
  await setup(page);
  const children = await expand(page, "a");
  await children.getByRole("button", { name: /Builder/ }).click();
  const prompt = page.getByRole("textbox", { name: "Message Builder", exact: true });
  await prompt.fill("Child draft");
  await prompt.press("Control+Shift+t");
  await expect(page.locator(".terminal-pane")).toBeVisible();
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.press("Control+Shift+t");
  await expect(page.locator(".terminal-pane")).toHaveCount(0);
  await expect(prompt).toBeFocused();
  await expect(prompt).toHaveValue("Child draft");
});

test("shortcut focus waits for lazy terminal mounting and does not steal focus on later renders", async ({ page }) => {
  let release!: () => void;
  const loading = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/\/assets\/TerminalPane-.*\.js$/, async (route) => {
    await loading;
    await route.continue();
  });
  await page.routeWebSocket((url) => url.pathname === "/api/terminal", (socket) => {
    socket.send(JSON.stringify({ type: "ready", shell: "Test shell", cwd: "Q:\\example", hasControl: true, restored: false, viewers: 1 }));
  });
  await setup(page);
  const composer = page.locator(".parent-session-view .composer textarea");
  await composer.fill("Saved draft");
  await composer.press("Control+Shift+t");
  await expect(page.locator(".terminal-loading")).toBeVisible();
  release();
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await composer.click();
  await composer.fill("A newer draft");
  await page.getByRole("button", { name: "Terminal beside chat", exact: true }).click();
  await composer.click();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("A newer draft");
  await page.keyboard.press("Control+Shift+t");
  await expect(page.locator(".terminal-pane")).toHaveCount(0);
  await expect(composer).toBeFocused();
});

test("saved delivery defaults persist and explicit send shortcuts override them for one message", async ({ page }) => {
  await setup(page);
  const sends: Record<string, unknown>[] = [];
  await page.route("**/api/send_message", (route) => {
    sends.push(route.request().postDataJSON());
    return route.fulfill({ json: "accepted" });
  });
  const mode = page.getByRole("combobox", { name: "Message delivery", exact: true });
  const composer = page.locator(".parent-session-view .composer textarea");
  await expect(mode).toHaveValue("enqueue");
  await page.locator(".daemon-state").click();
  await page.locator(".workflow-settings summary").click();
  await page.getByRole("combobox", { name: "Default message delivery" }).selectOption("immediate");
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(mode).toHaveValue("immediate");
  expect(sends).toHaveLength(0);
  await page.reload();
  await expect(composer).toBeEnabled();
  await expect(mode).toHaveValue("immediate");
  await composer.fill("Use saved default");
  await composer.press("Enter");
  await expect.poll(() => sends.length).toBe(1);
  expect(sends[0].deliveryMode).toBe("immediate");
  await composer.fill("Explicit queue");
  await composer.press("Control+q");
  await expect.poll(() => sends.length).toBe(2);
  expect(sends[1].deliveryMode).toBe("enqueue");
  await expect(mode).toHaveValue("immediate");
  await mode.selectOption("enqueue");
  await composer.fill("Explicit steering");
  await composer.press("Control+Enter");
  await expect.poll(() => sends.length).toBe(3);
  expect(sends[2].deliveryMode).toBe("immediate");
  await expect(mode).toHaveValue("enqueue");
  expect(await page.evaluate(() => localStorage.getItem("copilot-sessions.default-delivery"))).toBe("immediate");
  await page.reload();
  await expect(mode).toHaveValue("immediate");
});

test("delivery preference changes sync between tabs without discarding a local override", async ({ page, context }) => {
  await setup(page);
  const second = await context.newPage();
  await setup(second);
  const firstMode = page.getByRole("combobox", { name: "Message delivery", exact: true });
  const otherMode = second.getByRole("combobox", { name: "Message delivery", exact: true });
  await page.locator(".daemon-state").click();
  await page.locator(".workflow-settings summary").click();
  await page.getByRole("combobox", { name: "Default message delivery" }).selectOption("immediate");
  await expect(otherMode).toHaveValue("immediate");
  await otherMode.selectOption("enqueue");
  await second.evaluate(() => window.dispatchEvent(new StorageEvent("storage", {
    key: "copilot-sessions.default-delivery", newValue: "immediate", storageArea: localStorage,
  })));
  await expect(otherMode).toHaveValue("enqueue");
  await expect(firstMode).toHaveValue("immediate");
  await page.getByRole("combobox", { name: "Default message delivery" }).selectOption("enqueue");
  await expect(otherMode).toHaveValue("enqueue");
  await second.close();
});

test("delivery storage failures remain visible while the in-window default stays usable", async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "copilot-sessions.default-delivery") throw new Error("Preference storage denied");
      original.call(this, key, value);
    };
  });
  await setup(page);
  await page.locator(".daemon-state").click();
  await page.locator(".workflow-settings summary").click();
  await page.getByRole("combobox", { name: "Default message delivery" }).selectOption("immediate");
  await page.locator(".workflow-settings summary").click();
  await expect(page.locator(".settings-panel [role='alert']")).toContainText("Preference storage denied");
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(page.getByRole("combobox", { name: "Message delivery", exact: true })).toHaveValue("immediate");
  await expect(page.locator(".composer [role='alert']")).toContainText("applies only to this window");
  expect(await page.evaluate(() => localStorage.getItem("copilot-sessions.default-delivery"))).toBeNull();
});

test("invalid delivery defaults safely fall back to queue and removal syncs to other tabs", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("copilot-sessions.default-delivery", "invalid"));
  await setup(page);
  const mode = page.getByRole("combobox", { name: "Message delivery", exact: true });
  await expect(mode).toHaveValue("enqueue");
  await expect(page.locator(".composer [role='alert']")).toContainText("invalid");
  await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", {
    key: "copilot-sessions.default-delivery", newValue: "immediate", storageArea: localStorage,
  })));
  await expect(mode).toHaveValue("immediate");
  await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", {
    key: "copilot-sessions.default-delivery", newValue: null, storageArea: localStorage,
  })));
  await expect(mode).toHaveValue("enqueue");
  await expect(page.locator(".composer [role='alert']")).toHaveCount(0);
});

test("Settings exposes a keyboard shortcut popup with the terminal and copy shortcuts", async ({ page }) => {
  await setup(page);
  await page.locator(".daemon-state").click();
  const button = page.getByRole("button", { name: /^Keyboard shortcuts/ });
  await expect(button).toBeVisible();
  await button.click();
  const popup = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });
  await expect(popup).toBeVisible();
  await expect(popup).toContainText("Ctrl Shift T");
  await expect(popup).toContainText("copy selected text");
  await expect(popup).not.toContainText("Alt T");
  await expect(popup.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await popup.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await popup.getByRole("button", { name: "Close", exact: true }).click();
  await expect(popup).toHaveCount(0);
  await expect(page.locator(".parent-session-view .composer textarea")).toBeFocused();
});

test("Ctrl+C copies selected terminal text, preserves bare interrupts and reports clipboard failures", async ({ page }) => {
  await page.addInitScript(() => {
    const state = { values: [] as string[], fail: false };
    Object.defineProperty(window, "testClipboard", { value: state });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text: string) => {
        if (state.fail) throw new Error("Clipboard denied");
        state.values.push(text);
      },
    } });
  });
  const inputs: string[] = [];
  let send = (_message: string) => {};
  await page.routeWebSocket((url) => url.pathname === "/api/terminal", (socket) => {
    send = (message) => socket.send(message);
    socket.send(JSON.stringify({ type: "ready", shell: "Copy test", cwd: "Q:\\example", hasControl: true, restored: false, viewers: 1 }));
    socket.send(JSON.stringify({ type: "output", data: "COPY_THIS_TEXT\r\n" }));
    socket.onMessage((message) => {
      const value = JSON.parse(String(message));
      if (value.type === "input") inputs.push(value.data);
    });
  });
  await setup(page);
  await page.getByTitle("Open terminal", { exact: true }).click();
  const firstLine = page.locator(".xterm-rows > div").first();
  await expect(firstLine).toContainText("COPY_THIS_TEXT");
  const textSpan = firstLine.locator("span").first();
  const box = (await textSpan.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  const copy = page.getByRole("button", { name: "Copy terminal selection", exact: true });
  await expect(copy).toBeEnabled();
  const terminalInput = page.locator(".xterm-helper-textarea");
  await terminalInput.press("Control+c");
  await expect.poll(() => page.evaluate(() => (window as unknown as { testClipboard: { values: string[] } }).testClipboard.values.length)).toBe(1);
  expect(await page.evaluate(() => (window as unknown as { testClipboard: { values: string[] } }).testClipboard.values[0])).toBe("COPY_THIS_TEXT");
  expect(inputs).toEqual([]);
  send(JSON.stringify({ type: "control_changed", controller: null, viewers: 2 }));
  await expect(page.getByTitle("Take terminal control", { exact: true })).toBeVisible();
  await copy.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { testClipboard: { values: string[] } }).testClipboard.values.length)).toBe(2);
  await page.evaluate(() => { (window as unknown as { testClipboard: { fail: boolean } }).testClipboard.fail = true; });
  await terminalInput.press("Control+c");
  await expect(page.locator(".terminal-pane [role='alert']")).toContainText("Clipboard denied");
  await expect(copy).toBeEnabled();
  expect(inputs).toEqual([]);
  send(JSON.stringify({ type: "ready", shell: "Copy test", cwd: "Q:\\example", hasControl: true, restored: false, viewers: 1 }));
  await expect(page.getByTitle("Release terminal control", { exact: true })).toBeVisible();
  await page.locator(".xterm-screen").click({ position: { x: 5, y: 5 } });
  await expect(copy).toBeDisabled();
  await terminalInput.press("Control+c");
  await expect.poll(() => inputs.includes("\u0003")).toBe(true);
});

test("deleting the parent while viewing a child restores the empty main workspace", async ({ page }) => {
  await setup(page);
  const a = await expand(page, "a");
  await a.getByRole("button", { name: /Builder/ }).click();
  await expect(page.locator(".agent-conversation")).toBeVisible();
  page.on("dialog", (dialog) => dialog.accept());
  await page.locator('[data-session-id="a"]').hover();
  await page.getByRole("button", { name: "Delete Session a", exact: true }).click();
  await expect(page.locator(".agent-conversation")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Choose a session", exact: true })).toBeVisible();
});

test("missing tool metadata shows an honest catalog instead of a failed drawer", async ({ page }) => {
  await setup(page);
  await page.route("**/api/tool_controls", (route) => route.fulfill({ json: {
    tools: [{ id: "builtin:glob", name: "glob", description: "Known catalog tool", source: "builtin", enabled: false }],
    servers: [{ name: "example", status: "connected" }],
    excludedTools: [], filterOwnership: "unknown", canEditTools: false, requiresAdoption: true,
    filterStateKnown: false, metadataAvailable: false, metadataLoading: true, warnings: [],
  } }));
  await page.getByTitle("Browse commands, tools, skills, MCP, and instructions").click();
  await page.getByRole("tab", { name: "Tools", exact: true }).click();
  await expect(page.locator(".ct-tool-list")).toContainText("glob");
  await expect(page.locator(".ct-inventory")).toContainText("runtime availability unknown");
  await expect(page.locator(".ct-tool-list").getByRole("switch")).toBeDisabled();
  await expect(page.getByRole("switch", { name: "Enable MCP server example for this session" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Manage this session’s tool selection" })).toBeDisabled();
  await expect(page.getByText("Could not read session tools.", { exact: true })).toHaveCount(0);
});

test("event-only ask_user shows a visible answer form without an SDK callback", async ({ page }) => {
  const state = await setup(page);
  const question = {
    sessionId: "a", requestId: "native-question", kind: "user_input",
    data: { question: "Which diagram should change?", choices: ["Simplify 03", "Keep 03 unchanged"], allowFreeform: true },
  };
  let pending = false;
  const responses: unknown[] = [];
  await page.route("**/api/pending_interactions", (route) => route.fulfill({ json: pending ? [question] : [] }));
  await page.route("**/api/respond_interaction", (route) => {
    responses.push(route.request().postDataJSON());
    pending = false;
    return route.fulfill({ json: { success: true } });
  });
  await page.locator(".parent-session-view .composer textarea").fill("Keep my unrelated draft");
  pending = true;
  await page.evaluate((data) => window.dispatchEvent(new CustomEvent("test-daemon", { detail: {
    type: "session_event", sessionId: "a",
    event: { id: "requested", type: "user_input.requested", timestamp: "2026-09-14T22:00:00Z", data },
  } })), { ...question.data, requestId: "native-question" });
  const panel = page.locator(".interaction-dock .interaction-panel");
  await expect(panel).toHaveCount(1);
  await expect(panel).toBeInViewport();
  await expect(panel.getByText("Which diagram should change?", { exact: true })).toBeVisible();
  await panel.getByRole("radio", { name: "Simplify 03", exact: true }).check();
  await panel.getByRole("button", { name: "Submit answer" }).click();
  await expect(panel).toHaveCount(0);
  expect(responses).toEqual([{
    sessionId: "a", requestId: "native-question", kind: "user_input",
    response: { answer: "Simplify 03", wasFreeform: false },
  }]);
  await expect(page.locator(".parent-session-view .composer textarea")).toHaveValue("Keep my unrelated draft");
  expect(state.requests.filter((request) => request.command === "send_message")).toHaveLength(0);
});

test("pending questions remain accessible in a child view and dismiss on external completion", async ({ page }) => {
  await setup(page);
  const question = {
    sessionId: "a", requestId: "native-question", kind: "user_input",
    data: { question: "Continue this task?", choices: ["Yes", "No"], allowFreeform: false },
  };
  let pending = true;
  await page.route("**/api/pending_interactions", (route) => route.fulfill({ json: pending ? [question] : [] }));
  const a = await expand(page, "a");
  await a.getByRole("button", { name: /Builder/ }).click();
  await page.evaluate((interaction) => window.dispatchEvent(new CustomEvent("test-daemon", {
    detail: { type: "interaction_requested", interaction },
  })), question);
  await expect(page.locator(".agent-conversation")).toBeVisible();
  await expect(page.locator(".interaction-dock")).toBeVisible();
  await expect(page.locator(".interaction-dock").getByRole("radio", { name: "Yes", exact: true })).toBeInViewport();
  pending = false;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("test-daemon", { detail: {
    type: "session_event", sessionId: "a",
    event: { id: "completed", type: "user_input.completed", timestamp: "2026-09-14T22:00:01Z", data: { requestId: "native-question" } },
  } })));
  await expect(page.locator(".interaction-dock")).toHaveCount(0);
});

test("a stale pending-request read cannot resurrect an externally completed question", async ({ page }) => {
  await setup(page);
  const question = {
    sessionId: "a", requestId: "native-question", kind: "user_input",
    data: { question: "An already answered question", choices: ["Yes", "No"] },
  };
  let first: import("@playwright/test").Route | undefined;
  let requests = 0;
  await page.route("**/api/pending_interactions", (route) => {
    requests++;
    if (requests === 1) { first = route; return; }
    return route.fulfill({ json: [] });
  });
  await page.evaluate((interaction) => window.dispatchEvent(new CustomEvent("test-daemon", {
    detail: { type: "interaction_requested", interaction },
  })), question);
  await expect.poll(() => !!first).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("test-daemon", { detail: {
    type: "interaction_resolved", sessionId: "a", requestId: "native-question",
  } })));
  await first!.fulfill({ json: [question] });
  await expect.poll(() => requests).toBeGreaterThan(1);
  await expect(page.locator(".interaction-dock")).toHaveCount(0);
});

test("user message formatting preserves blank lines and indentation while long text wraps", async ({ page }) => {
  await setup(page);
  const content = "First line\n\n  Indented point\nNext line\n" + "long-unbroken-text".repeat(100);
  await page.route("**/api/session_history_window", (route) => route.fulfill({ json: {
    events: [event("formatted-user", "user.message", content), event("reply", "assistant.message", "**Assistant Markdown**")],
    hasMore: false, cursor: "", loadedPages: 1, humanMessages: 1,
  } }));
  await page.reload();
  const message = page.locator(".message.user .user-message-text");
  await expect(message).toBeVisible();
  expect(await message.textContent()).toBe(content);
  const layout = await message.evaluate((element) => {
    const text = element.firstChild!;
    const value = text.textContent!;
    const position = (offset: number) => {
      const range = document.createRange();
      range.setStart(text, offset);
      range.setEnd(text, offset + 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.x, y: rect.y };
    };
    const style = getComputedStyle(element);
    return {
      first: position(0), indented: position(value.indexOf("Indented")), next: position(value.indexOf("Next")),
      lineHeight: parseFloat(style.lineHeight), whiteSpace: style.whiteSpace,
      fits: element.scrollWidth <= element.clientWidth + 1,
    };
  });

  expect(layout.whiteSpace).toBe("pre-wrap");
  expect(layout.indented.y - layout.first.y).toBeGreaterThanOrEqual(layout.lineHeight * 1.9);
  expect(layout.next.y - layout.indented.y).toBeGreaterThanOrEqual(layout.lineHeight * .9);
  expect(layout.indented.x).toBeGreaterThan(layout.first.x);
  expect(layout.fits).toBe(true);
  await expect(page.locator(".message.assistant strong")).toHaveText("Assistant Markdown");
  await page.setViewportSize({ width: 440, height: 900 });
  expect(await message.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});

test("session names can be edited without submitting a chat or losing its draft", async ({ page }) => {
    const state = await setup(page);
    const renames: unknown[] = [];
    await page.route("**/api/rename_session", (route) => {
      const args = route.request().postDataJSON();
      renames.push(args);
      return route.fulfill({ json: { ...session(args.sessionId), title: args.name } });
    });
    await page.locator(".parent-session-view .composer textarea").fill("An unsent draft");
    await page.getByRole("button", { name: "Rename session", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Rename session", exact: true });
    await dialog.getByLabel("Session name").fill("Datapath questions");
    await dialog.getByRole("button", { name: "Save name" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("heading", { name: "Datapath questions", exact: true })).toBeVisible();
    await expect(page.locator('[data-session-id="a"]')).toContainText("Datapath questions");
    await expect(page.locator(".parent-session-view .composer textarea")).toHaveValue("An unsent draft");
    expect(renames).toEqual([{ sessionId: "a", name: "Datapath questions" }]);
    expect(state.requests.some((request) => request.command === "send_message")).toBe(false);
});

test("terminal defaults above chat and can move to every position without reconnecting", async ({ page }) => {
    let connections = 0;
    await page.routeWebSocket("**/api/terminal**", (socket) => {
      connections++;
      socket.send(JSON.stringify({ type: "ready", shell: "Test shell", cwd: "Q:\\example", restored: false, hasControl: true, viewers: 1 }));
      socket.send(JSON.stringify({ type: "output", data: "PRESERVED_TERMINAL\r\n" }));
    });
    await setup(page);
    await page.getByTitle("Open terminal").click();
    await expect(page.locator(".terminal-pane")).toBeVisible();
    await expect.poll(() => connections).toBe(1);
    await expect(page.getByRole("button", { name: "Terminal above chat", exact: true })).toHaveAttribute("aria-pressed", "true");
    const separator = page.getByRole("separator", { name: "Resize terminal" });
    await expect(separator).toHaveAttribute("aria-orientation", "horizontal");
    const top = await page.locator(".terminal-pane").boundingBox();
    const topChat = await page.locator(".workspace").boundingBox();
    expect(topChat!.y).toBeGreaterThanOrEqual(top!.y + top!.height);
    expect(top!.x).toBe(topChat!.x);
    const topSize = Number(await separator.getAttribute("aria-valuenow"));
    await separator.focus();
    await separator.press("ArrowDown");
    await expect(separator).toHaveAttribute("aria-valuenow", String(topSize + 10));
    const divider = await separator.boundingBox();
    await page.mouse.move(divider!.x + divider!.width / 2, divider!.y + divider!.height / 2);
    await page.mouse.down();
    await page.mouse.move(divider!.x + divider!.width / 2, divider!.y + divider!.height / 2 + 25);
    await page.mouse.up();
    await expect(separator).toHaveAttribute("aria-valuenow", String(topSize + 35));
    await page.getByRole("button", { name: "Terminal below chat", exact: true }).click();
    await expect(separator).toHaveAttribute("aria-orientation", "horizontal");
    const chat = await page.locator(".workspace").boundingBox();
    const terminal = await page.locator(".terminal-pane").boundingBox();
    expect(terminal!.y).toBeGreaterThanOrEqual(chat!.y + chat!.height);
    expect(terminal!.x).toBe(chat!.x);
    const before = Number(await separator.getAttribute("aria-valuenow"));
    await separator.focus();
    await separator.press("ArrowUp");
    await expect(separator).toHaveAttribute("aria-valuenow", String(before + 10));
    await page.getByRole("button", { name: "Terminal beside chat", exact: true }).click();
    await expect(separator).toHaveAttribute("aria-orientation", "vertical");
    const right = await page.locator(".terminal-pane").boundingBox();
    const workspace = await page.locator(".workspace").boundingBox();
    expect(right!.x).toBeGreaterThanOrEqual(workspace!.x + workspace!.width);
    expect(connections).toBe(1);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("copilot-sessions.terminal-layout") ?? "{}").dock)).toBe("right");
    await page.reload();
    await expect(page.locator(".parent-session-view .composer textarea")).toBeEnabled();
    await page.getByTitle("Open terminal").click();
    await expect(page.getByRole("button", { name: "Terminal beside chat", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Terminal above chat", exact: true }).click();
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("copilot-sessions.terminal-layout") ?? "{}").dock)).toBe("top");
    expect(connections).toBe(2);
});

test("forking opens an independent session and preserves the parent's unsent draft", async ({ page }) => {
  const state = await setup(page);
  const forks: unknown[] = [];
  let name = "";
  await page.route("**/api/fork_session", (route) => {
    const args = route.request().postDataJSON();
    forks.push(args);
    name = args.name;
    return route.fulfill({ json: { ...session("fork"), title: name } });
  });
  await page.route("**/api/resume_session", (route) => {
    const args = route.request().postDataJSON();
    return route.fulfill({ json: { ...session(args.sessionId), ...(args.sessionId === "fork" ? { title: name } : {}) } });
  });
  await page.locator(".parent-session-view .composer textarea").fill("Parent draft stays here");
  await page.getByRole("button", { name: "Fork conversation", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Fork conversation" });
  await dialog.getByLabel("New session name").fill("Alternative approach");
  await dialog.getByRole("button", { name: "Create fork" }).click();
  await expect(page.getByRole("heading", { name: "Alternative approach", exact: true })).toBeVisible();
  expect(forks).toEqual([{ sessionId: "a", name: "Alternative approach" }]);
  await expect(page.locator(".parent-session-view .composer textarea")).toHaveValue("");
  await page.locator('[data-session-id="a"] .session-open').click();
  await expect(page.locator(".parent-session-view .composer textarea")).toHaveValue("Parent draft stays here");
  expect(state.requests.some((request) => request.command === "send_message")).toBe(false);
});

test("CLI-like typography is opt-in, persists locally, and updates the terminal without reconnecting", async ({ page }) => {
  let connections = 0;
  let resizes = 0;
  await page.routeWebSocket("**/api/terminal**", (socket) => {
    connections++;
    socket.send(JSON.stringify({ type: "ready", shell: "Test shell", cwd: "Q:\\example", restored: false, hasControl: true, viewers: 1 }));
    socket.onMessage((message) => { if (JSON.parse(String(message)).type === "resize") resizes++; });
  });
  await setup(page);
  const text = page.locator(".message.user .user-message-text");
  expect(await text.evaluate((element) => getComputedStyle(element).fontFamily)).not.toContain("Cascadia");
  await page.getByTitle("Open terminal").click();
  await expect.poll(() => connections).toBe(1);
  await page.locator(".daemon-state").click();
  await page.locator(".typography-disclosure > summary").click();
  await page.getByRole("button", { name: /CLI-like/ }).click();
  expect(await text.evaluate((element) => getComputedStyle(element).fontFamily)).toContain("Cascadia");
  const slider = page.getByRole("slider", { name: "Terminal font size", exact: true });
  await slider.focus();
  const before = resizes;
  await slider.press("ArrowRight");
  await expect.poll(() => resizes).toBeGreaterThan(before);
  expect(connections).toBe(1);
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.reload();
  await expect(text).toBeVisible();
  expect(await text.evaluate((element) => getComputedStyle(element).fontFamily)).toContain("Cascadia");
  await page.locator(".daemon-state").click();
  await page.locator(".typography-disclosure > summary").click();
  await page.getByRole("button", { name: "Reset font & spacing", exact: true }).click();
  expect(await text.evaluate((element) => getComputedStyle(element).fontFamily)).not.toContain("Cascadia");
});

test("/ask submits to the transient API rather than sending a chat message or slash command", async ({ page }) => {
  const state = await setup(page);
  const asks: unknown[] = [];
  await page.route("**/api/ask_session", (route) => {
    const args = route.request().postDataJSON();
    asks.push(args);
    return route.fulfill({ json: { sessionId: args.sessionId, answer: "Transient **answer**." } });
  });
  const prompt = page.locator(".parent-session-view .composer textarea");
  await prompt.fill("/ask Why did we choose this approach?");
  await prompt.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Ask about conversation", exact: true });
  await expect(dialog.getByRole("article", { name: "Transient answer" })).toContainText("Transient answer.");
  expect(asks).toEqual([{ sessionId: "a", question: "Why did we choose this approach?" }]);
  expect(state.requests.some((request) => ["send_message", "execute_command"].includes(request.command))).toBe(false);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(prompt).toBeFocused();
  await expect(page.locator(".parent-session-view .message.user")).not.toContainText("Why did we choose");
});

test("Git review comments open an explicit transient question draft without sending or touching Git", async ({ page }) => {
  await setup(page);
  const workspace = {
    state: "repository", repoRoot: "Q:\\example", branch: "feature", head: "a".repeat(40),
    upstream: null, base: null, baseCommit: null, mergeBase: null, detached: false, unborn: false,
    refs: [], staged: [], untracked: [], compare: [], compareUnavailableReason: "Choose a target", warnings: [],
    unstaged: [{ path: "file.rs", originalPath: null, status: "M", kind: "file", added: 1, deleted: 1, binary: false }],
  };
  const requests: string[] = [];
  await page.route("**/api/git_workspace", (route) => { requests.push("git_workspace"); return route.fulfill({ json: workspace }); });
  await page.route("**/api/git_diff", (route) => { requests.push("git_diff"); return route.fulfill({ json: {
    repoRoot: "Q:\\example", path: "file.rs", originalPath: null, view: "unstaged",
    head: workspace.head, base: null, baseCommit: null, mergeBase: null, contentId: "version-one",
    patch: "diff --git a/file.rs b/file.rs\n--- a/file.rs\n+++ b/file.rs\n@@ -1 +1 @@\n-old\n+new\n",
    truncated: false, binary: false, kind: "file", added: 1, deleted: 1, unavailableReason: null, warnings: [],
  } }); });
  let asked = false;
  await page.route("**/api/ask_session", (route) => { asked = true; return route.fulfill({ json: { sessionId: "a", answer: "Review answer" } }); });
  await page.getByRole("button", { name: "Open Git workspace" }).click();
  const git = page.getByRole("dialog", { name: "Git workspace" });
  await git.getByRole("button", { name: /file\.rs/ }).click();
  await git.getByRole("option", { name: "Added line new:1", exact: true }).click();
  await git.getByLabel("Local review comment").fill("Why was this changed?");
  await git.getByRole("button", { name: "Save local comment" }).click();
  await git.getByRole("button", { name: "Quick ask about comment" }).click();
  const ask = page.getByRole("dialog", { name: "Ask about conversation" });
  await expect(ask.getByLabel("Question", { exact: true })).toHaveValue(/Why was this changed\?/);
  expect(asked).toBe(false);
  expect(requests).toEqual(["git_workspace", "git_diff"]);
  await ask.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(ask.getByRole("article", { name: "Transient answer" })).toContainText("Review answer");
  expect(asked).toBe(true);
});

test("mobile Git controls and footer remain bounded with the full application stylesheet", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  const branch = "joklein/windows-driver-rust-integration";
  const filename = "rust/crates/tunnel-tun-linux/src/lib.rs";
  const workspace = {
    state: "repository", repoRoot: "Q:/gits/db/windows-driver-rust-integration", branch, head: "a".repeat(40),
    upstream: `refs/remotes/origin/${branch}`, base: `refs/remotes/origin/${branch}`, baseCommit: "b".repeat(40),
    mergeBase: "c".repeat(40), detached: false, unborn: false, warnings: [], compareUnavailableReason: null,
    refs: [{ name: "refs/heads/main", commit: "d".repeat(40) }],
    staged: [], unstaged: [], untracked: [],
    compare: [filename, "docs/design/design.md"].map((path) => ({ path, originalPath: null, status: "M", kind: "file", added: 1, deleted: 1, binary: false })),
  };
  await page.route("**/api/git_workspace", (route) => route.fulfill({ json: workspace }));
  await page.route("**/api/git_diff", (route) => route.fulfill({ json: {
    ...workspace, view: "compare", path: route.request().postDataJSON().path, originalPath: null,
    contentId: "file", kind: "file", added: 1, deleted: 1, binary: false, truncated: false, unavailableReason: null,
    patch: "@@ -20,40 +20,40 @@\n-old\n+new " + "x".repeat(200) + "\n" + " unchanged line\n".repeat(39),
  } }));
  await page.getByRole("button", { name: "Open Git workspace" }).click();
  const panel = page.getByRole("dialog", { name: "Git workspace" });
  await panel.getByRole("combobox", { name: "Git change view" }).selectOption("compare");
  const picker = panel.getByRole("combobox", { name: "Choose file" });
  await picker.selectOption(filename);
  await expect(panel.getByRole("region", { name: "Selected file unified diff" })).toBeVisible();
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await panel.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(picker).toBeInViewport();
  const boundaries = await panel.evaluate((element) => ({
    diff: element.querySelector(".git-panel-diff")!.getBoundingClientRect().bottom,
    editor: element.querySelector(".git-panel-comment-editor")!.getBoundingClientRect().top,
    editorEnd: element.querySelector(".git-panel-comment-editor")!.getBoundingClientRect().bottom,
    footer: element.querySelector("footer")!.getBoundingClientRect().top,
  }));
  expect(boundaries.editor).toBeGreaterThanOrEqual(boundaries.diff);
  expect(boundaries.footer).toBeGreaterThanOrEqual(boundaries.editorEnd);
  await page.screenshot({ path: testInfo.outputPath("mobile-git-app-footer.png") });
  await panel.getByRole("button", { name: "Next file" }).click();
  await expect(picker).toHaveValue("docs/design/design.md");
  await panel.locator(".git-mobile-options summary").click();
  const select = panel.getByLabel("Comparison target");
  await expect(select).toBeVisible();
  expect((await select.boundingBox())!.x).toBeGreaterThanOrEqual(0);
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});

test("desktop continuous Git keeps the file list visible and notes/footer below oversized diffs", async ({ page }, testInfo) => {
  await setup(page);
  const workspace = {
    state: "repository", repoRoot: "Q:\\example", branch: "feature", head: "a".repeat(40),
    upstream: null, base: null, baseCommit: null, mergeBase: null, detached: false, unborn: false,
    refs: [], staged: [], untracked: [], compare: [], compareUnavailableReason: "Choose a target", warnings: [],
    unstaged: Array.from({ length: 3 }, (_, index) => ({
      path: `src/long-module-name/file-${index}.rs`, originalPath: null, status: "M", kind: "file", added: 1, deleted: 1, binary: false,
    })),
  };
  await page.route("**/api/git_workspace", (route) => route.fulfill({ json: workspace }));
  await page.route("**/api/git_diff", (route) => {
    const args = route.request().postDataJSON();
    return route.fulfill({ json: {
      repoRoot: workspace.repoRoot, path: args.path, originalPath: null, view: "unstaged",
      head: workspace.head, base: null, baseCommit: null, mergeBase: null, contentId: args.context ?? "changes",
      context: args.context ?? "changes", fullContextComplete: args.context === "full",
      patch: "@@ -1,150 +1,150 @@\n-old\n+new " + "x".repeat(220) + "\n" + " context line\n".repeat(args.context === "full" ? 299 : 149),
      truncated: false, binary: false, kind: "file", added: 1, deleted: 1, unavailableReason: null, warnings: [],
    } });
  });
  await page.getByRole("button", { name: "Open Git workspace" }).click();
  const panel = page.getByRole("dialog", { name: "Git workspace" });
  await panel.getByRole("button", { name: "Continuous diffs", exact: true }).click();
  const list = panel.locator(".git-panel-files");
  for (const file of workspace.unstaged) {
    await list.getByTitle(file.path, { exact: true }).click();
    const card = panel.getByRole("article", { name: `Diff for ${file.path}`, exact: true });
    await expect(card.getByRole("region")).toContainText("+new");
    await expect(list.getByTitle(file.path, { exact: true })).toHaveAttribute("aria-current", "location");
    await card.getByLabel("Whole-file context").check();
    await expect(card).toContainText("Complete file context.");
    await card.getByRole("option", { name: "Added line new:1", exact: true }).click();
    await card.getByLabel("Local review comment", { exact: true }).fill("A lengthy local note that should never paint over a later diff. ".repeat(10));
    await card.getByRole("button", { name: "Save local comment", exact: true }).click();
    const geometry = await card.evaluate((element) => {
      const diff = element.querySelector(".git-panel-diff")!;
      const editor = element.querySelector(".git-panel-comment-editor")!;
      const comments = element.querySelector(".git-panel-comments")!;
      const panel = element.closest(".git-panel")!;
      return {
        diffBottom: diff.getBoundingClientRect().bottom, editorTop: editor.getBoundingClientRect().top,
        editorBottom: editor.getBoundingClientRect().bottom, commentsTop: comments.getBoundingClientRect().top,
        commentsBottom: comments.getBoundingClientRect().bottom, cardBottom: element.getBoundingClientRect().bottom,
        footerTop: panel.querySelector(".git-panel-body > footer")!.getBoundingClientRect().top,
        feedBottom: panel.querySelector(".git-diff-feed")!.getBoundingClientRect().bottom,
        overflow: panel.scrollWidth > panel.clientWidth + 1,
      };
    });
    expect(geometry.editorTop).toBeGreaterThanOrEqual(geometry.diffBottom);
    expect(geometry.commentsTop).toBeGreaterThanOrEqual(geometry.editorBottom);
    expect(geometry.cardBottom).toBeGreaterThanOrEqual(geometry.commentsBottom);
    expect(geometry.footerTop).toBeGreaterThanOrEqual(geometry.feedBottom);
    expect(geometry.overflow).toBe(false);
    await expect(list).toBeInViewport();
  }
  await panel.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const footer = panel.locator(".git-panel-body > footer");
  await expect(footer).toBeInViewport();
  expect((await footer.boundingBox())!.y).toBeGreaterThanOrEqual((await panel.locator(".git-diff-feed").boundingBox())!.y
    + (await panel.locator(".git-diff-feed").boundingBox())!.height);
  await page.screenshot({ path: testInfo.outputPath("desktop-continuous-footer.png") });
});

test("untracked text can be reviewed from Unstaged with the full app on desktop and mobile", async ({ page }, testInfo) => {
  await setup(page);
  const path = "src/new-module/new-component.tsx";
  const workspace = {
    state: "repository", repoRoot: "Q:\\example", branch: "feature", head: "a".repeat(40),
    upstream: null, base: null, baseCommit: null, mergeBase: null, detached: false, unborn: false,
    refs: [], staged: [], unstaged: [], compare: [], compareUnavailableReason: "Choose a target", warnings: [],
    untracked: [{ path, originalPath: null, status: "?", kind: "untracked", added: null, deleted: null, binary: false }],
  };
  const views: string[] = [];
  await page.route("**/api/git_workspace", (route) => route.fulfill({ json: workspace }));
  await page.route("**/api/git_diff", (route) => {
    const args = route.request().postDataJSON();
    views.push(args.view);
    if (args.view !== "untracked") return route.fulfill({ status: 400, body: "This path is not a tracked unstaged file." });
    return route.fulfill({ json: {
      repoRoot: workspace.repoRoot, path, originalPath: null, view: "untracked", head: workspace.head,
      base: null, baseCommit: null, mergeBase: null, contentId: "new-file",
      patch: "--- /dev/null\n+++ b/src/new-module/new-component.tsx\n@@ -0,0 +1,3 @@\n+export const title = 'New file';\n+const literal = '<script>not executable</script>';\n+export const answer = 42;\n",
      truncated: false, binary: false, kind: "untracked", added: 3, deleted: 0, unavailableReason: null, warnings: [],
    } });
  });
  await page.getByRole("button", { name: "Open Git workspace" }).click();
  const panel = page.getByRole("dialog", { name: "Git workspace" });
  await expect(panel.getByRole("button", { name: "Unstaged 1", exact: true })).toHaveAttribute("aria-pressed", "true");
  await panel.getByTitle(path, { exact: true }).click();
  const patch = panel.getByRole("region", { name: "Selected file unified diff" });
  await expect(patch).toContainText("export const title = 'New file'");
  await expect(patch.locator(".git-diff-line.add")).toHaveCount(3);
  await expect(patch.locator("script")).toHaveCount(0);
  await expect(panel.getByRole("option", { name: "Added line new:3", exact: true })).toBeVisible();
  await expect(panel.getByLabel("Whole-file context")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("untracked-additions-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel.getByRole("combobox", { name: "Choose file" })).toHaveValue(path);
  await expect(patch).toContainText("export const answer = 42");
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(views).toEqual(["untracked"]);
});
