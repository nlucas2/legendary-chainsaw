import { test, expect, type Page, type Route, type WebSocketRoute } from "@playwright/test";

const skill = (name: string, enabled = true) => ({
  name, description: `Instructions for ${name}`, enabled, source: "project",
  path: `Q:\\repo-a\\.github\\skills\\${name}\\SKILL.md`, userInvocable: true,
});

async function setup(page: Page) {
  const state = {
    cwd: "Q:\\repo-a", skills: [skill("existing"), skill("disabled", false)],
    reads: 0, requests: [] as { command: string; args: Record<string, unknown> }[],
    holdReload: false, pending: undefined as Route | undefined, socket: undefined as WebSocketRoute | undefined,
    error: "", warnings: [] as string[], errors: [] as string[],
  };
  const session = () => ({
    sessionId: "a", title: "Repo skills fixture", cwd: state.cwd, model: "model",
    isActive: true, isRemote: false, pinned: false, archived: false, tags: [], startTime: "", modifiedTime: "",
  });
  const snapshot = () => ({ sessionId: "a", cwd: state.cwd, skills: state.skills, warnings: state.warnings, errors: state.errors });
  await page.addInitScript(() => {
    class SkillEvents extends EventTarget {
      onopen: (() => void) | null = null;
      constructor() { super(); setTimeout(() => this.onopen?.(), 0); }
      close() {}
    }
    Object.defineProperty(window, "EventSource", { value: SkillEvents });
  });
  await page.routeWebSocket("**/api/terminal**", (socket) => {
    state.socket = socket;
    socket.send(JSON.stringify({ type: "ready", cwd: state.cwd, shell: "Fixture shell", hasControl: true, viewers: 1 }));
  });
  await page.route("**/api/**", (route) => {
    const command = new URL(route.request().url()).pathname.split("/").pop()!;
    const args = route.request().postDataJSON() ?? {};
    state.requests.push({ command, args });
    let result: unknown;
    switch (command) {
      case "list_sessions": result = [session()]; break;
      case "resume_session": result = session(); break;
      case "runtime_status": result = { connected: true, acceptingWork: true }; break;
      case "session_processing": result = false; break;
      case "session_state": result = { sessionId: "a", processing: false, mode: "interactive" }; break;
      case "queue_items": result = { items: [], steeringMessages: [] }; break;
      case "agent_tasks": result = { sessionId: "a", tasks: [] }; break;
      case "pending_permissions": case "pending_interactions": case "subagent_context": result = []; break;
      case "git_repository": result = { isRepository: false }; break;
      case "session_history_window": result = { events: [], hasMore: false, cursor: "", loadedPages: 1, humanMessages: 0 }; break;
      case "session_references": result = Object.fromEntries(["commands", "skills", "mcp", "tools", "mcpTools", "instructions", "contextAttribution", "tasks"].map((name) => [name, {}])); break;
      case "context_attribution": result = { contextAttribution: null }; break;
      case "session_skills":
        state.reads++;
        if (state.error) return route.fulfill({ status: 500, body: state.error });
        result = snapshot(); break;
      case "preview_session_skills": result = {
        sessionId: "a", cwd: state.cwd, discovered: [...state.skills, skill("newly-discovered")],
        added: ["newly-discovered"], changed: [], notDiscovered: [], errors: [],
      }; break;
      case "reload_session_skills":
        if (state.holdReload) { state.pending = route; return; }
        if (state.error) return route.fulfill({ status: 409, body: state.error });
        state.skills = [...state.skills.filter((entry) => entry.name !== "newly-discovered"), skill("newly-discovered")];
        result = snapshot(); break;
      case "set_session_cwd": state.cwd = args.cwd; result = state.cwd; break;
      default: return route.fulfill({ status: 404, body: `Unexpected ${command}` });
    }
    return route.fulfill({ json: result });
  });
  await page.goto("/?session=a");
  await expect(page.locator(".parent-session-view .composer textarea")).toBeEnabled();
  const open = async () => {
    await page.getByTitle("Browse commands, tools, skills, MCP, and instructions").click();
    const drawer = page.getByRole("dialog", { name: "Session context and references" });
    await drawer.getByRole("tab", { name: "Skills", exact: true }).click();
    await expect(drawer.getByRole("button", { name: "Refresh skill list" })).toBeEnabled();
    return drawer;
  };
  return { state, open };
}

