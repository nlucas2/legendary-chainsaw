import { test, expect, type APIRequestContext, type Page, type Route } from "@playwright/test";

test.describe.configure({ mode: "serial" });
const sessions: { sessionId: string }[] = [];

async function command(api: APIRequestContext, name: string, args: Record<string, unknown> = {}) {
  const response = await api.post(`/api/${name}`, {
    data: args,
    timeout: name === "create_session" ? 60_000 : 15_000,
  });
  expect(response.ok(), `${name}: ${await response.text()}`).toBeTruthy();
  return response.json();
}

test.beforeAll(async ({ request }) => {
  for (let i = 0; i < 2; i++) {
    sessions.push(await command(request, "create_session", {
      cwd: process.cwd(), model: "gpt-5.6-luna", reasoningEffort: "low",
    }));
  }
});

test.afterAll(async ({ request }) => {
  for (const { sessionId } of sessions) {
    await command(request, "abort_session", { sessionId });
    await command(request, "delete_session", { sessionId });
  }
});

async function open(page: Page) {
  await page.route("**/api/list_sessions", (route) => route.fulfill({ json: sessions }));
  await page.goto(`/?session=${sessions[0].sessionId}`);
  await expect(page.locator(".composer textarea")).toBeEnabled();
}

async function select(page: Page, index: number) {
  await page.locator(`[data-session-id="${sessions[index].sessionId}"] .session-open`).click();
  await expect(page.locator(".composer textarea")).toBeEnabled();
}

test("draft text and attachments survive switching and a delayed failed send", async ({ page }) => {
  await open(page);
  const prompt = page.locator(".composer textarea");
  await prompt.fill("Session A prompt");
  await page.locator('input[type="file"]').setInputFiles({
    name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("A"),
  });
  await expect(page.locator(".attachment-chip")).toContainText("a.txt");
  await select(page, 1);
  await expect(prompt).toHaveValue("");
  await expect(page.locator(".attachment-chip")).toHaveCount(0);
  await prompt.fill("Session B prompt");
  await select(page, 0);
  await expect(prompt).toHaveValue("Session A prompt");
  await expect(page.locator(".attachment-chip")).toContainText("a.txt");

  let send: Route | undefined;
  await page.route("**/api/send_message", (route) => { send = route; });
  await prompt.press("Enter");
  await expect.poll(() => !!send).toBe(true);
  await select(page, 1);
  await expect(prompt).toHaveValue("Session B prompt");
  await send!.fulfill({ status: 500, json: { error: "Simulated network failure" } });
  await select(page, 0);
  await expect(prompt).toHaveValue("Session A prompt");
  await expect(page.locator(".attachment-chip")).toContainText("a.txt");
  await expect(page.locator(".composer > [role=alert]")).toContainText("Simulated network failure");
  await select(page, 1);
  await expect(prompt).toHaveValue("Session B prompt");
  await expect(page.locator(".attachment-chip")).toHaveCount(0);
});

test("mode requests remain scoped while switching between two pending sessions", async ({ page }) => {
  await open(page);
  const requests = new Map<string, Route>();
  await page.route("**/api/set_session_mode", (route) => {
    requests.set(route.request().postDataJSON().sessionId, route);
  });
  const plan = page.locator(".agent-mode-switcher").getByRole("button", { name: "Plan", exact: true });
  await plan.click();
  await expect(plan).toBeDisabled();
  await select(page, 1);
  await expect(plan).toBeEnabled();
  await plan.click();
  await expect.poll(() => requests.size).toBe(2);
  await requests.get(sessions[0].sessionId)!.fulfill({ json: {} });
  await select(page, 0);
  await expect(plan).toBeEnabled();
  await select(page, 1);
  await expect(plan).toBeDisabled();
  await requests.get(sessions[1].sessionId)!.fulfill({ json: {} });
  await expect(plan).toBeEnabled();
});

test("queue actions do not strand another session or clear its pending action", async ({ page }) => {
  await page.route("**/api/queue_items", (route) => route.fulfill({
    json: { items: [{ id: "queued", displayText: "Queued draft", kind: "message", agentMode: "interactive" }], steeringMessages: [] },
  }));
  const requests = new Map<string, Route>();
  await page.route("**/api/remove_queue_item", (route) => {
    requests.set(route.request().postDataJSON().sessionId, route);
  });
  await open(page);
  const remove = page.getByTitle("Remove queued prompt");
  await remove.click();
  await expect(remove).toBeDisabled();
  await select(page, 1);
  await expect(remove).toBeEnabled();
  await remove.click();
  await expect.poll(() => requests.size).toBe(2);
  await requests.get(sessions[0].sessionId)!.fulfill({ json: {} });
  await select(page, 0);
  await expect(remove).toBeEnabled();
  await select(page, 1);
  await expect(remove).toBeDisabled();
  await requests.get(sessions[1].sessionId)!.fulfill({ json: {} });
  await expect(remove).toBeEnabled();
});

test("elicitation constraints block malformed replies and preserve required false booleans", async ({ page }) => {
  const replies: Record<string, unknown>[] = [];
  await page.route("**/api/pending_interactions", (route) => route.fulfill({
    json: [{
      sessionId: sessions[0].sessionId, requestId: "validation-form", kind: "elicitation",
      data: {
        mode: "form", message: "A constrained form",
        requestedSchema: {
          type: "object",
          properties: {
            enabled: { type: "boolean", title: "Feature switch" },
            name: { type: "string", title: "Name", minLength: 3, maxLength: 8 },
            count: { type: "integer", title: "Count", minimum: 2, maximum: 4 },
          },
          required: ["enabled", "name", "count"],
        },
      },
    }],
  }));
  await page.route("**/api/respond_interaction", (route) => {
    replies.push(route.request().postDataJSON().response);
    return route.fulfill({ json: { success: true } });
  });
  await open(page);
  const panel = page.locator(".interaction-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("checkbox", { name: /Feature switch/ })).not.toBeChecked();
  await panel.getByRole("textbox", { name: /Name/ }).fill("ab");
  await panel.getByRole("spinbutton", { name: /Count/ }).fill("2");
  await panel.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(panel.getByRole("alert")).toBeVisible();
  expect(replies).toHaveLength(0);
  await panel.getByRole("textbox", { name: /Name/ }).fill("Alice");
  await panel.getByRole("spinbutton", { name: /Count/ }).fill("1");
  await panel.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(panel.getByRole("alert")).toBeVisible();
  expect(replies).toHaveLength(0);
  await panel.getByRole("spinbutton", { name: /Count/ }).fill("2");
  await panel.getByRole("button", { name: "Submit", exact: true }).click();
  await expect.poll(() => replies.length).toBe(1);
  expect(replies[0]).toEqual({ action: "accept", content: { enabled: false, name: "Alice", count: 2 } });
});
