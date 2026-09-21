import { test, expect, type Page } from "@playwright/test";

const liveEvent = (sessionId: string, type: string, agentId?: string) => ({
  type: "session_event", sessionId,
  event: { id: crypto.randomUUID(), type, agentId, timestamp: "", data: { content: "Live activity" } },
});

async function setup(page: Page, options: { gate?: Promise<void>; count?: number; delayedB?: Promise<void> } = {}) {
  const rows = options.count
    ? Array.from({ length: options.count }, (_, index) => ({
      sessionId: index === 0 ? "a" : `active-${index}`, title: `Session ${index}`, isActive: true,
    }))
    : [
      { sessionId: "a", title: "Session A", isActive: true },
      { sessionId: "b", title: "Session B", isActive: true },
      { sessionId: "cold", title: "Saved session", isActive: false },
    ];
  const sessions = rows.map((row) => ({
    ...row, cwd: "Q:\\example", model: "model", pinned: false, archived: false, tags: [],
    isRemote: false, startTime: "", modifiedTime: "",
  }));
  const state = {
    processing: Object.fromEntries(sessions.map((session) => [session.sessionId, session.sessionId === "a"])),
    failures: {} as Record<string, string>,
    taskFailures: {} as Record<string, string>,
    tasks: {} as Record<string, { id: string; name: string; agentType: string; toolCallId: string; status: string; canMessage: boolean }[]>,
    malformed: new Set<string>(),
    requests: [] as { command: string; sessionId: string }[],
    activeReads: 0,
    maxReads: 0,
  };
  await page.addInitScript(() => {
    class ActivityEventSource extends EventTarget {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      events = (event: Event) => {
        if (event instanceof CustomEvent) this.dispatchEvent(new MessageEvent("session-event", { data: JSON.stringify(event.detail) }));
      };
      connection = (event: Event) => {
        if (event instanceof CustomEvent) {
          if (event.detail) this.onopen?.();
          else this.onerror?.();
        }
      };
      constructor() {
        super();
        window.addEventListener("activity-fixture-event", this.events);
        window.addEventListener("activity-fixture-connection", this.connection);
        setTimeout(() => this.onopen?.(), 0);
      }
      close() {
        window.removeEventListener("activity-fixture-event", this.events);
        window.removeEventListener("activity-fixture-connection", this.connection);
      }
    }
    Object.defineProperty(window, "EventSource", { value: ActivityEventSource });
  });
  await page.route("**/api/**", async (route) => {
    const command = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const args = route.request().postDataJSON() ?? {};
    state.requests.push({ command, sessionId: args.sessionId });
    let result: unknown;
    switch (command) {
      case "list_sessions": result = sessions; break;
      case "resume_session": result = sessions.find((session) => session.sessionId === args.sessionId); break;
      case "runtime_status": result = { connected: true, acceptingWork: true, activeSessions: sessions.filter((session) => session.isActive).length }; break;
      case "session_state": result = { sessionId: args.sessionId, processing: state.processing[args.sessionId], mode: "interactive" }; break;
      case "agent_tasks":
        if (state.taskFailures[args.sessionId]) return route.fulfill({ status: 500, body: state.taskFailures[args.sessionId] });
        result = { sessionId: args.sessionId, tasks: state.tasks[args.sessionId] ?? [] }; break;
      case "session_processing": {
        const value = state.processing[args.sessionId];
        state.activeReads++;
        state.maxReads = Math.max(state.maxReads, state.activeReads);
        try {
          if (options.gate) await options.gate;
          if (args.sessionId === "b" && options.delayedB) await options.delayedB;
          if (state.failures[args.sessionId]) return await route.fulfill({ status: 500, body: state.failures[args.sessionId] });
          return await route.fulfill({ json: state.malformed.has(args.sessionId) ? { processing: value } : value });
        } finally { state.activeReads--; }
      }
      case "pending_permissions": case "pending_interactions": case "subagent_context": result = []; break;
      case "queue_items": result = { items: [], steeringMessages: [] }; break;
      case "git_repository": result = { isRepository: false }; break;
      case "session_history_window": result = {
        events: [{ id: "u", type: "user.message", timestamp: "", data: { content: "Existing conversation" } }],
        hasMore: false, cursor: "", loadedPages: 1, humanMessages: 1,
      }; break;
      default: return route.fulfill({ status: 404, body: `Unexpected ${command}` });
    }
    return route.fulfill({ json: result });
  });
  await page.goto("/?session=a");
  await expect(page.locator(".parent-session-view .composer textarea")).toBeEnabled();
  const emit = (event: unknown) => page.evaluate((event) => window.dispatchEvent(new CustomEvent("activity-fixture-event", { detail: event })), event);
  return { state, emit };
}

