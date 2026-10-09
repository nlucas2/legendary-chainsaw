import { test, expect, type Page, type Route } from "@playwright/test";

const models = [
  { id: "alpha", displayName: "Alpha", description: "First test model", supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "low", supportedContextTiers: ["long_context"] },
  { id: "beta", displayName: "Beta", description: "Second test model", supportedReasoningEfforts: ["high"], supportedContextTiers: ["long_context"] },
  { id: "plain", displayName: "Plain", description: "No reasoning controls" },
  { id: "blocked", displayName: "Blocked", description: "Not available", available: false },
  { id: "auto", displayName: "Auto", description: "Native automatic selection" },
];
const preferenceKey = "copilot-sessions.new-session-model";
async function setup(page: Page) {
  const session = (sessionId: string) => ({ sessionId, title: sessionId === "a" ? "Existing session" : "New session",
    cwd: "Q:\\example", model: state.current.modelId, isActive: true, isRemote: false, archived: false,
    pinned: false, tags: [], startTime: "", modifiedTime: "" });
  const state = {
    models: structuredClone(models),
    current: { modelId: "alpha", reasoningEffort: "high", reasoningSummary: "concise", contextTier: "long_context" },
    requests: [] as { command: string; args: Record<string, unknown> }[],
    failCatalog: false, failCurrent: false, holdSwitch: false, pendingSwitch: undefined as Route | undefined,
    switchResult: undefined as Record<string, unknown> | undefined,
  };
  await page.addInitScript(() => {
    class Events extends EventTarget {
      onopen: (() => void) | null = null;
      constructor() { super(); setTimeout(() => this.onopen?.(), 0); }
      close() {}
    }
    Object.defineProperty(window, "EventSource", { value: Events });
  });
  await page.route("**/api/**", (route) => {
    const command = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const args = route.request().postDataJSON() ?? {};
    state.requests.push({ command, args });
    let result: unknown;
    switch (command) {
      case "list_sessions": result = [session("a")]; break;
      case "resume_session": result = session(args.sessionId); break;
      case "create_session": result = { ...session("new"), model: args.model || "alpha" }; break;
      case "runtime_status": result = { connected: true, acceptingWork: true }; break;
      case "session_state": result = { sessionId: args.sessionId, mode: "interactive", processing: false }; break;
      case "session_processing": result = false; break;
      case "session_history_window": result = { events: [], hasMore: false, cursor: "", loadedPages: 1, humanMessages: 0 }; break;
      case "pending_permissions": case "pending_interactions": case "subagent_context": result = []; break;
      case "queue_items": result = { items: [], steeringMessages: [] }; break;
      case "agent_tasks": result = { sessionId: args.sessionId, tasks: [] }; break;
      case "git_repository": result = { isRepository: false }; break;
      case "get_profile_library": result = { directory: "Q:\\profiles", revision: "r", groups: [], profiles: [] }; break;
      case "get_session_profile": result = { sessionId: args.sessionId, profile: null, applying: false, configurationBlocked: false, requiresReconnect: false, error: null }; break;
      case "available_models":
        if (state.failCatalog) return route.fulfill({ status: 503, body: "Catalog unavailable" });
        result = { models: state.models }; break;
      case "model_info":
        if (state.failCurrent) return route.fulfill({ status: 503, body: "Session catalog unavailable" });
        result = { current: state.current, available: { list: state.models } }; break;
      case "switch_model":
        if (state.holdSwitch) { state.pendingSwitch = route; return; }
        if (state.switchResult) result = state.switchResult;
        else {
          state.current = { modelId: args.modelId, reasoningEffort: args.reasoningEffort ?? "",
            reasoningSummary: args.reasoningSummary, contextTier: args.contextTier ?? "" };
          result = { status: "applied", deferred: false, modelId: args.modelId, message: `Model changed to: ${args.modelId}` };
        }
        break;
      default: return route.fulfill({ status: 404, body: `Unexpected ${command}` });
    }
    return route.fulfill({ json: result });
  });
  await page.goto("/?session=a");
  await expect(page.locator(".parent-session-view .composer textarea")).toBeEnabled();
  const settings = async () => {
    if (await page.getByRole("button", { name: "Open sessions", exact: true }).isVisible()) {
      await page.getByRole("button", { name: "Open sessions", exact: true }).click();
    }
    await page.locator(".daemon-state").click();
    await page.getByText("Default model for new sessions", { exact: true }).click();
    const editor = page.locator(".settings-panel");
    await expect(editor.getByRole("button", { name: "Refresh models", exact: true })).toBeEnabled();
    return editor;
  };
  const create = async () => {
    await page.getByRole("button", { name: /New session/ }).first().click();
    const dialog = page.getByRole("dialog", { name: "New session", exact: true });
    await expect(dialog.getByRole("button", { name: "Create session", exact: true })).toBeEnabled();
    return dialog;
  };
  const live = async () => {
    await page.getByTitle("Change this session's model", { exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Choose model", exact: true });
    await expect(dialog.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();
    return dialog;
  };
  return { state, settings, create, live };
}

test("Settings default applies to the next collapsed New session without changing the current session", async ({ page }) => {
  const { state, settings, create, live } = await setup(page);
  const editor = await settings();
  await editor.getByRole("button", { name: "Select Beta", exact: true }).click();
  await editor.getByLabel("Reasoning effort", { exact: true }).selectOption("high");
  await editor.getByLabel("Visible reasoning", { exact: true }).selectOption("concise");
  await editor.getByLabel("Context window", { exact: true }).selectOption("long_context");
  await editor.getByRole("button", { name: "Save new-session default" }).click();
  await expect(editor).toContainText("Default saved. Existing sessions were not changed.");
  await expect(editor.locator(".model-selection-list .model-option").first()).toHaveAttribute("aria-label", "Select Beta");
  await expect(editor.locator(".model-default-label")).toHaveCount(1);
  await page.getByRole("button", { name: "Close settings" }).click();
  expect(state.requests.some((request) => ["switch_model", "create_session"].includes(request.command))).toBe(false);
  let picker = await live();
  await expect(picker.locator(".model-selection-list .model-option").first()).toHaveAttribute("aria-label", "Select Beta");
  await expect(picker.getByRole("button", { name: "Select Alpha", exact: true })).toHaveAttribute("aria-pressed", "true");
  await picker.getByRole("button", { name: "Cancel", exact: true }).click();
  const dialog = await create();
  const disclosure = dialog.locator(".model-selection-disclosure");
  await expect(disclosure).not.toHaveAttribute("open");
  await expect(disclosure.locator("summary")).toContainText("Beta");
  await expect(disclosure.locator("summary")).toContainText("Reasoning: High");
  await disclosure.locator("summary").click();
  await expect(dialog.locator(".model-selection-list .model-option").first()).toHaveAttribute("aria-label", "Select Beta");
  await expect(dialog.getByRole("button", { name: "Select Beta", exact: true })).toHaveCount(1);
  await disclosure.locator("summary").click();
  await dialog.getByRole("button", { name: "Create session", exact: true }).click();
  expect(state.requests.find((request) => request.command === "create_session")!.args).toMatchObject({
    model: "beta", reasoningEffort: "high", reasoningSummary: "concise", contextTier: "long_context",
  });
  await page.reload();
  await expect(page.locator(".parent-session-view .composer textarea")).toBeEnabled();
  const reopened = await create();
  await expect(reopened.locator(".model-selection-disclosure > summary")).toContainText("Beta");
  await reopened.getByRole("button", { name: "Cancel", exact: true }).click();
  picker = await live();
  await picker.getByRole("button", { name: "Select Plain", exact: true }).click();
  await picker.getByRole("button", { name: "Apply", exact: true }).click();
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).selection.modelId, preferenceKey)).toBe("beta");
});

