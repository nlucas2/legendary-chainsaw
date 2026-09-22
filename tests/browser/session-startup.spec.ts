import { expect, test, type Page, type Route } from "@playwright/test";
import type { SessionInitialization } from "../../src/lib/types";

async function setup(page: Page) {
  const session = (sessionId: string, initialization?: SessionInitialization) => ({
    sessionId, title: sessionId === "new" ? state.createdName || "New session" : "Existing session", cwd: "Q:\\example",
    model: "requested-model", isActive: sessionId === "new" ? state.attached : true, isRemote: false, archived: false, pinned: false,
    tags: [], startTime: "", modifiedTime: "", initialization,
  });
  const state = {
    initialization: { phase: "initializing", stage: "tools" } as SessionInitialization,
    created: false, legacy: false, invalid: false, attached: true, resumeReady: false,
    createdName: "",
    holdStatus: false, held: [] as Route[],
    holdCreate: false, heldCreates: [] as Route[],
    holdLists: false, heldLists: [] as Route[], omitCreated: false, staleAttachment: false,
    holdPermissions: false, heldPermissions: [] as Route[], extraSessions: 0,
    requests: [] as { command: string; args: Record<string, unknown> }[],
  };
  await page.addInitScript(() => {
    class StartupEvents extends EventTarget {
      onopen: (() => void) | null = null;
      listener = (event: Event) => {
        if (event instanceof CustomEvent) this.dispatchEvent(new MessageEvent("session-event", { data: JSON.stringify(event.detail) }));
      };
      constructor() { super(); window.addEventListener("startup-event", this.listener); setTimeout(() => this.onopen?.(), 0); }
      close() { window.removeEventListener("startup-event", this.listener); }
    }
    Object.defineProperty(window, "EventSource", { value: StartupEvents });
  });
  const snapshot = () => ({
    sessionId: state.invalid ? "wrong" : "new", initialization: state.initialization,
    session: { ...session("new", state.initialization), model: state.initialization.phase === "ready" ? "resolved-model" : "requested-model" },
  });
  await page.route("**/api/**", async (route) => {
    const command = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const args = route.request().postDataJSON() ?? {};
    state.requests.push({ command, args });
    let result: unknown;
    switch (command) {
      case "get_profile_library": result = { directory: "Q:\\profiles", revision: "empty", groups: [], profiles: [] }; break;
      case "get_session_profile": result = { sessionId: args.sessionId, profile: null, applying: false, configurationBlocked: false, requiresReconnect: false, error: null }; break;
      case "list_sessions":
        if (state.holdLists) { state.heldLists.push(route); return; }
        result = [session("old"), ...Array.from({ length: state.extraSessions }, (_, index) => session(`older-${index}`)),
          ...(state.created && !state.omitCreated
            ? [state.staleAttachment ? { ...session("new"), isActive: false } : session("new", state.initialization)] : [])];
        break;
      case "resume_session":
        if (args.sessionId === "new" && state.resumeReady) {
          state.attached = true;
          state.initialization = { phase: "ready", stage: "ready" };
          result = session("new");
        } else result = session(args.sessionId, args.sessionId === "new" ? state.initialization : undefined);
        break;
      case "create_session":
        state.createdName = typeof args.name === "string" ? args.name : "";
        if (state.holdCreate) { state.heldCreates.push(route); return; }
        state.created = true;
        result = session("new", state.legacy ? undefined : state.initialization);
        break;
      case "session_initialization":
        if (state.holdStatus) { state.held.push(route); return; }
        result = snapshot(); break;
      case "retry_session_initialization":
        state.initialization = { phase: "initializing", stage: "tools" };
        result = snapshot(); break;
      case "available_models": result = { models: [] }; break;
      case "runtime_status": result = { connected: true, acceptingWork: true, activeSessions: state.created ? 2 : 1 }; break;
      case "session_state": result = { sessionId: args.sessionId, mode: "interactive", processing: false }; break;
      case "session_processing": result = false; break;
      case "queue_items": result = { items: [], steeringMessages: [] }; break;
      case "pending_permissions":
        if (state.holdPermissions) { state.heldPermissions.push(route); return; }
        result = []; break;
      case "pending_interactions": case "subagent_context": result = []; break;
      case "git_repository": result = { isRepository: false }; break;
      case "session_history_window":
        result = {
          events: args.sessionId === "old" ? [{ id: "old-user", type: "user.message", timestamp: "", data: { content: "Previous conversation" } }] : [],
          hasMore: false, cursor: "", loadedPages: 1, humanMessages: args.sessionId === "old" ? 1 : 0,
        }; break;
      case "send_message": result = "sent"; break;
      default: return route.fulfill({ status: 404, body: `Unexpected ${command}` });
    }
    return route.fulfill({ json: result });
  });
  await page.goto("/?session=old");
  await expect(page.locator(".parent-session-view .composer textarea")).toBeEnabled();
  const emit = async () => page.evaluate((initialization) => window.dispatchEvent(new CustomEvent("startup-event", { detail: {
    type: "session_initialization_changed", sessionId: "new", initialization,
  } })), state.initialization);
  const create = async () => {
    await page.getByRole("button", { name: /New session/ }).first().click();
    const dialog = page.getByRole("dialog", { name: "New session", exact: true });
    await dialog.getByRole("button", { name: "Create session", exact: true }).click();
    await expect(dialog).toHaveCount(0, { timeout: 1500 });
    await expect(page.getByRole("heading", { name: "New session", exact: true })).toBeVisible();
  };
  const refreshList = () => page.evaluate(() => window.dispatchEvent(new CustomEvent("startup-event", { detail: {
    type: "session_attached", sessionId: "another-session",
  } })));
  return { state, create, emit, snapshot, session, refreshList };
}