test("Skills lists runtime-effective sources and only explicit preview/apply reloads them", async ({ page }) => {
  const { state, open } = await setup(page);
  const composer = page.locator(".parent-session-view .composer textarea");
  await composer.fill("Keep my draft");
  const drawer = await open();
  await expect(drawer).toContainText("2 session skills");
  expect(state.requests.some((request) => request.command === "discover_skills" || request.command === "reload_session_skills")).toBe(false);
  const disabled = drawer.locator("details").filter({ hasText: "disabled" });
  await disabled.locator("summary").click();
  await expect(disabled.getByRole("button", { name: "Reference skill in chat" })).toBeDisabled();
  await drawer.getByRole("button", { name: "Load skills from current directory" }).click();
  await expect(drawer.getByRole("region", { name: "Skill discovery preview" })).toContainText("newly-discovered");
  expect(state.requests.some((request) => request.command === "reload_session_skills")).toBe(false);
  await drawer.getByRole("button", { name: "Apply discovery and reload" }).click();
  await expect(drawer).toContainText("3 session skills");
  await expect(drawer).toContainText("Reloaded skills for Q:\\repo-a");
  const reloads = state.requests.filter((request) => request.command === "reload_session_skills");
  expect(reloads.map((request) => request.args)).toEqual([{ sessionId: "a", cwd: "Q:\\repo-a" }]);
  expect(state.skills.find((entry) => entry.name === "disabled")!.enabled).toBe(false);
  await drawer.getByRole("button", { name: "Close context" }).click();
  await expect(composer).toHaveValue("Keep my draft");
  expect(state.requests.some((request) => ["send_message", "set_tool_enabled", "set_mcp_enabled"].includes(request.command))).toBe(false);
});

test("changing terminal CWD invalidates a preview and reload targets the confirmed new directory", async ({ page }) => {
  const { state, open } = await setup(page);
  await page.getByTitle("Open terminal", { exact: true }).click();
  await expect(page.locator(".terminal-title strong")).toHaveText("Fixture shell");
  const drawer = await open();
  await drawer.getByRole("button", { name: "Load skills from current directory" }).click();
  await expect(drawer.getByRole("button", { name: "Apply discovery and reload" })).toBeVisible();
  state.socket!.send(JSON.stringify({ type: "cwd", cwd: "Q:\\repo-b" }));
  await expect(drawer.getByRole("button", { name: "Apply discovery and reload" })).toHaveCount(0);
  await expect(drawer.locator(".skills-cwd").first()).toHaveText("Q:\\repo-b");
  await drawer.getByRole("button", { name: "Refresh skill list" }).click();
  await drawer.getByRole("button", { name: "Load skills from current directory" }).click();
  await drawer.getByRole("button", { name: "Apply discovery and reload" }).click();
  await expect(drawer).toContainText("Reloaded skills for Q:\\repo-b");
  expect(state.requests.filter((request) => request.command === "reload_session_skills").map((request) => request.args.cwd)).toEqual(["Q:\\repo-b"]);
});

test("busy rejection and partial reload diagnostics stay visible without pretending success", async ({ page }) => {
  const { state, open } = await setup(page);
  const drawer = await open();
  await drawer.getByRole("button", { name: "Load skills from current directory" }).click();
  state.error = "Wait for background tasks to finish";
  await drawer.getByRole("button", { name: "Apply discovery and reload" }).click();
  await expect(drawer.getByRole("alert")).toContainText("background tasks");
  await expect(drawer).not.toContainText("Reloaded skills for");
  state.error = "";
  state.warnings = ["Duplicate name in repository"];
  state.errors = ["Malformed SKILL.md"];
  await drawer.getByRole("button", { name: "Apply discovery and reload" }).click();
  await expect(drawer).toContainText("completed with errors");
  await expect(drawer.getByRole("alert")).toContainText("Malformed SKILL.md");
  await expect(drawer).toContainText("Duplicate name in repository");
});

test("leaving the skill panel while a reload runs cannot leak a late response into the reopened panel", async ({ page }) => {
  const { state, open } = await setup(page);
  const drawer = await open();
  state.holdReload = true;
  await drawer.getByRole("button", { name: "Load skills from current directory" }).click();
  await drawer.getByRole("button", { name: "Apply discovery and reload" }).click();
  await expect.poll(() => !!state.pending).toBe(true);
  await drawer.getByRole("button", { name: "Close context" }).click();
  await open();
  await state.pending!.fulfill({ json: { sessionId: "a", cwd: "Q:\\repo-a", skills: [skill("stale-only")], errors: [], warnings: [] } });
  await expect(drawer).not.toContainText("stale-only");
  await expect(drawer).not.toContainText("Reloaded skills for");
});

test.describe("mobile skills", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test("preview and load controls fit the phone and keep readable source paths", async ({ page }, testInfo) => {
    const { open } = await setup(page);
    const drawer = await open();
    await drawer.getByRole("button", { name: "Load skills from current directory" }).tap();
    const apply = drawer.getByRole("button", { name: "Apply discovery and reload" });
    await apply.scrollIntoViewIfNeeded();
    expect((await apply.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await drawer.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("skill-preview-mobile.png") });
    await apply.tap();
    await expect(drawer).toContainText("3 session skills");
  });
});
