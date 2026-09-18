import { test, expect, type Page } from "@playwright/test";
import type { ScheduledTask } from "../../src/lib/schedules";

const stamp = "2030-01-01T12:00:00Z";
const task = (extra: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: "briefing", name: "Morning briefing", prompt: "Use my review skill to summarize overnight changes.",
  sessionId: null, cwd: "Q:\\example", model: null, schedule: { kind: "daily", time: "09:00", timeZone: "America/Los_Angeles" },
  enabled: true, nextRunAt: "2030-01-02T17:00:00Z", createdAt: stamp, updatedAt: stamp, runs: [], ...extra,
});
const session = (sessionId: string) => ({
  sessionId, title: sessionId === "briefing-session" ? "Morning briefing" : "Existing conversation",
  cwd: "Q:\\example", model: "model", isActive: true, isRemote: false, archived: false, pinned: false, tags: [],
  startTime: "", modifiedTime: "",
});

async function setup(page: Page, tasks: ScheduledTask[] = []) {
  const state = { tasks, failList: false, failSave: false, requests: [] as { command: string; args: Record<string, unknown> }[] };
  await page.addInitScript(() => {
    class SchedulerEvents extends EventTarget {
      onopen: (() => void) | null = null;
      constructor() { super(); setTimeout(() => this.onopen?.(), 0); }
      close() {}
    }
    Object.defineProperty(window, "EventSource", { value: SchedulerEvents });
  });
  await page.route("**/api/**", (route) => {
    const command = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const args = route.request().postDataJSON() ?? {};
    state.requests.push({ command, args });
    let value: unknown;
    switch (command) {
      case "list_sessions": value = [session("existing"), ...state.tasks.filter((task) => task.sessionId).map((task) => session(task.sessionId!))]; break;
      case "resume_session": value = session(args.sessionId); break;
      case "runtime_status": value = { connected: true, acceptingWork: true, activeSessions: 1 }; break;
      case "session_state": value = { sessionId: args.sessionId, mode: "interactive", processing: false }; break;
      case "session_processing": value = false; break;
      case "queue_items": value = { items: [], steeringMessages: [] }; break;
      case "pending_permissions": case "pending_interactions": case "subagent_context": value = []; break;
      case "git_repository": value = { isRepository: false }; break;
      case "session_history_window": value = {
        events: [
          ...(args.sessionId === "briefing-session" ? [{
            id: "scheduled-prompt", type: "user.message", timestamp: stamp,
            data: { content: "Prepare the daily briefing.", source: "schedule-123" },
          }] : []),
          { id: args.sessionId, type: "assistant.message", timestamp: "", data: { content: args.sessionId === "briefing-session" ? "Overnight briefing result" : "Existing conversation" } },
        ],
        hasMore: false, cursor: "", loadedPages: 1, humanMessages: 0,
      }; break;
      case "list_scheduled_tasks":
        if (state.failList) return route.fulfill({ status: 500, body: "Schedules file is corrupt" });
        value = { tasks: state.tasks }; break;
      case "save_scheduled_task": {
        if (state.failSave) return route.fulfill({ status: 500, body: "Could not persist schedule" });
        const saved = task({ ...state.tasks.find((entry) => entry.id === args.id), ...args, id: args.id ?? "new-task" });
        state.tasks = [...state.tasks.filter((entry) => entry.id !== saved.id), saved];
        value = saved;
        break;
      }
      case "set_scheduled_task_enabled":
        state.tasks = state.tasks.map((entry) => entry.id === args.id ? { ...entry, enabled: args.enabled } : entry);
        value = state.tasks.find((entry) => entry.id === args.id);
        break;
      case "run_scheduled_task":
        state.tasks = state.tasks.map((entry) => entry.id === args.id ? {
          ...entry, sessionId: entry.sessionId ?? "briefing-session",
          runs: [{ id: "run-1", scheduledFor: stamp, startedAt: stamp, finishedAt: null, status: "running", error: null }],
        } : entry);
        value = state.tasks.find((entry) => entry.id === args.id);
        break;
      case "delete_scheduled_task":
        state.tasks = state.tasks.filter((entry) => entry.id !== args.id);
        value = null; break;
      default: return route.fulfill({ status: 404, body: `Unexpected ${command}` });
    }
    return route.fulfill({ json: value });
  });
  await page.goto("/?session=existing");
  await expect(page.locator(".parent-session-view .composer textarea")).toBeEnabled();
  const open = async () => {
    await page.getByRole("button", { name: "Scheduled tasks", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "Scheduled tasks", exact: true });
    await expect(panel).toBeVisible();
    return panel;
  };
  return { state, open };
}