test("small working and idle dots cover unselected attached sessions without resuming saved ones", async ({ page }, testInfo) => {
  const { state, emit } = await setup(page);
  const a = page.locator("[data-session-id='a']");
  const b = page.locator("[data-session-id='b']");
  await expect(a.getByRole("img", { name: "Working", exact: true })).toBeVisible();
  await expect(b.getByRole("img", { name: "Idle", exact: true })).toBeVisible();
  await expect(a.locator(".session-open")).toHaveAccessibleDescription("Working");
  await expect(b.locator(".session-open")).toHaveAccessibleDescription("Idle");
  await expect(page.locator("[data-session-id='cold']").getByRole("img", { name: "Not attached" })).toBeVisible();
  expect(state.requests.filter((request) => request.command === "resume_session").map((request) => request.sessionId)).toEqual(["a"]);
  expect(state.requests.some((request) => request.command === "session_processing" && request.sessionId === "cold")).toBe(false);
  state.processing.b = true;
  await emit(liveEvent("b", "assistant.turn_start"));
  await expect(b.getByRole("img", { name: "Working", exact: true })).toBeVisible();
  await emit(liveEvent("b", "assistant.turn_end"));
  await emit(liveEvent("b", "session.idle", "child-agent"));
  await expect(b.getByRole("img", { name: "Working", exact: true })).toBeVisible();
  state.processing.b = false;
  await emit(liveEvent("b", "session.idle"));
  await expect(b.getByRole("img", { name: "Idle", exact: true })).toBeVisible();
  await expect(a.getByRole("img", { name: "Working", exact: true })).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(a.locator(".session-activity-dot")).toHaveCSS("animation-name", "none");
  expect((await a.locator(".session-activity-dot").boundingBox())!.width).toBeLessThanOrEqual(10);
  await page.locator(".sidebar").screenshot({ path: testInfo.outputPath("session-activity-dots.png") });
});

test("activity remains live when browsing an archived attached session", async ({ page }) => {
  const { state, emit } = await setup(page);
  await expect(page.locator("[data-session-id='a'] .session-activity-dot")).toHaveAttribute("aria-label", "Working");
  await emit({ type: "session_archive_changed", sessionId: "a", archived: true });
  await expect(page.locator("[data-session-id='a']")).toHaveCount(0);
  await page.getByRole("combobox", { name: "Session view" }).selectOption("archived");
  const dot = page.locator("[data-session-id='a'] .session-activity-dot");
  await expect(dot).toHaveAttribute("aria-label", "Working");
  state.processing.a = false;
  await emit(liveEvent("a", "session.idle"));
  await expect(dot).toHaveAttribute("aria-label", "Idle");
  expect(state.requests.filter((request) => request.command === "resume_session")).toHaveLength(1);
});

test("an old status response cannot turn a newly working background session idle", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { state, emit } = await setup(page, { delayedB: gate });
  await expect.poll(() => state.requests.some((request) => request.command === "session_processing" && request.sessionId === "b")).toBe(true);
  state.processing.b = true;
  await emit(liveEvent("b", "user.message"));
  const dot = page.locator("[data-session-id='b'] .session-activity-dot");
  await expect(dot).toHaveAttribute("aria-label", "Working");
  const completed = page.waitForResponse((response) => response.url().endsWith("/api/session_processing")
    && response.request().postDataJSON().sessionId === "b");
  release();
  await (await completed).finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(dot).toHaveAttribute("aria-label", "Working");
});

test("connection loss clears known activity and reconnect obtains fresh state", async ({ page }) => {
  const { state } = await setup(page);
  const dot = page.locator("[data-session-id='a'] .session-activity-dot");
  await expect(dot).toHaveAttribute("aria-label", "Working");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("activity-fixture-connection", { detail: false })));
  await expect(dot).toHaveAttribute("aria-label", "Status unavailable");
  await expect(dot).toHaveAttribute("title", /disconnected/);
  state.processing.a = false;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("activity-fixture-connection", { detail: true })));
  await expect(dot).toHaveAttribute("aria-label", "Idle");
});