test("creation and live switching use the same menu, preserve compatible options and reject unavailable models", async ({ page }) => {
  const { state, create, live } = await setup(page);
  const dialog = await create();
  await dialog.locator(".model-selection-disclosure > summary").click();
  await dialog.getByRole("button", { name: "Select Alpha", exact: true }).click();
  await dialog.getByLabel("Reasoning effort", { exact: true }).selectOption("high");
  await dialog.getByLabel("Visible reasoning", { exact: true }).selectOption("concise");
  await dialog.getByLabel("Context window", { exact: true }).selectOption("long_context");
  await dialog.getByRole("button", { name: "Select Beta", exact: true }).click();
  await expect(dialog.getByLabel("Reasoning effort", { exact: true })).toHaveValue("high");
  await expect(dialog.getByLabel("Visible reasoning", { exact: true })).toHaveValue("concise");
  await expect(dialog.getByLabel("Context window", { exact: true })).toHaveValue("long_context");
  await expect(dialog.getByRole("button", { name: "Select Blocked", exact: true })).toBeDisabled();
  await dialog.getByLabel("Search models").fill("Beta");
  await expect(dialog.locator(".model-selection-list .model-option")).toHaveCount(1);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const picker = await live();
  await picker.getByRole("button", { name: "Select Beta", exact: true }).click();
  await expect(picker.getByLabel("Reasoning effort", { exact: true })).toHaveValue("high");
  await expect(picker.getByLabel("Visible reasoning", { exact: true })).toHaveValue("concise");
  await expect(picker.getByLabel("Context window", { exact: true })).toHaveValue("long_context");
  await expect(picker.getByRole("button", { name: "Select Blocked", exact: true })).toBeDisabled();
  await picker.getByRole("button", { name: "Select Plain", exact: true }).click();
  await expect(picker.getByLabel("Reasoning effort", { exact: true })).toHaveValue("");
  await expect(picker.getByLabel("Visible reasoning", { exact: true })).toHaveValue("none");
  await picker.getByRole("button", { name: "Select Auto", exact: true }).click();
  await picker.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(picker).toHaveCount(0);
  expect(state.requests.find((request) => request.command === "switch_model")!.args.modelId).toBe("auto");
  expect(await page.evaluate((key) => localStorage.getItem(key), preferenceKey)).toBeNull();
});

