import { test, expect, type Page, type Route } from "@playwright/test";

const longMessage = "Please keep this queued follow-up readable without taking over the chat. ".repeat(25);
const item = (id: string, displayText = longMessage) => ({ id, displayText, kind: "message", agentMode: "interactive" });
async function setup(page: Page, count = 1) {
  const session = (sessionId: string) => ({
    sessionId, title: `Session ${sessionId}`, cwd: "Q:\\example", model: "model", isActive: true,
    isRemote: false, archived: false, pinned: false, tags: [], startTime: "", modifiedTime: "",
  });
  const state = {
    queues: {
      a: { items: Array.from({ length: count }, (_, index) => item(`a-${index}`)), steeringMessages: [] as string[] },
      b: { items: [item("b-0", "B queued message")], steeringMessages: [] as string[] },
    } as Record<string, { items: ReturnType<typeof item>[]; steeringMessages: string[] }>,
    actions: [] as Record<string, unknown>[],
    heldRemoves: new Map<string, Route>(),
    holdRemove: false,
  };
  await page.addInitScript(() => {
    localStorage.setItem("copilot-sessions.chat-width", "full");
    class QueueEventSource extends EventTarget {
      onopen: (() => void) | null = null;
      listener = (event: Event) => {
        if (event instanceof CustomEvent) this.dispatchEvent(new MessageEvent("session-event", { data: JSON.stringify(event.detail) }));
      };
      constructor() { super(); window.addEventListener("queue-fixture-event", this.listener); setTimeout(() => this.onopen?.(), 0); }
      close() { window.removeEventListener("queue-fixture-event", this.listener); }
    }
    Object.defineProperty(window, "EventSource", { value: QueueEventSource });
  });
  await page.route("**/api/**", async (route) => {
    const command = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const args = route.request().postDataJSON() ?? {};
    let result: unknown;
    switch (command) {
      case "list_sessions": result = [session("a"), session("b")]; break;
      case "resume_session": result = session(args.sessionId); break;
      case "runtime_status": result = { connected: true, acceptingWork: true, activeSessions: 2 }; break;
      case "session_state": result = { sessionId: args.sessionId, mode: "interactive", processing: true }; break;
      case "session_processing": result = true; break;
      case "pending_permissions": case "pending_interactions": case "subagent_context": result = []; break;
      case "queue_items": result = state.queues[args.sessionId]; break;
      case "git_repository": result = { isRepository: false }; break;
      case "session_history_window": result = {
        events: [{ id: "user", type: "user.message", timestamp: "", data: { content: "Existing conversation" } }],
        hasMore: false, cursor: "", loadedPages: 1, humanMessages: 1,
      }; break;
      case "queue_action": {
        state.actions.push(args);
        const queue = state.queues[args.sessionId];
        const index = queue.items.findIndex((entry) => entry.id === args.itemId);
        if (args.action === "update") queue.items[index].displayText = args.prompt;
        if (args.action === "move") queue.items.splice(args.toPosition, 0, queue.items.splice(index, 1)[0]);
        if (args.action === "sendNow") queue.steeringMessages.push(queue.items.splice(index, 1)[0].displayText);
        result = { steered: true };
        break;
      }
      case "remove_queue_item":
        state.actions.push({ command, ...args });
        if (state.holdRemove) { state.heldRemoves.set(args.sessionId, route); return; }
        state.queues[args.sessionId].items = state.queues[args.sessionId].items.filter((entry) => entry.id !== args.itemId);
        result = null;
        break;
      default: return route.fulfill({ status: 404, body: `Unexpected ${command}` });
    }
    return route.fulfill({ json: result });
  });
  await page.goto("/?session=a");
  await expect(page.locator(".parent-session-view .composer textarea")).toBeEnabled();
  if (count) await expect(page.locator(".message-queue-item")).toHaveCount(count);
  const refresh = () => page.evaluate(() => window.dispatchEvent(new CustomEvent("queue-fixture-event", { detail: {
    type: "session_event", sessionId: "a",
    event: { id: crypto.randomUUID(), type: "pending_messages.modified", timestamp: "", data: {} },
  } })));
  return { state, refresh };
}

test("a long queued message uses one compact desktop row with horizontal actions", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await setup(page);
  const queue = page.getByRole("region", { name: "Message queue", exact: true });
  const row = queue.locator(".message-queue-item");
  expect((await row.boundingBox())!.height).toBeLessThanOrEqual(48);
  expect((await queue.boundingBox())!.height).toBeLessThanOrEqual(84);
  await expect(row.locator(".queue-actions")).toHaveCSS("flex-direction", "row");
  await expect(row.locator(".queue-actions")).toHaveCSS("flex-grow", "0");
  await expect(row.locator(".queue-item-content strong")).toHaveAttribute("title", longMessage);
  await expect(row.locator(".queue-item-content strong")).toHaveCSS("text-overflow", "ellipsis");
  const buttons = await row.locator(".queue-actions button").evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().y));
  expect(Math.max(...buttons) - Math.min(...buttons)).toBeLessThan(2);
  expect(await queue.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await queue.screenshot({ path: testInfo.outputPath("compact-message-queue.png") });
});

test("collapse keeps a one-line preview and survives incoming queue updates without losing the composer draft", async ({ page }) => {
  const { state, refresh } = await setup(page);
  const composer = page.locator(".parent-session-view .composer textarea");
  await composer.fill("Unsent draft stays here");
  const queue = page.locator(".message-queue");
  await queue.locator("summary").click();
  await expect(queue.locator("details")).not.toHaveAttribute("open");
  await expect(queue.locator(".queue-next-preview")).toBeVisible();
  expect((await queue.boundingBox())!.height).toBeLessThanOrEqual(40);
  state.queues.a.items.push(item("a-1", "New incoming queued item"));
  await refresh();
  await expect(queue.locator("summary strong")).toHaveText("2 queued");
  await expect(queue.locator("details")).not.toHaveAttribute("open");
  await expect(composer).toHaveValue("Unsent draft stays here");
  await queue.locator("summary").focus();
  await queue.locator("summary").press("Enter");
  await expect(queue.locator(".message-queue-item")).toHaveCount(2);
  expect(state.actions).toHaveLength(0);
});