test("creating a daily briefing requires explicit saving and preserves the current chat draft", async ({ page }, testInfo) => {
  const { state, open } = await setup(page);
  const composer = page.locator(".parent-session-view .composer textarea");
  await composer.fill("Keep this draft");
  const panel = await open();
  await panel.getByRole("button", { name: "New scheduled task", exact: true }).click();
  await expect(panel.getByLabel("Conversation", { exact: true })).toHaveValue("");
  await panel.getByLabel("Task name", { exact: true }).fill("Daily briefing");
  await panel.getByRole("button", { name: "Use briefing template", exact: true }).click();
  await panel.getByRole("button", { name: "Save schedule", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Replace the briefing template");
  expect(state.requests.some((request) => request.command === "save_scheduled_task")).toBe(false);
  await panel.getByLabel("Prompt or skill instructions", { exact: true }).fill("Use the overnight-review skill for my repo and provide source links.");
  await panel.getByLabel("Time", { exact: true }).fill("08:30");
  await panel.getByLabel("Time zone", { exact: true }).fill("America/Los_Angeles");
  await page.screenshot({ path: testInfo.outputPath("daily-briefing-editor.png") });
  await panel.getByRole("button", { name: "Save schedule", exact: true }).click();
  await expect(panel.getByRole("article", { name: "Scheduled task Daily briefing" })).toBeVisible();
  const saved = state.requests.find((request) => request.command === "save_scheduled_task")!.args;
  expect(saved).toMatchObject({ name: "Daily briefing", sessionId: null, cwd: "Q:\\example", enabled: true,
    schedule: { kind: "daily", time: "08:30", timeZone: "America/Los_Angeles" } });
  expect(state.requests.some((request) => ["send_message", "create_session", "run_scheduled_task"].includes(request.command))).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("scheduled-briefing-list.png") });
  await panel.getByRole("button", { name: "Close scheduled tasks", exact: true }).click();
  await expect(composer).toHaveValue("Keep this draft");
});

test("one-off prompts target a chosen conversation and convert local time to UTC", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { state, open } = await setup(page);
  const panel = await open();
  await panel.getByRole("button", { name: "New scheduled task", exact: true }).click();
  await panel.getByLabel("Prompt or skill instructions", { exact: true }).fill("Summarize today's changes.");
  await panel.getByLabel("Conversation", { exact: true }).selectOption("existing");
  await panel.getByLabel("Schedule", { exact: true }).selectOption("once");
  await panel.getByLabel("Run at (your local time)", { exact: true }).fill("2030-01-02T09:15");
  await panel.getByLabel("Enable automatic runs", { exact: true }).uncheck();
  await panel.getByRole("button", { name: "Save schedule", exact: true }).click();
  const saved = state.requests.find((request) => request.command === "save_scheduled_task")!.args;
  expect(saved.sessionId).toBe("existing");
  expect(saved.enabled).toBe(false);
  const expected = await page.evaluate(() => new Date("2030-01-02T09:15").toISOString());
  expect(saved.schedule).toEqual({ kind: "once", at: expected });
  await expect(panel).toContainText("Schedule saved paused");
});

