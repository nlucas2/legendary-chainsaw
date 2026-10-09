import { test, expect, type Page, type Route } from "@playwright/test";

async function setup(page: Page) {
  const session = { sessionId: "selection", title: "Text selection fixture", cwd: "Q:\\fixture", model: "model",
    isActive: true, isRemote: false, pinned: false, archived: false, tags: [], startTime: "", modifiedTime: "" };
  const state = { hold: false, pending: undefined as Route | undefined, requests: [] as string[] };
  const inventory = {
    tools: Array.from({ length: 216 }, (_, i) => ({ id: `mcp:fixture-${i}`, name: `fixture-${i}`,
      source: "mcp", serverName: `server-${i % 13}`, enabled: true,
      description: "Synthetic tool description for selection performance. ".repeat(8) })),
    servers: Array.from({ length: 13 }, (_, i) => ({ name: `server-${i}`, status: "connected" })),
    excludedTools: [], filterOwnership: "unknown", filterStateKnown: false, requiresAdoption: true, canEditTools: false,
    metadataAvailable: true, inventoryLoading: false, metadataLoading: false, warnings: [],
  };
  await page.addInitScript(() => {
    class Events extends EventTarget {
      onopen: (() => void) | null = null;
      listener = (event: Event) => {
        if (event instanceof CustomEvent) this.dispatchEvent(new MessageEvent("session-event", { data: JSON.stringify(event.detail) }));
      };
      constructor() {
        super(); window.addEventListener("tools-selection-event", this.listener); setTimeout(() => this.onopen?.(), 0);
      }
      close() { window.removeEventListener("tools-selection-event", this.listener); }
    }
    Object.defineProperty(window, "EventSource", { value: Events });
  });
  await page.route("**/api/**", (route) => {
    const command = new URL(route.request().url()).pathname.split("/").at(-1)!;
    state.requests.push(command);
    const responses: Record<string, unknown> = {
      list_sessions: [session], resume_session: session, runtime_status: { connected: true, acceptingWork: true },
      session_state: { sessionId: session.sessionId, processing: false, mode: "interactive" }, session_processing: false,
      get_session_profile: { sessionId: session.sessionId, profile: null, applying: false, configurationBlocked: false, requiresReconnect: false, error: null },
      pending_permissions: [], pending_interactions: [], subagent_context: [], queue_items: { items: [], steeringMessages: [] },
      agent_tasks: { sessionId: session.sessionId, tasks: [] }, git_repository: { isRepository: false },
      session_history_window: { events: [{ id: "u", type: "user.message", timestamp: "", data: { content: "Underlying transcript. ".repeat(500) } }],
        hasMore: false, cursor: "", loadedPages: 1, humanMessages: 1 },
      context_attribution: { entries: [], categories: {}, totalTokens: 500, limit: 10000, promptTokenLimit: 8000 },
      tool_controls: inventory,
      session_references: Object.fromEntries(["commands", "skills", "mcp", "mcpTools", "tools", "instructions", "contextAttribution", "tasks"].map((key) => [key, {}])),
    };
    if (command === "tool_controls" && state.hold) { state.pending = route; return; }
    return command in responses ? route.fulfill({ json: responses[command] }) : route.fulfill({ status: 404, body: "Unexpected request" });
  });
  await page.goto("/?session=selection");
  await expect(page.locator(".parent-session-view .composer textarea")).toBeEnabled();
  await page.getByTitle("Browse commands, tools, skills, MCP, and instructions").click();
  const drawer = page.getByRole("dialog", { name: "Session context and references" });
  await drawer.getByRole("tab", { name: "Tools", exact: true }).click();
  await expect(drawer.locator(".ct-tool-list .ct-tool")).toHaveCount(30);
  const emit = () => page.evaluate(() => window.dispatchEvent(new CustomEvent("tools-selection-event", {
    detail: { type: "tool_inventory_updated", sessionId: "selection" },
  })));
  return { drawer, state, inventory, emit };
}

test("Context keeps dimming without filtering the entire transcript during native text selection", async ({ page }) => {
  const { drawer, state } = await setup(page);
  const scrim = page.locator(".reference-scrim");
  await expect(scrim).toHaveCSS("backdrop-filter", "none");
  await expect(scrim).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const start = drawer.getByRole("region", { name: "Manage existing session tool selection" }).locator("strong");
  const end = drawer.locator("p.ct-help").filter({ hasText: "Not offered does not necessarily" });
  await drawer.locator(".reference-list").evaluate((element) => { element.scrollTop = 0; });
  const first = (await start.boundingBox())!, last = (await end.boundingBox())!;
  await page.mouse.move(first.x + 1, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(last.x + 150, last.y + 8, { steps: 35 });
  await page.mouse.up();
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selected).toContain("Tool selection is not managed");
  expect(selected).toContain("Manage this session");
  expect(selected).toContain("Not offered");
  expect(state.requests.some((command) => ["adopt_tool_controls", "set_tool_enabled", "set_mcp_enabled"].includes(command))).toBe(false);
});

test("background Tools refresh keeps text stationary and preserves a native selection across paragraphs", async ({ page }) => {
  const { drawer, state, inventory, emit } = await setup(page);
  const intro = drawer.getByRole("region", { name: "Manage existing session tool selection" });
  const start = intro.locator("strong");
  const end = drawer.locator("p.ct-help").filter({ hasText: "Not offered does not necessarily" });
  await drawer.locator(".reference-list").evaluate((element) => { element.scrollTop = 0; });
  const first = (await start.boundingBox())!, last = (await end.boundingBox())!;
  await page.mouse.move(first.x + 1, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(last.x + 150, last.y + 8, { steps: 35 });
  const selection = await page.evaluate(() => window.getSelection()?.toString());
  state.hold = true;
  await emit();
  await expect.poll(() => !!state.pending).toBe(true);
  await expect(drawer.getByRole("status").filter({ hasText: "Refreshing session tools" })).toBeVisible();
  expect((await start.boundingBox())!.y).toBeCloseTo(first.y, 1);
  expect((await end.boundingBox())!.y).toBeCloseTo(last.y, 1);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selection);
  await state.pending!.fulfill({ json: inventory });
  await expect(drawer.locator(".ct-refresh-status")).toHaveCount(0);
  expect((await start.boundingBox())!.y).toBeCloseTo(first.y, 1);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selection);
  await page.mouse.up();
  await expect(drawer.getByRole("button", { name: "Manage this session’s tool selection" })).toBeEnabled();
  expect(state.requests.some((command) => ["adopt_tool_controls", "set_tool_enabled", "set_mcp_enabled"].includes(command))).toBe(false);
});
