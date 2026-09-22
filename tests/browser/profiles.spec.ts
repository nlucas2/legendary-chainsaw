import { test, expect, type Page, type Route, type WebSocketRoute } from "@playwright/test";
import type { ProfileLibrary, SessionProfileStatus } from "../../src/lib/profiles";

const initialLibrary = (): ProfileLibrary => ({
  directory: "Q:\\profiles", revision: "r1",
  groups: [
    { id: "base", name: "Everyday", mcpConfigFiles: ["Q:\\base.json"], skillDirectories: ["Q:\\skills"] },
    { id: "admin", name: "M365", mcpConfigFiles: ["Q:\\admin.json"], skillDirectories: [] },
  ],
  profiles: [{ id: "profile-one", name: "Focused work", groupIds: ["base", "admin"] }],
});
const session = (id: string) => ({
  sessionId: id, title: id === "new" ? "New session" : "Profile fixture", cwd: "Q:\\repo", model: "model",
  isActive: true, isRemote: false, pinned: false, archived: false, tags: [], startTime: "", modifiedTime: "",
});

async function setup(page: Page) {
  const state = {
    library: initialLibrary(), status: { sessionId: "a", profile: null, applying: false,
      configurationBlocked: false, requiresReconnect: false, error: null } as SessionProfileStatus,
    requests: [] as { command: string; args: Record<string, unknown> }[],
    failSave: false, failPreview: false, busySession: false, holdApply: false,
    pendingApply: undefined as Route | undefined, terminalConnections: 0,
    socket: undefined as WebSocketRoute | undefined,
  };
  await page.addInitScript(() => {
    class ProfileEvents extends EventTarget {
      onopen: (() => void) | null = null;
      constructor() { super(); setTimeout(() => this.onopen?.(), 0); }
      close() {}
    }
    Object.defineProperty(window, "EventSource", { value: ProfileEvents });
  });
  await page.routeWebSocket("**/api/terminal**", (socket) => {
    state.terminalConnections++; state.socket = socket;
    socket.send(JSON.stringify({ type: "ready", shell: "Profile fixture shell", cwd: "Q:\\repo", hasControl: true, viewers: 1 }));
  });
  await page.route("**/api/**", (route) => {
    const command = new URL(route.request().url()).pathname.split("/").pop()!;
    const args = route.request().postDataJSON() ?? {};
    state.requests.push({ command, args });
    let result: unknown;
    switch (command) {
      case "list_sessions": result = [session("a")]; break;
      case "resume_session": result = session(args.sessionId); break;
      case "create_session": result = session("new"); break;
      case "runtime_status": result = { connected: true, acceptingWork: true }; break;
      case "session_processing": result = state.busySession; break;
      case "session_state": result = { sessionId: args.sessionId, processing: state.busySession, mode: "interactive" }; break;
      case "queue_items": result = { items: [], steeringMessages: [] }; break;
      case "agent_tasks": result = { sessionId: args.sessionId, tasks: [] }; break;
      case "pending_permissions": case "pending_interactions": case "subagent_context": result = []; break;
      case "git_repository": result = { isRepository: false }; break;
      case "session_history_window": result = { events: [], hasMore: false, cursor: "", loadedPages: 1, humanMessages: 0 }; break;
      case "session_references": result = Object.fromEntries(["commands", "skills", "mcp", "tools", "mcpTools", "instructions", "contextAttribution", "tasks"].map((name) => [name, {}])); break;
      case "context_attribution": result = { contextAttribution: null }; break;
      case "available_models": result = { models: [] }; break;
      case "get_profile_library": result = state.library; break;
      case "save_profile_group":
        if (state.failSave) return route.fulfill({ status: 409, body: "Library changed; refresh and retry" });
        state.library = { ...state.library, revision: "r2",
          groups: [...state.library.groups.filter((group) => group.id !== args.id),
            { id: args.id ?? "new-group", name: args.name, mcpConfigFiles: args.mcpConfigFiles, skillDirectories: args.skillDirectories }] };
        result = state.library; break;
      case "save_profile":
        state.library = { ...state.library, revision: "r3",
          profiles: [...state.library.profiles.filter((profile) => profile.id !== args.id),
            { id: args.id ?? "new-profile", name: args.name, groupIds: args.groupIds }] };
        result = state.library; break;
      case "set_profile_library_directory":
        state.library = { directory: args.directory, revision: "other", profiles: [], groups: [] };
        result = state.library; break;
      case "create_profile_source": result = { path: `Q:\\profiles\\sources\\${args.name}${args.kind === "mcp" ? ".json" : ""}`, kind: args.kind }; break;
      case "get_session_profile": result = { ...state.status, sessionId: args.sessionId }; break;
      case "preview_session_profile":
        if (state.failPreview) return route.fulfill({ status: 400, body: "Missing linked MCP file" });
        result = { profileId: args.profileId, profileName: args.profileId ? "Focused work" : "Default", revision: "resolved-r1",
          groupNames: args.profileId ? ["Everyday", "M365"] : [], mcpServers: [{ name: "fixture", sourceFile: "Q:\\base.json" }],
          skillDirectories: ["Q:\\skills"], warnings: ["Fixture override shown for review"], addedServers: ["fixture"],
          removedServers: [], requiresReconnect: !!args.sessionId };
        break;
      case "set_session_profile":
        if (state.busySession) return route.fulfill({ status: 409, body: "Session is processing. Wait for the turn and subagents to finish." });
        if (state.holdApply) {
          state.status.applying = true; state.status.configurationBlocked = true;
          state.pendingApply = route; return;
        }
        state.status = { ...state.status, profile: args.profileId ? { id: args.profileId, name: "Focused work", revision: "resolved-r1" } : null,
          applying: false, configurationBlocked: false, requiresReconnect: false, error: null };
        result = state.status; break;
      case "send_message": result = "native-message"; break;
      case "set_session_cwd": return route.fulfill({ status: 409, body: "Profile application blocks session directory changes" });
      default: return route.fulfill({ status: 404, body: `Unexpected ${command}` });
    }
    return route.fulfill({ json: result });
  });
  await page.goto("/?session=a");
  await expect(page.locator(".parent-session-view .composer textarea")).toBeEnabled();
  const manager = async () => {
    if (await page.getByRole("button", { name: "Open sessions", exact: true }).isVisible()) await page.getByRole("button", { name: "Open sessions", exact: true }).click();
    await page.locator(".daemon-state").click();
    await page.getByRole("button", { name: /Profiles and groups/ }).click();
    const panel = page.getByRole("dialog", { name: "Profiles and groups" });
    await expect(panel.getByRole("button", { name: "New group", exact: true })).toBeEnabled();
    return panel;
  };
  const context = async () => {
    await page.getByTitle("Browse commands, tools, skills, MCP, and instructions").click();
    const drawer = page.getByRole("dialog", { name: "Session context and references" });
    await drawer.getByRole("tab", { name: "Profile", exact: true }).click();
    await expect(drawer.getByLabel("Choose profile", { exact: true })).toBeEnabled();
    return drawer;
  };
  return { state, manager, context };
}