test("periodic reads recover missing events and failed status reads never masquerade as idle", async ({ page }) => {
  const { state } = await setup(page);
  const dot = page.locator("[data-session-id='b'] .session-activity-dot");
  await expect(dot).toHaveAttribute("aria-label", "Idle");
  state.failures.b = "Runtime status read failed";
  await expect(dot).toHaveAttribute("aria-label", "Status unavailable", { timeout: 8000 });
  await expect(dot).toHaveAttribute("title", /Runtime status read failed/);
  state.failures.b = "";
  state.processing.b = true;
  await expect(dot).toHaveAttribute("aria-label", "Working", { timeout: 8000 });
  state.malformed.add("b");
  await expect(dot).toHaveAttribute("aria-label", "Status unavailable", { timeout: 8000 });
  await expect(dot).toHaveAttribute("title", /valid processing state/);
});

test("background activity reads stay bounded for many attached sessions", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { state } = await setup(page, { gate, count: 12 });
  await expect.poll(() => state.requests.filter((request) => request.command === "session_processing").length).toBe(4);
  expect(state.maxReads).toBeLessThanOrEqual(4);
  release();
  await expect(page.locator(".session-activity-dot.idle")).toHaveCount(11);
  expect(state.maxReads).toBeLessThanOrEqual(4);
  expect(state.requests.filter((request) => request.command === "resume_session")).toHaveLength(1);
});

test("idle parents show running subagents in sidebar, full and compact headers, and composer without becoming busy", async ({ page }) => {
  const { state, emit } = await setup(page);
  state.tasks.a = [
    { id: "task-one", name: "Builder", agentType: "task", toolCallId: "call-one", status: "running", canMessage: true },
    { id: "task-two", name: "Reviewer", agentType: "task", toolCallId: "call-two", status: "running", canMessage: true },
    { id: "task-three", name: "Idle agent", agentType: "task", toolCallId: "call-three", status: "idle", canMessage: true },
  ];
  state.processing.a = false;
  await emit(liveEvent("a", "session.idle"));
  const dot = page.locator("[data-session-id='a'] .session-activity-dot");
  await expect(dot).toHaveAttribute("aria-label", "2 subagents working");
  await expect(page.locator(".session-context .session-activity")).toHaveText("2 subagents working");
  await expect(page.locator(".composer-status")).toContainText("Parent idle · 2 subagents working");
  await expect(page.getByRole("button", { name: "Fork conversation", exact: true })).toBeEnabled();
  await expect(page.locator(".composer-status").getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Collapse chat header" }).click();
  await expect(page.locator(".compact-session-activity")).toHaveAttribute("aria-label", "2 subagents working");
  state.tasks.a[0].status = "completed";
  await emit({ ...liveEvent("a", "subagent.completed", "unrelated-event-identity"),
    event: { ...liveEvent("a", "subagent.completed").event, data: { toolCallId: "call-one" } } });
  await expect(dot).toHaveAttribute("aria-label", "1 subagent working");
  state.processing.a = true;
  await emit(liveEvent("a", "assistant.turn_start"));
  await expect(dot).toHaveAttribute("aria-label", "Working");
  await expect(page.locator(".compact-session-activity")).toHaveAttribute("aria-label", "Copilot working");
  state.tasks.a[1].status = "failed";
  state.processing.a = false;
  await emit(liveEvent("a", "session.idle"));
  await expect(dot).toHaveAttribute("aria-label", "Idle");
  expect(state.requests.some((request) => request.command === "agent_tasks" && request.sessionId === "cold")).toBe(false);
  expect(state.requests.filter((request) => request.command === "resume_session")).toHaveLength(1);
});

test("subagent counts recover on reload and failures never pretend all child work is done", async ({ page }) => {
  const { state, emit } = await setup(page);
  state.processing.a = false;
  state.tasks.a = [{ id: "one", name: "Builder", agentType: "task", toolCallId: "invocation", status: "running", canMessage: true }];
  await page.reload();
  const dot = page.locator("[data-session-id='a'] .session-activity-dot");
  await expect(dot).toHaveAttribute("aria-label", "1 subagent working");
  state.taskFailures.a = "Subagent lookup unavailable";
  await emit(liveEvent("a", "subagent.completed"));
  await expect(dot).toHaveAttribute("aria-label", "Subagent status unavailable");
  await expect(dot).toHaveAttribute("title", /Subagent lookup unavailable/);
  state.taskFailures.a = "";
  state.tasks.a = [];
  await emit(liveEvent("a", "task.updated"));
  await expect(dot).toHaveAttribute("aria-label", "Idle");
});