test("optional creation name appears immediately and survives warmup, navigation, and reload", async ({ page }) => {
  const { state, emit } = await setup(page);
  await page.getByRole("button", { name: /New session/ }).first().click();
  const dialog = page.getByRole("dialog", { name: "New session", exact: true });
  const name = dialog.getByRole("textbox", { name: "Session name (optional)", exact: true });
  await expect(name).toHaveValue("");
  await expect(name).toHaveAttribute("maxlength", "100");
  await name.fill("  My new investigation  ");
  await dialog.getByRole("button", { name: "Create session", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "My new investigation", exact: true })).toBeVisible();
  await expect(page.locator("[data-session-id='new'] .session-main strong")).toHaveText("My new investigation");
  await expect(page.locator(".session-startup")).toContainText("Initializing");
  await page.locator("[data-session-id='old'] .session-open").click();
  await page.locator("[data-session-id='new'] .session-open").click();
  await expect(page.getByRole("heading", { name: "My new investigation", exact: true })).toBeVisible();
  state.initialization = { phase: "ready", stage: "ready" };
  await emit();
  await expect(page.locator(".session-startup")).toHaveCount(0);
  await page.reload();
  await expect(page.locator("[data-session-id='new'] .session-main strong")).toHaveText("My new investigation");
  await page.locator("[data-session-id='new'] .session-open").click();
  await expect(page.getByRole("heading", { name: "My new investigation", exact: true })).toBeVisible();
  expect(state.requests.filter((request) => request.command === "create_session").map((request) => request.args.name)).toEqual(["My new investigation"]);
  expect(state.requests.some((request) => ["rename_session", "send_message"].includes(request.command))).toBe(false);
  await page.getByRole("button", { name: /New session/ }).first().click();
  await expect(dialog.getByRole("textbox", { name: "Session name (optional)", exact: true })).toHaveValue("");
});

test("blank optional creation name keeps default naming and creation errors retain the entered name", async ({ page }) => {
  const { state, create } = await setup(page);
  await create();
  expect(state.requests.find((request) => request.command === "create_session")!.args).not.toHaveProperty("name");
  await page.getByRole("button", { name: /New session/ }).first().click();
  const dialog = page.getByRole("dialog", { name: "New session", exact: true });
  const name = dialog.getByRole("textbox", { name: "Session name (optional)", exact: true });
  await name.fill("Keep this after failure");
  state.holdCreate = true;
  await dialog.getByRole("button", { name: "Create session", exact: true }).click();
  await expect(name).toBeDisabled();
  await expect.poll(() => state.heldCreates.length).toBe(1);
  await state.heldCreates[0].fulfill({ status: 500, body: "Native creation failed" });
  await expect(name).toBeEnabled();
  await expect(name).toHaveValue("Keep this after failure");
});