test("long queues scroll within a bounded list while their collapse control remains visible", async ({ page }) => {
  await setup(page, 20);
  const queue = page.locator(".message-queue");
  const list = queue.locator(".message-queue-items");
  expect((await queue.boundingBox())!.height).toBeLessThanOrEqual(180);
  expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(queue.locator("summary")).toBeInViewport();
  await expect(queue.locator("[data-queue-id='a-19']")).toBeInViewport();
});

test("an empty queue has no footprint and steering-only content has an accurate compact heading", async ({ page }) => {
  const { state, refresh } = await setup(page, 0);
  const queue = page.locator(".message-queue");
  await expect(queue).toBeHidden();
  state.queues.a.steeringMessages.push("Guidance already sent");
  await refresh();
  await expect(queue.locator("summary strong")).toHaveText("1 guidance sent");
  await expect(queue.locator(".queue-actions")).toHaveCount(0);
  await queue.locator("summary").click();
  await expect(queue.locator(".queue-next-preview")).toHaveText("Guidance already sent");
  expect(state.actions).toHaveLength(0);
});

test("edit, cancel, reorder, send-now and remove keep their existing queue semantics", async ({ page }) => {
  const { state } = await setup(page, 2);
  const queue = page.locator(".message-queue");
  const second = queue.locator("[data-queue-id='a-1']");
  await second.getByTitle("Edit queued message", { exact: true }).click();
  await queue.getByRole("textbox", { name: "Edit queued message", exact: true }).fill("Temporary edit");
  await queue.getByTitle("Cancel editing queued message", { exact: true }).click();
  expect(state.actions).toHaveLength(0);
  await second.getByTitle("Edit queued message", { exact: true }).click();
  await queue.getByRole("textbox", { name: "Edit queued message", exact: true }).fill("Edited queue message");
  await queue.getByRole("button", { name: "Save", exact: true }).click();
  await expect(second).toContainText("Edited queue message");
  await second.getByTitle("Move queued message earlier", { exact: true }).click();
  await expect(queue.locator(".message-queue-item").first()).toHaveAttribute("data-queue-id", "a-1");
  await second.getByTitle("Send as guidance to the running turn", { exact: true }).click();
  await expect(queue.locator("summary strong")).toHaveText("1 queued · 1 guidance sent");
  await queue.locator("[data-queue-id='a-0']").getByTitle("Remove queued prompt", { exact: true }).click();
  await expect(queue.locator("summary strong")).toHaveText("1 guidance sent");
  expect(state.actions).toEqual([
    { sessionId: "a", action: "update", itemId: "a-1", prompt: "Edited queue message" },
    { sessionId: "a", action: "move", itemId: "a-1", toPosition: 0 },
    { sessionId: "a", action: "sendNow", itemId: "a-1" },
    { command: "remove_queue_item", sessionId: "a", itemId: "a-0" },
  ]);
});

test("errors stay visible when collapsed and pending actions remain session-scoped", async ({ page }) => {
  const { state } = await setup(page);
  state.holdRemove = true;
  const queue = page.locator(".message-queue");
  await queue.getByTitle("Remove queued prompt", { exact: true }).click();
  await expect.poll(() => state.heldRemoves.has("a")).toBe(true);
  await queue.locator("summary").click();
  await state.heldRemoves.get("a")!.fulfill({ status: 500, body: "Queue action failed" });
  await expect(queue.getByRole("alert")).toHaveText("Error: Queue action failed");
  await expect(queue.locator("details")).not.toHaveAttribute("open");
  await page.locator("[data-session-id='b'] .session-open").click();
  await expect(queue.getByTitle("Remove queued prompt", { exact: true })).toBeEnabled();
  await expect(queue.getByRole("alert")).toHaveCount(0);
  await queue.getByTitle("Remove queued prompt", { exact: true }).click();
  await expect.poll(() => state.heldRemoves.has("b")).toBe(true);
  await page.locator("[data-session-id='a'] .session-open").click();
  await expect(queue.getByTitle("Remove queued prompt", { exact: true })).toBeEnabled();
  await state.heldRemoves.get("b")!.fulfill({ json: null });
});

test.describe("compact touch queue", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test("touch actions stay in one row with usable targets and no horizontal overflow", async ({ page }) => {
    await setup(page);
    const queue = page.locator(".message-queue");
    expect((await queue.boundingBox())!.height).toBeLessThanOrEqual(100);
    const boxes = await queue.locator(".queue-actions button").evaluateAll((buttons) => buttons.map((button) => {
      const { x, y, width, height } = button.getBoundingClientRect();
      return { x, y, width, height };
    }));
    expect(boxes.every((box) => box.width >= 44 && box.height >= 44)).toBe(true);
    expect(Math.max(...boxes.map((box) => box.y)) - Math.min(...boxes.map((box) => box.y))).toBeLessThan(2);
    expect(await queue.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await queue.getByTitle("Edit queued message", { exact: true }).tap();
    await queue.getByRole("textbox", { name: "Edit queued message", exact: true }).fill("Mobile edit");
    await queue.getByRole("button", { name: "Save", exact: true }).tap();
    await expect(queue.locator(".queue-item-content strong")).toHaveText("Mobile edit");
  });
});
