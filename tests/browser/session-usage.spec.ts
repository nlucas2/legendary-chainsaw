import { test, expect, type Page } from "@playwright/test";

async function setup(page: Page) {
  const session = { sessionId: "usage", title: "Usage fixture", cwd: "Q:\\example", model: "example-model",
    isActive: true, isRemote: false, pinned: false, archived: false, tags: [], startTime: "", modifiedTime: "" };
  const history = { events: [], hasMore: false, cursor: "", loadedPages: 1, humanMessages: 0 };
  const state = { totalNanoAiu: 1_250_000_000 as number | null, error: false, reads: 0 };
  await page.addInitScript(() => {
    class Events extends EventTarget {
      onopen: (() => void) | null = null;
      listener = (event: Event) => {
        if (event instanceof CustomEvent) this.dispatchEvent(new MessageEvent("session-event", { data: JSON.stringify(event.detail) }));
      };
      constructor() {
        super();
        window.addEventListener("usage-fixture-event", this.listener);
        setTimeout(() => this.onopen?.(), 0);
      }
      close() { window.removeEventListener("usage-fixture-event", this.listener); }
    }
    Object.defineProperty(window, "EventSource", { value: Events });
  });
  await page.routeWebSocket("**/api/terminal**", (socket) => {
    socket.send(JSON.stringify({ type: "ready", shell: "Example shell", cwd: session.cwd, hasControl: true, viewers: 1 }));
  });
  await page.route("**/api/**", (route) => {
    const command = new URL(route.request().url()).pathname.split("/").at(-1)!;
    let result: unknown;
    switch (command) {
      case "list_sessions": result = [session]; break;
      case "resume_session": result = session; break;
      case "runtime_status": result = { connected: true, acceptingWork: true }; break;
      case "session_state": result = { sessionId: session.sessionId, processing: false, mode: "interactive" }; break;
      case "session_processing": result = false; break;
      case "get_session_profile": result = { sessionId: session.sessionId, profile: null, applying: false, configurationBlocked: false, requiresReconnect: false, error: null }; break;
      case "queue_items": result = { items: [], steeringMessages: [] }; break;
      case "agent_tasks": result = { sessionId: session.sessionId, tasks: [] }; break;
      case "pending_permissions": case "pending_interactions": case "subagent_context": result = []; break;
      case "git_repository": result = { isRepository: false }; break;
      case "session_history_window": result = history; break;
      case "refresh_session": result = { session, history, runtimeRecycled: false }; break;
      case "context_attribution": result = { contextAttribution: null }; break;
      case "session_usage":
        state.reads++;
        if (state.error) return route.fulfill({ status: 503, json: { error: "Usage snapshot unavailable" } });
        result = { totalNanoAiu: state.totalNanoAiu };
        break;
      case "session_references": result = Object.fromEntries(["commands", "skills", "mcp", "tools", "mcpTools", "instructions", "contextAttribution", "tasks"].map((name) => [name, {}])); break;
      default: return route.fulfill({ status: 404, body: `Unexpected ${command}` });
    }
    return route.fulfill({ json: result });
  });
  await page.goto("/?session=usage");
  await expect(page.locator(".parent-session-view .composer textarea")).toBeEnabled();
  await page.getByTitle("Browse commands, tools, skills, MCP, and instructions").click();
  const credits = page.getByRole("region", { name: "Session AI credits", exact: true });
  const emit = (type: string, data: unknown = {}, agentId?: string) => page.evaluate(({ type, data, agentId }) =>
    window.dispatchEvent(new CustomEvent("usage-fixture-event", { detail: {
      type: "session_event", sessionId: "usage", event: { id: crypto.randomUUID(), type, data, agentId, timestamp: "" },
    } })), { type, data, agentId });
  const gap = () => page.evaluate(() => window.dispatchEvent(new CustomEvent("usage-fixture-event", { detail: {
    type: "event_gap", sessionId: "usage", skipped: 2,
  } })));
  return { state, credits, emit, gap };
}

test("native credits are visible without context tokens or diagnostics and refresh for subagents, checkpoints and gaps", async ({ page }) => {
  const { state, credits, emit, gap } = await setup(page);
  await expect(credits.locator("dd")).toHaveText("1.25");
  await expect(credits).toContainText("including subagents");
  await expect(page.locator(".raw-diagnostics")).toHaveCount(0);
  state.totalNanoAiu = 2_000_000_000;
  await emit("assistant.usage", { cost: 100, copilotUsage: { totalNanoAiu: 999_000_000_000 } }, "child");
  await expect(credits.locator("dd")).toHaveText("2");
  state.totalNanoAiu = 1_000_000_000;
  await emit("session.usage_checkpoint", { totalNanoAiu: 99_000_000_000 });
  await expect(credits.locator("dd")).toHaveText("1");
  state.totalNanoAiu = 4_000_000_000;
  await gap();
  await expect(credits.locator("dd")).toHaveText("4");
  expect(state.reads).toBeGreaterThanOrEqual(4);
});

test("unknown and zero totals remain distinct; read errors preserve a labeled stale snapshot and retry", async ({ page }) => {
  const { state, credits, emit } = await setup(page);
  await expect(credits.locator("dd")).toHaveText("1.25");
  state.totalNanoAiu = null;
  await emit("session.usage_checkpoint");
  await expect(credits.locator("dd")).toHaveText("Unavailable");
  state.totalNanoAiu = 0;
  await emit("assistant.idle");
  await expect(credits.locator("dd")).toHaveText("0");
  state.error = true;
  await emit("session.usage_checkpoint");
  const error = page.getByRole("alert").filter({ hasText: "Could not refresh session AI credits." });
  await expect(error).toContainText("last successful snapshot");
  await expect(credits.locator("dd")).toHaveText("0");
  state.error = false;
  state.totalNanoAiu = 3_000_000_000;
  await error.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(credits.locator("dd")).toHaveText("3");
  await expect(error).toHaveCount(0);
});