test("new workspace opens before warmup completes without a second resume or empty-history read", async ({ page }) => {
  const { state, create, emit } = await setup(page);
  const composer = page.locator(".parent-session-view .composer textarea");
  await composer.fill("Preserve old session draft");
  await create();
  const startup = page.getByRole("status", { name: "Session startup" });
  await expect(startup).toContainText("Initializing tools and MCP");
  await expect(composer).toBeEnabled();
  await composer.fill("A new message drafted while waiting");
  await composer.press("Enter");
  expect(state.requests.filter((request) => request.command === "send_message")).toHaveLength(0);
  expect(state.requests.filter((request) => request.args.sessionId === "new" && ["resume_session", "session_history_window"].includes(request.command))).toHaveLength(0);
  expect(state.requests.find((request) => request.command === "create_session")?.args.deferInitialization).toBe(true);
  state.initialization = { phase: "initializing", stage: "model" };
  await emit();
  await expect(startup).toContainText("Resolving session model");
  state.initialization = { phase: "ready", stage: "ready" };
  await emit();
  await expect(startup).toHaveCount(0);
  await expect(page.getByRole("button", { name: "resolved-model", exact: true })).toBeVisible();
  await expect(composer).toHaveValue("A new message drafted while waiting");
  await composer.press("Enter");
  await expect.poll(() => state.requests.filter((request) => request.command === "send_message").length).toBe(1);
  await page.locator("[data-session-id='old'] .session-open").click();
  await expect(composer).toHaveValue("Preserve old session draft");
});

test("initialization failure stays in the created workspace and Retry reuses the same session", async ({ page }) => {
  const { state, create, emit } = await setup(page);
  await create();
  const composer = page.locator(".parent-session-view .composer textarea");
  await composer.fill("Keep on retry");
  state.initialization = { phase: "failed", stage: "tools", error: "Tool startup timed out" };
  await emit();
  const failed = page.getByRole("alert", { name: "Session startup" });
  await expect(failed).toContainText("Tool startup timed out");
  await composer.press("Control+q");
  expect(state.requests.filter((request) => request.command === "send_message")).toHaveLength(0);
  await failed.getByRole("button", { name: "Retry initialization" }).click();
  await expect(page.getByRole("status", { name: "Session startup" })).toContainText("Initializing tools");
  expect(state.requests.filter((request) => request.command === "create_session")).toHaveLength(1);
  expect(state.requests.filter((request) => request.command === "retry_session_initialization").map((request) => request.args.sessionId)).toEqual(["new"]);
  state.initialization = { phase: "ready", stage: "ready" };
  await emit();
  await expect(page.locator(".session-startup")).toHaveCount(0);
  await expect(composer).toHaveValue("Keep on retry");
});

test("late startup completion does not switch back from another session", async ({ page }) => {
  const { state, create, emit } = await setup(page);
  await create();
  await page.locator(".parent-session-view .composer textarea").fill("New draft");
  await page.locator("[data-session-id='old'] .session-open").click();
  state.initialization = { phase: "ready", stage: "ready" };
  await emit();
  await expect(page.getByRole("heading", { name: "Existing session", exact: true })).toBeVisible();
  await expect(page.locator(".session-startup")).toHaveCount(0);
  await page.locator("[data-session-id='new'] .session-open").click();
  await expect(page.locator(".session-startup")).toHaveCount(0);
  await expect(page.locator(".parent-session-view .composer textarea")).toHaveValue("New draft");
  expect(state.requests.filter((request) => request.command === "create_session")).toHaveLength(1);
});

test("missed startup events recover through polling, while invalid responses cannot enable sending", async ({ page }) => {
  const { state, create } = await setup(page);
  state.invalid = true;
  await create();
  await expect(page.getByRole("alert", { name: "Session startup" })).toContainText("mismatched");
  const composer = page.locator(".parent-session-view .composer textarea");
  await composer.fill("Wait for verified readiness");
  await composer.press("Enter");
  expect(state.requests.filter((request) => request.command === "send_message")).toHaveLength(0);
  state.invalid = false;
  state.initialization = { phase: "ready", stage: "ready" };
  await expect(page.locator(".session-startup")).toHaveCount(0);
  await composer.press("Enter");
  await expect.poll(() => state.requests.filter((request) => request.command === "send_message").length).toBe(1);
});

test("already-ready legacy creation remains usable without redundant attachment", async ({ page }) => {
  const { state, create } = await setup(page);
  state.legacy = true;
  await create();
  await expect(page.locator(".session-startup")).toHaveCount(0);
  await page.locator(".parent-session-view .composer textarea").fill("Ready now");
  await page.locator(".parent-session-view .composer textarea").press("Enter");
  await expect.poll(() => state.requests.filter((request) => request.command === "send_message").length).toBe(1);
  expect(state.requests.filter((request) => request.args.sessionId === "new" && ["session_initialization", "resume_session"].includes(request.command))).toHaveLength(0);
});