test("missing saved defaults open an explicit error and one-off overrides never overwrite Settings", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, JSON.stringify({ version: 1, selection: {
    modelId: "removed-model", reasoningEffort: "", reasoningSummary: "detailed", contextTier: "",
  } })), preferenceKey);
  const { state } = await setup(page);
  await page.getByRole("button", { name: /New session/ }).first().click();
  const dialog = page.getByRole("dialog", { name: "New session", exact: true });
  await expect(dialog.locator(".model-selection-disclosure")).toHaveAttribute("open");
  await expect(dialog.getByRole("alert")).toContainText("not in the current catalog");
  await expect(dialog.getByRole("button", { name: "Create session", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Select Beta", exact: true }).click();
  await dialog.getByRole("button", { name: "Create session", exact: true }).click();
  expect(state.requests.find((request) => request.command === "create_session")!.args.model).toBe("beta");
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).selection.modelId, preferenceKey)).toBe("removed-model");
});

test("catalogs refresh consistently, failed reads can retry, and the draft survives refresh", async ({ page }) => {
  const { state, create } = await setup(page);
  const dialog = await create();
  await dialog.locator(".model-selection-disclosure > summary").click();
  await dialog.getByRole("button", { name: "Select Alpha", exact: true }).click();
  await dialog.getByLabel("Reasoning effort", { exact: true }).selectOption("high");
  const reads = state.requests.filter((request) => request.command === "available_models").length;
  await dialog.getByRole("button", { name: "Refresh models", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Refresh models", exact: true })).toBeEnabled();
  expect(state.requests.filter((request) => request.command === "available_models")).toHaveLength(reads + 1);
  await expect(dialog.getByLabel("Reasoning effort", { exact: true })).toHaveValue("high");
  state.failCatalog = true;
  await dialog.getByRole("button", { name: "Refresh models", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Catalog unavailable");
  await expect(dialog.getByRole("button", { name: "Create session", exact: true })).toBeDisabled();
  state.failCatalog = false;
  await dialog.getByRole("button", { name: "Retry models", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Create session", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  state.failCurrent = true;
  await page.getByTitle("Change this session's model", { exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Choose model", exact: true });
  await expect(picker.getByRole("alert")).toContainText("Session catalog unavailable");
  state.failCurrent = false;
  await picker.getByRole("button", { name: "Retry models", exact: true }).click();
  await expect(picker.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();
});

test("applying a model locks all controls and dismissal, and deferred changes are not shown as applied", async ({ page }) => {
  const { state, live } = await setup(page);
  const picker = await live();
  await picker.getByRole("button", { name: "Select Beta", exact: true }).click();
  state.holdSwitch = true;
  await picker.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(() => !!state.pendingSwitch).toBe(true);
  for (const label of ["Reasoning effort", "Visible reasoning", "Context window"]) await expect(picker.getByLabel(label, { exact: true })).toBeDisabled();
  await expect(picker.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  await picker.press("Escape");
  await expect(picker).toBeVisible();
  await state.pendingSwitch!.fulfill({ json: { deferred: true, message: "Model change queued", modelId: "alpha" } });
  await expect(picker.getByRole("status")).toHaveText("Model change queued");
  await expect(picker.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();
  await expect(page.getByTitle("Change this session's model", { exact: true })).toHaveText("alpha");
  await picker.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("saving defaults reports storage failures and reset/sync do not switch a running session", async ({ page }) => {
  const { state, settings } = await setup(page);
  const editor = await settings();
  await page.evaluate((key) => window.dispatchEvent(new StorageEvent("storage", {
    key, newValue: JSON.stringify({ version: 1, selection: { modelId: "beta", reasoningEffort: "", reasoningSummary: "detailed", contextTier: "" } }),
    storageArea: localStorage,
  })), preferenceKey);
  await expect(editor.getByRole("button", { name: "Select Beta", exact: true })).toHaveAttribute("aria-pressed", "true");
  await editor.getByRole("button", { name: "Clear default", exact: true }).click();
  await expect(editor).toContainText("Default cleared.");
  await expect(editor.locator(".model-selection-list .model-option[aria-pressed='true']")).toHaveCount(0);
  await expect(editor.locator(".model-default-label")).toHaveCount(0);
  await expect(editor.locator(".model-selection-list .model-option").first()).toHaveAttribute("aria-label", "Select Alpha");
  expect(await page.evaluate((key) => localStorage.getItem(key), preferenceKey)).toBeNull();
  await page.evaluate((key) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new Error("Synthetic storage denial");
      original.call(this, name, value);
    };
  }, preferenceKey);
  await editor.getByRole("button", { name: "Select Beta", exact: true }).click();
  await editor.getByRole("button", { name: "Save new-session default" }).click();
  await expect(editor.getByRole("alert")).toContainText("The saved default was not changed");
  expect(state.requests.some((request) => ["switch_model", "create_session"].includes(request.command))).toBe(false);
});

test("changing the saved default does not overwrite an open creation draft and the next opening refreshes its catalog", async ({ page }) => {
  const { state, create } = await setup(page);
  let dialog = await create();
  await dialog.locator(".model-selection-disclosure > summary").click();
  await dialog.getByRole("button", { name: "Select Alpha", exact: true }).click();
  const changed = { version: 1, selection: { modelId: "beta", reasoningEffort: "high", reasoningSummary: "concise", contextTier: "" } };
  await page.evaluate(({ key, changed }) => {
    localStorage.setItem(key, JSON.stringify(changed));
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: JSON.stringify(changed), storageArea: localStorage }));
  }, { key: preferenceKey, changed });
  await expect(dialog.getByRole("button", { name: "Select Alpha", exact: true })).toHaveAttribute("aria-pressed", "true");
  const before = state.requests.filter((request) => request.command === "available_models").length;
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  dialog = await create();
  await expect(dialog.locator(".model-selection-disclosure")).not.toHaveAttribute("open");
  await expect(dialog.locator(".model-selection-disclosure > summary")).toContainText("Beta");
  expect(state.requests.filter((request) => request.command === "available_models")).toHaveLength(before + 1);
  expect(state.requests.some((request) => ["create_session", "switch_model"].includes(request.command))).toBe(false);
});

test("a saved model that becomes unavailable is never silently substituted", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, JSON.stringify({ version: 1, selection: {
    modelId: "blocked", reasoningEffort: "", reasoningSummary: "detailed", contextTier: "",
  } })), preferenceKey);
  const { state } = await setup(page);
  await page.getByRole("button", { name: /New session/ }).first().click();
  const dialog = page.getByRole("dialog", { name: "New session", exact: true });
  await expect(dialog.getByRole("alert")).toContainText("unavailable");
  await expect(dialog.getByRole("button", { name: "Select Blocked", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByRole("button", { name: "Create session", exact: true })).toBeDisabled();
  expect(state.requests.some((request) => request.command === "create_session")).toBe(false);
});

test("shared model menu fits phone layouts in creation, Settings, and live switching", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { settings, create, live } = await setup(page);
  const editor = await settings();
  expect(await editor.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await editor.getByRole("button", { name: "Select Alpha", exact: true }).click();
  expect((await editor.getByRole("button", { name: "Select Alpha", exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.getByRole("button", { name: "Close settings" }).click();
  const dialog = await create();
  await dialog.locator(".model-selection-disclosure > summary").click();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".sidebar")).not.toHaveClass(/ open/);
  const picker = await live();
  await page.setViewportSize({ width: 320, height: 844 });
  expect(await picker.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await picker.getByRole("button", { name: "Apply", exact: true }).scrollIntoViewIfNeeded();
  await expect(picker.getByRole("button", { name: "Apply", exact: true })).toBeInViewport();
});

test("unset preference adds no default row or summary and leaves catalog order intact in every menu", async ({ page }) => {
  const { state, settings, create, live } = await setup(page);
  const editor = await settings();
  const catalogLabels = models.map((model) => `Select ${model.displayName}`);
  for (const container of [editor]) {
    expect(await container.locator(".model-selection-list .model-option").evaluateAll((rows) => rows.map((row) => row.getAttribute("aria-label")))).toEqual(catalogLabels);
    await expect(container.locator(".model-default-label")).toHaveCount(0);
    await expect(container).not.toContainText("Runtime default");
    await expect(container.getByRole("button", { name: "Save new-session default" })).toBeDisabled();
  }
  await page.getByRole("button", { name: "Close settings" }).click();
  const dialog = await create();
  const disclosure = dialog.locator(".model-selection-disclosure");
  await expect(disclosure.locator("summary")).toHaveText("Model selection");
  await disclosure.locator("summary").click();
  expect(await dialog.locator(".model-selection-list .model-option").evaluateAll((rows) => rows.map((row) => row.getAttribute("aria-label")))).toEqual(catalogLabels);
  await expect(dialog.locator(".model-selection-list .model-option[aria-pressed='true']")).toHaveCount(0);
  await expect(dialog.locator(".model-default-label")).toHaveCount(0);
  await expect(dialog).not.toContainText("Runtime default");
  await dialog.getByRole("button", { name: "Create session", exact: true }).click();
  expect(state.requests.find((request) => request.command === "create_session")!.args.model).toBeNull();
  const picker = await live();
  expect(await picker.locator(".model-selection-list .model-option").evaluateAll((rows) => rows.map((row) => row.getAttribute("aria-label")))).toEqual(catalogLabels);
  await expect(picker.locator(".model-default-label")).toHaveCount(0);
  await expect(picker).not.toContainText("Runtime default");
});

test("model selection is below the profile, without an outer box, while its bounded list keeps its own scrollbar", async ({ page }) => {
  const { state, create } = await setup(page);
  state.models.push(...Array.from({ length: 25 }, (_, index) => ({
    id: `extra-${index}`, displayName: `Extra ${index}`, description: "Catalog layout fixture",
  })));
  const dialog = await create();
  const disclosure = dialog.locator(".model-selection-disclosure");
  await disclosure.locator("summary").click();
  const list = dialog.locator(".model-selection-list");
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(disclosure).toHaveCSS("border-top-width", "0px");
    await expect(disclosure).toHaveCSS("padding-left", "0px");
    await expect(list).toHaveCSS("overflow-y", "auto");
    const layout = await dialog.evaluate((element) => {
      const profile = element.querySelector(".new-profile-picker")!.getBoundingClientRect();
      const models = element.querySelector(".model-selection-disclosure")!.getBoundingClientRect();
      const list = element.querySelector(".model-selection-list")!;
      return { belowProfile: models.top >= profile.bottom, fitsViewport: element.getBoundingClientRect().height <= window.innerHeight,
        listHeight: list.clientHeight, listScrolls: list.scrollHeight > list.clientHeight,
        fitsHorizontally: element.scrollWidth <= element.clientWidth + 1 };
    });
    expect(layout.belowProfile).toBe(true);
    expect(layout.fitsViewport && layout.fitsHorizontally).toBe(true);
    expect(layout.listHeight).toBeLessThanOrEqual(230);
    expect(layout.listScrolls).toBe(true);
    await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await dialog.getByRole("button", { name: "Select Extra 24", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Select Extra 24", exact: true })).toHaveAttribute("aria-pressed", "true");
    await dialog.getByRole("button", { name: "Create session", exact: true }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole("button", { name: "Create session", exact: true })).toBeInViewport();
  }
});