test("groups link arbitrary sources and profiles stack groups in an editable order", async ({ page }) => {
  const { state, manager } = await setup(page);
  const panel = await manager();
  await panel.getByRole("button", { name: "New group", exact: true }).click();
  await panel.getByLabel("Group name", { exact: true }).fill("My research");
  await panel.getByLabel("MCP configuration files (one per line)", { exact: true }).fill("Q:\\custom.json\nQ:\\custom.json");
  await panel.getByLabel("Skill directories (one per line)", { exact: true }).fill("skills\\research");
  await panel.getByRole("button", { name: "Save group", exact: true }).click();
  await expect(panel.getByRole("article", { name: "Group My research" })).toBeVisible();
  expect(state.requests.find((request) => request.command === "save_profile_group")!.args)
    .toMatchObject({ name: "My research", mcpConfigFiles: ["Q:\\custom.json"], skillDirectories: ["skills\\research"], expectedRevision: "r1" });
  await panel.getByRole("button", { name: "New profile", exact: true }).click();
  await panel.getByLabel("Profile name", { exact: true }).fill("Independent stack");
  for (const id of ["base", "admin", "new-group"]) {
    await panel.getByLabel("Add a group", { exact: true }).selectOption(id);
    await panel.getByRole("button", { name: "Add group", exact: true }).click();
  }
  await panel.getByRole("button", { name: "Move My research earlier", exact: true }).click();
  await panel.getByRole("button", { name: "Save profile", exact: true }).click();
  expect(state.library.profiles.find((profile) => profile.name === "Independent stack")!.groupIds).toEqual(["base", "new-group", "admin"]);
  expect(state.requests.some((request) => ["set_session_profile", "create_session", "send_message"].includes(request.command))).toBe(false);
});