test("a stale ready read cannot override a newer failure event", async ({ page }) => {
  const { state, create, emit, snapshot } = await setup(page);
  state.holdStatus = true;
  await create();
  await expect.poll(() => state.held.length).toBe(1);
  const old = { ...snapshot(), initialization: { phase: "ready", stage: "ready" } };
  state.initialization = { phase: "failed", stage: "tools", error: "Newer failure" };
  await emit();
  await state.held[0].fulfill({ json: old });
  await expect(page.getByRole("alert", { name: "Session startup" })).toContainText("Newer failure");
  await page.locator(".parent-session-view .composer textarea").fill("Not ready");
  await page.locator(".parent-session-view .composer textarea").press("Enter");
  expect(state.requests.filter((request) => request.command === "send_message")).toHaveLength(0);
});

test("reloading a preparing session rejoins its startup status without creating or resuming again", async ({ page }) => {
  const { state, create } = await setup(page);
  await create();
  await page.goto("/?session=new");
  await expect(page.getByRole("heading", { name: "New session", exact: true })).toBeVisible();
  await expect(page.locator(".session-startup")).toContainText("Initializing tools");
  expect(state.requests.filter((request) => request.command === "create_session")).toHaveLength(1);
  expect(state.requests.filter((request) => request.command === "resume_session" && request.args.sessionId === "new")).toHaveLength(0);
  state.initialization = { phase: "ready", stage: "ready" };
  await expect(page.locator(".session-startup")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "resolved-model", exact: true })).toBeVisible();
});

test("explicit resume after disconnection clears stale failed startup UI", async ({ page }) => {
  const { state, create, emit } = await setup(page);
  await create();
  await page.locator("[data-session-id='old'] .session-open").click();
  state.attached = false;
  state.initialization = { phase: "failed", stage: "tools", error: "Session disconnected" };
  state.resumeReady = true;
  await emit();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("startup-event", { detail: {
    type: "session_attached", sessionId: "new",
  } })));
  await expect(page.locator("[data-session-id='new'] .session-activity-dot")).toHaveAttribute("aria-label", "Not attached");
  await page.locator("[data-session-id='new'] .session-open").click();
  await expect(page.locator(".session-startup")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "resolved-model", exact: true })).toBeVisible();
  await page.locator(".parent-session-view .composer textarea").fill("Continue recovered session");
  await page.locator(".parent-session-view .composer textarea").press("Enter");
  await expect.poll(() => state.requests.filter((request) => request.command === "send_message").length).toBe(1);
  expect(state.requests.filter((request) => request.command === "create_session")).toHaveLength(1);
});

test("slow native creation has explicit pending status and no fake session or duplicate request", async ({ page }) => {
  const { state, session } = await setup(page);
  state.holdCreate = true;
  await page.getByRole("button", { name: /New session/ }).first().click();
  const dialog = page.getByRole("dialog", { name: "New session", exact: true });
  await dialog.getByRole("button", { name: "Create session", exact: true }).click();
  await expect(page.getByRole("status", { name: "Session creation" })).toContainText("Waiting for Copilot");
  await expect(dialog.getByRole("button", { name: "Creating...", exact: true })).toBeDisabled();
  await expect(page.locator("[data-session-id]")).toHaveCount(1);
  expect(state.requests.filter((request) => request.command === "send_message")).toHaveLength(0);
  await expect.poll(() => state.heldCreates.length).toBe(1);
  state.created = true;
  await state.heldCreates[0].fulfill({ json: session("new", state.initialization) });
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Unfiled sessions" }).locator("[data-session-id='new']")).toBeVisible();
  expect(state.requests.filter((request) => request.command === "create_session")).toHaveLength(1);
});

test("stale list cannot erase a new real row and slow enrichment cannot keep creation busy", async ({ page }) => {
  const { state, create, session, refreshList } = await setup(page);
  state.holdLists = true;
  await refreshList();
  await expect.poll(() => state.heldLists.length).toBe(1);
  state.holdPermissions = true;
  await create();
  await expect.poll(() => state.heldPermissions.length).toBe(1);
  await state.heldLists[0].fulfill({ json: [session("old")] });
  const row = page.locator("[data-session-id='new'] .session-open");
  await expect(row).toBeVisible();
  await page.locator(".parent-session-view .composer textarea").fill("Retained new draft");
  await page.locator("[data-session-id='old'] .session-open").click();
  await row.click();
  await expect(page.locator(".session-startup")).toContainText("Initializing tools");
  await expect(page.locator(".parent-session-view .composer textarea")).toHaveValue("Retained new draft");
  expect(state.requests.filter((request) => request.command === "resume_session" && request.args.sessionId === "new")).toHaveLength(0);
  expect(state.requests.filter((request) => request.command === "send_message")).toHaveLength(0);
  await page.getByRole("button", { name: /New session/ }).first().click();
  await expect(page.getByRole("dialog", { name: "New session", exact: true })
    .getByRole("button", { name: "Create session", exact: true })).toBeEnabled();
});