test("Run now binds one ongoing conversation; pause and deletion never delete its history", async ({ page }) => {
  const { state, open } = await setup(page, [task()]);
  const panel = await open();
  const entry = panel.getByRole("article", { name: "Scheduled task Morning briefing" });
  await entry.getByRole("button", { name: "Run now", exact: true }).click();
  await expect(entry.getByRole("button", { name: "Run now", exact: true })).toBeDisabled();
  await expect(entry).toContainText("Running");
  await entry.getByRole("button", { name: "Pause schedule", exact: true }).click();
  expect(state.tasks[0].enabled).toBe(false);
  expect(state.tasks[0].runs[0].status).toBe("running");
  await entry.getByRole("button", { name: "Open conversation", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Morning briefing", exact: true })).toBeVisible();
  await expect(page.locator(".message.assistant")).toContainText("Overnight briefing result");
  await expect(page.locator(".message[data-message-origin='scheduled'] .message-role")).toHaveText("Scheduled task");
  await expect(page.locator(".message[data-message-origin='scheduled']")).not.toHaveAttribute("data-root-human");
  await open();
  page.once("dialog", (dialog) => dialog.accept());
  await entry.getByRole("button", { name: "Delete schedule", exact: true }).click();
  await expect(entry).toHaveCount(0);
  expect(state.requests.some((request) => ["delete_session", "abort_session", "send_message"].includes(request.command))).toBe(false);
});

test("invalid persistence and saves surface errors without losing the edited prompt", async ({ page }) => {
  const { state, open } = await setup(page);
  state.failList = true;
  const panel = await open();
  await expect(panel.getByRole("alert")).toContainText("Schedules file is corrupt");
  await expect(panel.getByRole("button", { name: "New scheduled task", exact: true })).toBeDisabled();
  state.failList = false;
  await panel.getByRole("button", { name: "Refresh schedules", exact: true }).click();
  await panel.getByRole("button", { name: "New scheduled task", exact: true }).click();
  await panel.getByLabel("Prompt or skill instructions", { exact: true }).fill("Keep my authored instructions");
  state.failSave = true;
  await panel.getByRole("button", { name: "Save schedule", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Could not persist");
  await expect(panel.getByLabel("Prompt or skill instructions", { exact: true })).toHaveValue("Keep my authored instructions");
  expect(state.tasks).toHaveLength(0);
});

test("editing a bound briefing preserves its conversation and draft through status refreshes", async ({ page }) => {
  const { state, open } = await setup(page, [task({ sessionId: "briefing-session" })]);
  const panel = await open();
  await panel.getByRole("button", { name: "Edit schedule", exact: true }).click();
  await expect(panel.getByLabel("Conversation", { exact: true })).toBeDisabled();
  await expect(panel.getByLabel("Conversation", { exact: true })).toHaveValue("briefing-session");
  await panel.getByLabel("Prompt or skill instructions", { exact: true }).fill("Updated daily briefing instructions");
  await panel.getByRole("button", { name: "Refresh schedules", exact: true }).click();
  await expect(panel.getByLabel("Prompt or skill instructions", { exact: true })).toHaveValue("Updated daily briefing instructions");
  await panel.getByRole("button", { name: "Save schedule", exact: true }).click();
  const saved = state.requests.find((request) => request.command === "save_scheduled_task")!.args;
  expect(saved.sessionId).toBe("briefing-session");
  expect(saved.id).toBe("briefing");
  expect(saved.prompt).toBe("Updated daily briefing instructions");
  expect(state.requests.some((request) => ["send_message", "create_session", "run_scheduled_task"].includes(request.command))).toBe(false);
});

test("editing an overdue one-off preserves its original due instant", async ({ page }) => {
  const at = "2020-11-01T06:30:12Z";
  const { state, open } = await setup(page, [task({ enabled: false, schedule: { kind: "once", at }, nextRunAt: at })]);
  const panel = await open();
  await panel.getByRole("button", { name: "Edit schedule", exact: true }).click();
  await panel.getByLabel("Prompt or skill instructions", { exact: true }).fill("Updated overdue prompt");
  await panel.getByRole("button", { name: "Save schedule", exact: true }).click();
  const saved = state.requests.find((request) => request.command === "save_scheduled_task")!.args;
  expect(saved.schedule).toEqual({ kind: "once", at });
  expect(saved.enabled).toBe(false);
  await expect(panel.getByRole("form", { name: "Schedule editor" })).toHaveCount(0);
});

test("uncertain run history warns about duplicates before enabling another automatic run", async ({ page }) => {
  const uncertain = task({ enabled: false, sessionId: "briefing-session", runs: [{
    id: "uncertain", scheduledFor: stamp, startedAt: stamp, finishedAt: stamp, status: "uncertain",
    error: "Daemon stopped during dispatch. Inspect the conversation before retrying.",
  }] });
  const { state, open } = await setup(page, [uncertain]);
  const panel = await open();
  await expect(panel).toContainText("delivery is uncertain");
  await expect(panel.getByRole("button", { name: "Run now", exact: true })).toBeDisabled();
  page.once("dialog", (dialog) => dialog.dismiss());
  await panel.getByRole("button", { name: "Enable schedule", exact: true }).click();
  expect(state.requests.some((request) => request.command === "set_scheduled_task_enabled")).toBe(false);
  await panel.locator("summary").click();
  await expect(panel).toContainText("Daemon stopped during dispatch");
  await panel.getByRole("button", { name: "Edit schedule", exact: true }).click();
  await panel.getByLabel("Enable automatic runs", { exact: true }).check();
  page.once("dialog", (dialog) => dialog.dismiss());
  await panel.getByRole("button", { name: "Save schedule", exact: true }).click();
  expect(state.requests.some((request) => request.command === "save_scheduled_task")).toBe(false);
  await expect(panel.getByRole("form", { name: "Schedule editor" })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await panel.getByRole("button", { name: "Save schedule", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Pause schedule", exact: true })).toBeVisible();
});

test.describe("mobile schedule editor", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test("editor stays within the viewport and keyboard shortcuts do not act on the background chat", async ({ page }) => {
    const { open } = await setup(page);
    await page.getByRole("button", { name: "Open sessions", exact: true }).tap();
    const panel = await open();
    await panel.getByRole("button", { name: "New scheduled task", exact: true }).tap();
    await panel.getByLabel("Prompt or skill instructions", { exact: true }).fill("Daily mobile briefing");
    await panel.getByLabel("Prompt or skill instructions", { exact: true }).press("Control+Shift+t");
    await expect(page.locator(".terminal-pane")).toHaveCount(0);
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await panel.getByRole("button", { name: "Cancel edit", exact: true }).tap();
    await panel.getByRole("button", { name: "Close scheduled tasks", exact: true }).tap();
    await expect(panel).toHaveCount(0);
  });
});
