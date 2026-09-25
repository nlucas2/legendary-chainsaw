import { test, expect, type Page } from "@playwright/test";

declare global {
  interface Window { optionsEventSourceUrls: string[] }
}

async function setup(page: Page) {
  const session = { sessionId: "options", title: "Options fixture", cwd: "Q:\\example", model: "model",
    isActive: true, isRemote: false, pinned: false, archived: false, tags: [], startTime: "", modifiedTime: "" };
  const history = { events: [], hasMore: false, cursor: "", loadedPages: 1, humanMessages: 0 };
  const state = { processing: false, requests: [] as { command: string; args: Record<string, unknown> }[], terminalConnections: 0 };
  await page.addInitScript(() => {
    window.optionsEventSourceUrls = [];
    class Events extends EventTarget {
      onopen: (() => void) | null = null;
      listener = (event: Event) => {
        if (event instanceof CustomEvent) this.dispatchEvent(new MessageEvent("session-event", { data: JSON.stringify(event.detail) }));
      };
      constructor(url: string) {
        super(); window.optionsEventSourceUrls.push(String(url));
        window.addEventListener("options-fixture-event", this.listener);
        setTimeout(() => this.onopen?.(), 0);
      }
      close() { window.removeEventListener("options-fixture-event", this.listener); }
    }
    Object.defineProperty(window, "EventSource", { value: Events });
  });
  await page.routeWebSocket("**/api/terminal**", (socket) => {
    state.terminalConnections++;
    socket.send(JSON.stringify({ type: "ready", shell: "Options shell", cwd: session.cwd, hasControl: true, viewers: 1 }));
  });
  await page.route("**/api/**", (route) => {
    const command = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const args = route.request().postDataJSON() ?? {};
    state.requests.push({ command, args });
    let result: unknown;
    switch (command) {
      case "list_sessions": result = [session]; break;
      case "resume_session": result = session; break;
      case "refresh_session": result = { session, history, runtimeRecycled: false }; break;
      case "runtime_status": result = { connected: true, acceptingWork: true }; break;
      case "session_state": result = { sessionId: session.sessionId, processing: state.processing, mode: "interactive" }; break;
      case "session_processing": result = state.processing; break;
      case "get_session_profile": result = { sessionId: session.sessionId, profile: null, applying: false, configurationBlocked: false, requiresReconnect: false, error: null }; break;
      case "queue_items": result = { items: [], steeringMessages: [] }; break;
      case "agent_tasks": result = { sessionId: session.sessionId, tasks: [] }; break;
      case "pending_permissions": case "pending_interactions": case "subagent_context": result = []; break;
      case "git_repository": result = { isRepository: false }; break;
      case "session_history_window": result = history; break;
      case "context_attribution": result = { contextAttribution: null }; break;
      case "session_references": result = Object.fromEntries(["commands", "skills", "mcp", "tools", "mcpTools", "instructions", "contextAttribution", "tasks"].map((name) => [name, {}])); break;
      default: return route.fulfill({ status: 404, body: `Unexpected ${command}` });
    }
    return route.fulfill({ json: result });
  });
  await page.goto("/?session=options");
  await expect(page.locator(".parent-session-view .composer textarea")).toBeEnabled();
  const more = () => page.getByRole("button", { name: "Additional options", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Additional options", exact: true });
  const emit = (type: string, data: unknown = {}) => page.evaluate(({ type, data }) =>
    window.dispatchEvent(new CustomEvent("options-fixture-event", { detail: {
      type: "session_event", sessionId: "options", event: { id: crypto.randomUUID(), type, data, timestamp: "" },
    } })), { type, data });
  return { state, more, panel, emit };
}

test("Raw diagnostics lives under Advanced, reports its current state, and leaves normal context working when off", async ({ page }) => {
  const { state, more, panel, emit } = await setup(page);
  await expect(page.locator(".workspace-header")).not.toContainText("Trace");
  expect(await page.evaluate(() => window.optionsEventSourceUrls.every((url) => !url.includes("diagnostics=true")))).toBe(true);
  await page.getByTitle("Browse commands, tools, skills, MCP, and instructions").click();
  await expect.poll(() => state.requests.some((request) => request.command === "context_attribution")).toBe(true);
  await page.getByRole("dialog", { name: "Session context and references" })
    .getByRole("button", { name: "Close context", exact: true }).click();
  await more();
  const toggle = panel.getByRole("checkbox", { name: "Raw diagnostics", exact: true });
  await expect(toggle).toBeHidden();
  await panel.locator(".workspace-options-advanced > summary").click();
  await expect(toggle).not.toBeChecked();
  await expect(panel.locator(".workspace-diagnostics-option strong")).toHaveText("Raw diagnostics Off");
  await expect(panel).toContainText("Normal chat streaming and Context usage work with this off");
  await toggle.check();
  await expect(panel.locator(".workspace-diagnostics-option strong")).toHaveText("Raw diagnostics On");
  await expect.poll(() => page.evaluate(() => new URL(window.optionsEventSourceUrls.at(-1)!).searchParams.get("diagnostics"))).toBe("true");
  await panel.getByRole("button", { name: "Close additional options" }).click();
  await emit("model.call_start", { model: "fixture-model", inputTokens: 123 });
  await expect(page.locator(".raw-diagnostics")).toContainText("model.call_start");
  await more();
  await expect(panel.locator(".workspace-options-advanced > summary")).toContainText("Raw diagnostics on");
  await panel.locator(".workspace-options-advanced > summary").click();
  await toggle.uncheck();
  await expect.poll(() => page.evaluate(() => new URL(window.optionsEventSourceUrls.at(-1)!).searchParams.has("diagnostics"))).toBe(false);
  await panel.getByRole("button", { name: "Close additional options" }).click();
  await expect(page.locator(".raw-diagnostics")).toHaveCount(0);
  expect(state.requests.some((request) => ["send_message", "abort_session", "fork_session"].includes(request.command))).toBe(false);
});

test("Additional options traps focus, restores its trigger, and explains disabled actions without stopping work", async ({ page }) => {
  const { state, more, panel, emit } = await setup(page);
  state.processing = true;
  await emit("assistant.turn_start");
  await expect(page.locator(".composer-status strong")).toHaveText("Copilot is working");
  await more();
  const close = panel.getByRole("button", { name: "Close additional options" });
  await expect(close).toBeFocused();
  await close.press("Shift+Tab");
  await expect(panel.locator(".workspace-options-advanced > summary")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await expect(panel.getByRole("button", { name: "Fork conversation", exact: true })).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Fork conversation", exact: true })).toHaveAccessibleDescription(/Wait for the current turn/);
  await expect(panel.getByRole("button", { name: "Catch up", exact: true })).toBeDisabled();
  await close.press("Control+Shift+t");
  await expect(page.locator(".terminal-pane")).toHaveCount(0);
  await close.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Additional options", exact: true })).toBeFocused();
  expect(state.requests.some((request) => request.command === "abort_session")).toBe(false);
});

test.describe("mobile workspace options", () => {
  test.use({ isMobile: true, hasTouch: true });
  for (const width of [320, 440, 768]) {
    test(`${width}px toolbar has four labelled actions and options descriptions fit without horizontal scrolling`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      const { state, more, panel } = await setup(page);
      const toolbar = page.locator("#workspace-tools");
      const buttons = toolbar.locator("button:visible");
      await expect(buttons).toHaveCount(4);
      expect(await buttons.allInnerTexts()).toEqual(["Git", "Context", "Terminal", "More"]);
      const bounds = await buttons.evaluateAll((elements) => elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { height: rect.height, y: rect.y, fits: element.scrollWidth <= element.clientWidth + 1 };
      }));
      expect(bounds.every((item) => item.height >= 44 && item.y === bounds[0].y && item.fits)).toBe(true);
      await expect(page.locator(".workspace-header").getByRole("button", { name: "Rename session", exact: true })).toBeHidden();
      const composer = page.locator(".parent-session-view .composer textarea");
      await composer.fill("Keep this draft");
      await more();
      await expect(panel.getByRole("button", { name: "Fork conversation", exact: true })).toHaveAccessibleDescription(/does not create a Git branch/);
      expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await panel.screenshot({ path: testInfo.outputPath(`additional-options-${width}.png`) });
      await panel.getByRole("button", { name: "Fork conversation", exact: true }).tap();
      await expect(panel).toHaveCount(0);
      const fork = page.getByRole("dialog", { name: "Fork conversation", exact: true });
      await expect(fork).toBeVisible();
      await expect(fork.getByLabel("New session name", { exact: true })).toBeFocused();
      await fork.getByRole("button", { name: "Cancel", exact: true }).tap();
      await expect(composer).toHaveValue("Keep this draft");
      await more();
      await panel.getByRole("button", { name: "Ask about conversation", exact: true }).tap();
      const ask = page.getByRole("dialog", { name: "Ask about conversation", exact: true });
      await expect(ask).toBeVisible();
      await ask.getByRole("button", { name: "Close", exact: true }).tap();
      await more();
      await panel.getByRole("button", { name: "Rename session", exact: true }).tap();
      const rename = page.getByRole("dialog", { name: "Rename session", exact: true });
      await expect(rename.getByLabel("Session name", { exact: true })).toBeFocused();
      await rename.getByRole("button", { name: "Cancel", exact: true }).tap();
      await more();
      await panel.getByRole("button", { name: "App settings", exact: true }).tap();
      await expect(page.getByRole("button", { name: "Close settings", exact: true })).toBeFocused();
      await page.getByRole("button", { name: "Close settings", exact: true }).tap();
      await more();
      await panel.getByRole("button", { name: "Catch up", exact: true }).tap();
      await expect.poll(() => state.requests.filter((request) => request.command === "refresh_session").length).toBe(1);
      await expect(composer).toBeEnabled();
      await expect(composer).toHaveValue("Keep this draft");
      expect(state.requests.some((request) => ["send_message", "fork_session", "ask_session"].includes(request.command))).toBe(false);
    });
  }
});