test("stale attachment and activity reads cannot hide or resume the preparing session", async ({ page }) => {
  const { state, create, refreshList } = await setup(page);
  await create();
  state.staleAttachment = true;
  state.extraSessions = 150;
  await refreshList();
  await expect(page.getByLabel("Session view")).toContainText("152");
  await expect(page.locator("[data-session-id='new'] .session-open")).toBeVisible();
  await page.locator("[data-session-id='old'] .session-open").click();
  await page.locator("[data-session-id='new'] .session-open").click();
  await expect(page.locator(".session-startup")).toContainText("Initializing tools");
  expect(state.requests.filter((request) => request.args.sessionId === "new"
    && ["resume_session", "session_processing", "agent_tasks"].includes(request.command))).toHaveLength(0);
});

test("a real indexed session still attaching can be reopened without joining blocking resume", async ({ page }) => {
  const { state, create, emit, refreshList } = await setup(page);
  await create();
  state.attached = false;
  await refreshList();
  await expect(page.locator("[data-session-id='new'] .session-activity-dot")).toHaveAttribute("aria-label", "Preparing session");
  await page.locator("[data-session-id='old'] .session-open").click();
  const beforeReopen = state.requests.length;
  await page.locator("[data-session-id='new'] .session-open").click();
  await expect(page.locator(".session-startup")).toContainText("Initializing tools");
  expect(state.requests.filter((request) => request.command === "resume_session" && request.args.sessionId === "new")).toHaveLength(0);
  expect(state.requests.slice(beforeReopen).some((request) => request.args.sessionId === "new"
    && ["session_history_window", "subagent_context", "pending_interactions"].includes(request.command))).toBe(false);
  state.attached = true;
  state.initialization = { phase: "ready", stage: "ready" };
  await emit();
  await expect(page.locator(".session-startup")).toHaveCount(0);
  await expect(page.locator("[data-session-id='new'] .session-activity-dot")).not.toHaveAttribute("aria-label", "Not attached");
});

test("creation reveals Unfiled from archived filters and a collapsed group", async ({ page }) => {
  const { create } = await setup(page);
  await page.getByRole("region", { name: "Unfiled sessions" }).getByRole("button", { name: /Unfiled/ }).click();
  await page.getByLabel("Search sessions").fill("will-not-match");
  await page.getByLabel("Session view").selectOption("archived");
  await create();
  await expect(page.getByLabel("Search sessions")).toHaveValue("");
  await expect(page.getByLabel("Session view")).toHaveValue("current");
  await expect(page.getByRole("region", { name: "Unfiled sessions" }).locator("[data-session-id='new']")).toBeVisible();
});

test("failed native creation remains actionable without publishing a phantom session", async ({ page }) => {
  const { state } = await setup(page);
  state.holdCreate = true;
  await page.getByRole("button", { name: /New session/ }).first().click();
  const dialog = page.getByRole("dialog", { name: "New session", exact: true });
  await dialog.getByRole("button", { name: "Create session", exact: true }).click();
  await expect.poll(() => state.heldCreates.length).toBe(1);
  await state.heldCreates[0].fulfill({ status: 500, body: "Native creation failed" });
  await expect(dialog.getByRole("alert")).toContainText("Native creation failed");
  await expect(dialog.getByRole("button", { name: "Create session", exact: true })).toBeEnabled();
  await expect(page.locator("[data-session-id]")).toHaveCount(1);
  state.holdCreate = false;
  await dialog.getByRole("button", { name: "Create session", exact: true }).click();
  await expect(page.locator("[data-session-id='new']")).toBeVisible();
});

test("a deleted startup row cannot be resurrected by an older list response", async ({ page }) => {
  const { state, create, session, refreshList } = await setup(page);
  await create();
  await page.locator("[data-session-id='old'] .session-open").click();
  state.holdLists = true;
  await refreshList();
  await expect.poll(() => state.heldLists.length).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("startup-event", { detail: {
    type: "session_deleted", sessionId: "new",
  } })));
  await state.heldLists[0].fulfill({ json: [session("old"), session("new", state.initialization)] });
  await expect(page.locator("[data-session-id='new']")).toHaveCount(0);
});