test("source creation and storage changes are explicit and failed saves keep edits", async ({ page }) => {
  const { state, manager } = await setup(page);
  const panel = await manager();
  await panel.getByRole("button", { name: "New group", exact: true }).click();
  await panel.getByLabel("Group name", { exact: true }).fill("Keep my group");
  await panel.getByText("Create a new managed source", { exact: true }).click();
  await panel.getByLabel("Source type", { exact: true }).selectOption("skills");
  await panel.getByLabel("Source name", { exact: true }).fill("my-skills");
  await panel.getByRole("button", { name: "Create source", exact: true }).click();
  await expect(panel.getByLabel("Skill directories (one per line)")).toHaveValue("Q:\\profiles\\sources\\my-skills");
  state.failSave = true;
  await panel.getByRole("button", { name: "Save group", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Library changed");
  await expect(panel.getByLabel("Group name", { exact: true })).toHaveValue("Keep my group");
  await panel.getByRole("button", { name: "Cancel edit", exact: true }).click();
  await panel.getByText("Profile library location", { exact: true }).click();
  await panel.getByLabel("Library directory on daemon", { exact: true }).fill("Q:\\my-profile-library");
  page.once("dialog", (dialog) => dialog.accept());
  await panel.getByRole("button", { name: "Use this library directory" }).click();
  await expect(panel).toContainText("No profiles yet");
});

test("new sessions use the selected resolved profile and missing sources block only that selection", async ({ page }) => {
  const { state } = await setup(page);
  await page.getByRole("button", { name: /New session/ }).first().click();
  const dialog = page.getByRole("dialog", { name: "New session", exact: true });
  await dialog.getByLabel("Session profile", { exact: true }).selectOption("profile-one");
  await expect(dialog.getByRole("region", { name: "Resolved profile preview" })).toContainText("Everyday + M365");
  await dialog.getByRole("button", { name: "Create session", exact: true }).click();
  expect(state.requests.find((request) => request.command === "create_session")!.args)
    .toMatchObject({ profileId: "profile-one", profileRevision: "resolved-r1", deferInitialization: true });
  await expect(page.getByRole("heading", { name: "New session", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /New session/ }).first().click();
  state.failPreview = true;
  await dialog.getByLabel("Session profile", { exact: true }).selectOption("profile-one");
  await expect(dialog.getByRole("alert")).toContainText("Missing linked MCP file");
  await expect(dialog.getByRole("button", { name: "Create session", exact: true })).toBeDisabled();
  await dialog.getByLabel("Session profile", { exact: true }).selectOption("");
  await expect(dialog.getByRole("button", { name: "Create session", exact: true })).toBeEnabled();
});

test("busy profile changes are rejected without queued switches, automatic stopping, or background retry", async ({ page }) => {
  const { state, context } = await setup(page);
  const drawer = await context();
  await drawer.getByLabel("Choose profile", { exact: true }).selectOption("profile-one");
  await drawer.getByRole("button", { name: "Preview profile change" }).click();
  state.busySession = true;
  await drawer.getByRole("button", { name: "Apply profile now" }).click();
  await expect(drawer.getByRole("alert")).toContainText("Wait for the turn and subagents");
  state.busySession = false;
  await page.waitForTimeout(100);
  expect(state.requests.filter((request) => request.command === "set_session_profile")).toHaveLength(1);
  await expect(drawer.getByRole("button", { name: /Apply when idle|Stop and apply|Cancel profile change/ })).toHaveCount(0);
  await drawer.getByRole("button", { name: "Apply profile now" }).click();
  await expect(drawer).toContainText("Current profile: Focused work");
  expect(state.requests.filter((request) => request.command === "set_session_profile")).toHaveLength(2);
  expect(state.requests.some((request) => ["abort_session", "stop_and_apply_session_profile", "cancel_session_profile_change"].includes(request.command))).toBe(false);
  expect(state.requests.find((request) => request.command === "set_session_profile")!.args).not.toHaveProperty("mode");
});

test("applying a profile disables Send but preserves editable draft, session, and terminal", async ({ page }) => {
  const { state, context } = await setup(page);
  await page.getByTitle("Open terminal", { exact: true }).click();
  await expect(page.locator(".terminal-title strong")).toHaveText("Profile fixture shell");
  const composer = page.locator(".parent-session-view .composer textarea");
  await composer.fill("Keep this unsent draft");
  const drawer = await context();
  await drawer.getByLabel("Choose profile", { exact: true }).selectOption("profile-one");
  await drawer.getByRole("button", { name: "Preview profile change" }).click();
  state.holdApply = true;
  await drawer.getByRole("button", { name: "Apply profile now" }).click();
  await expect.poll(() => !!state.pendingApply).toBe(true);
  await drawer.getByRole("button", { name: "Close context" }).click();
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  await expect(composer).toBeEnabled();
  await composer.fill("Still editable while applying");
  await composer.press("Enter");
  expect(state.requests.some((request) => request.command === "send_message")).toBe(false);
  state.status = { ...state.status, profile: { id: "profile-one", name: "Focused work", revision: "resolved-r1" },
    applying: false, configurationBlocked: false };
  await state.pendingApply!.fulfill({ json: state.status });
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
  await expect(composer).toHaveValue("Still editable while applying");
  expect(state.terminalConnections).toBe(1);
  expect(state.requests.some((request) => ["create_session", "prepare_restart", "send_message"].includes(request.command))).toBe(false);
});

test("an unverified configuration blocks sending but permits explicit repair", async ({ page }) => {
  const { state, context } = await setup(page);
  state.status.configurationBlocked = true;
  state.status.error = "Configuration could not be verified";
  await page.reload();
  await expect(page.getByRole("region", { name: "Profile change status" })).toContainText("could not be verified");
  const composer = page.locator(".parent-session-view .composer textarea");
  await composer.fill("Preserve this recovery draft");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  const drawer = await context();
  await drawer.getByLabel("Choose profile", { exact: true }).selectOption("profile-one");
  await drawer.getByRole("button", { name: "Preview profile change" }).click();
  await drawer.getByRole("button", { name: "Apply profile now" }).click();
  await drawer.getByRole("button", { name: "Close context" }).click();
  await expect(composer).toHaveValue("Preserve this recovery draft");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
});

test("rejected terminal CWD updates do not change the session's profile-preview directory", async ({ page }) => {
  const { state } = await setup(page);
  await page.getByTitle("Open terminal", { exact: true }).click();
  await expect(page.locator(".terminal-title strong")).toHaveText("Profile fixture shell");
  state.socket!.send(JSON.stringify({ type: "cwd", cwd: "Q:\\different-repo" }));
  await expect(page.locator(".parent-session-view .error-banner")).toContainText("blocks session directory changes");
  await expect(page.locator(".workspace-header").getByTitle("Q:\\repo", { exact: true })).toBeVisible();
});

test.describe("mobile profiles", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test("the editor fits the phone without invoking background chat shortcuts", async ({ page }) => {
    const { state, manager } = await setup(page);
    const panel = await manager();
    await panel.getByRole("button", { name: "New profile", exact: true }).tap();
    await panel.getByLabel("Profile name", { exact: true }).fill("Mobile profile");
    await panel.getByLabel("Profile name", { exact: true }).press("Control+Shift+t");
    await expect(page.locator(".terminal-pane")).toHaveCount(0);
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await panel.getByRole("button", { name: "Cancel edit", exact: true }).tap();
    await panel.getByRole("button", { name: "Close profiles" }).tap();
    expect(state.requests.some((request) => ["create_session", "send_message", "set_session_profile"].includes(request.command))).toBe(false);
  });
});
