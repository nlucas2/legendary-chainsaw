import { test, expect, type APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });
let sessionId: string;

async function command(api: APIRequestContext, name: string, args: Record<string, unknown> = {}) {
  const response = await api.post(`/api/${name}`, {
    data: { sessionId, ...args },
    timeout: name === "create_session" ? 60_000 : 15_000,
  });
  expect(response.ok(), `${name}: ${await response.text()}`).toBeTruthy();
  return response.json();
}

test.beforeAll(async ({ request }) => {
  const created = await command(request, "create_session", {
    cwd: process.cwd(),
    model: "gpt-5.6-luna",
    reasoningEffort: "low",
    reasoningSummary: "detailed",
  });
  sessionId = created.sessionId;
});

test.afterAll(async ({ request }) => {
  if (!sessionId) return;
  await command(request, "abort_session");
  await command(request, "delete_session");
});

test("Context loads and tool selection can change", async ({ page, request }) => {
  await page.goto(`/?session=${sessionId}`);
  await expect(page.locator(".composer textarea")).toBeEnabled();
  await page.getByTitle("Browse commands, tools, skills, MCP, and instructions").click();
  await expect(page.locator(".reference-drawer")).toBeVisible();
  const started = performance.now();
  await page.getByRole("tab", { name: "Tools", exact: true }).click();
  await expect(page.locator(".ct-tool-list")).toBeVisible({ timeout: 2000 });
  const visibleMs = performance.now() - started;
  expect(visibleMs).toBeLessThan(2000);
  console.info(`Tools list visible in ${Math.round(visibleMs)} ms`);
  const search = page.getByRole("textbox", { name: "Search tools" });
  await search.fill("builtin:glob");
  const toggle = page.getByRole("switch", { name: /Allow builtin:glob / });
  await expect(toggle).toBeEnabled();
  const before = await command(request, "tool_controls");
  expect(before.canEditTools).toBe(true);
  expect(before.tools.find((tool: { id: string }) => tool.id === "builtin:glob").enabled).toBe(true);
  const mutations: boolean[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/set_tool_enabled")) mutations.push(request.postDataJSON().enabled);
  });
  await toggle.click();
  await expect.poll(async () => (await command(request, "tool_controls")).excludedTools.includes("builtin:glob")).toBe(true);
  await expect.poll(async () => (await command(request, "tool_controls")).tools.find(
    (tool: { id: string }) => tool.id === "builtin:glob").enabled).toBe(false);
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect.poll(async () => (await command(request, "tool_controls")).excludedTools.includes("builtin:glob")).toBe(false);
  await expect.poll(async () => (await command(request, "tool_controls")).tools.find(
    (tool: { id: string }) => tool.id === "builtin:glob").enabled).toBe(true);
  await expect(toggle).toBeChecked();
  expect(mutations).toEqual([false, true]);
});

test("reopening Tools keeps the last snapshot while a fresh read is pending", async ({ page }) => {
  await page.goto(`/?session=${sessionId}`);
  await expect(page.locator(".composer textarea")).toBeEnabled();
  const open = page.getByTitle("Browse commands, tools, skills, MCP, and instructions");
  await open.click();
  await page.getByRole("tab", { name: "Tools", exact: true }).click();
  await expect(page.locator(".ct-tool-list")).toBeVisible({ timeout: 2000 });
  await page.getByRole("dialog", { name: "Session context and references" })
    .getByRole("button", { name: "Close context" }).click();
  await expect(page.locator(".reference-drawer")).toBeHidden();
  let pending: import("@playwright/test").Route | undefined;
  await page.route("**/api/tool_controls", (route) => { pending = route; });
  await open.click();
  await page.getByRole("tab", { name: "Tools", exact: true }).click();
  await expect.poll(() => !!pending).toBe(true);
  await expect(page.locator(".ct-tool-list")).toBeVisible();
  await expect(page.getByText("Reading session tools", { exact: false })).toHaveCount(0);
  await expect(page.locator(".ct-tool-list input[role=switch]").first()).toBeDisabled();
  await pending!.fulfill({ response: await pending!.fetch() });
  await expect(page.locator(".ct-tool-list input[role=switch]").first()).toBeEnabled();
});

test("clipboard images become drafts and large text remains intact", async ({ page }) => {
  await page.goto(`/?session=${sessionId}`);
  const prompt = page.locator(".composer textarea");
  await expect(prompt).toBeEnabled();
  const prevented = await prompt.evaluate((element) => {
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cgr8AAAAASUVORK5CYII="), (c) => c.charCodeAt(0));
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([bytes], "pasted-image.png", { type: "image/png" }));
    const event = new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(true);
  await expect(page.locator(".attachment-chip")).toContainText("pasted-image.png");
  await page.getByRole("button", { name: "Remove pasted-image.png" }).click();
  const text = "Long pasted line with Unicode: \u03bb\u{1f680}\n".repeat(5000);
  const swallowed = await prompt.evaluate((element, value) => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", value);
    const event = new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }, text);
  expect(swallowed).toBe(false);
  // Synthetic paste has no native insertion. Exercise its resulting input
  // event without replacing the user's Windows clipboard or using CDP typing.
  await prompt.evaluate((element, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }, text);
  expect((await prompt.inputValue()) === text).toBe(true);
  let submitted: string | undefined;
  await page.route("**/api/send_message", (route) => {
    submitted = route.request().postDataJSON().content;
    return route.fulfill({ json: "accepted-test-message" });
  });
  await prompt.press("Enter");
  await expect.poll(() => submitted !== undefined).toBe(true);
  expect(submitted === text.trim()).toBe(true);
});

test("Tab changes the native mode and Escape closes dialogs", async ({ page, request }) => {
  await page.goto(`/?session=${sessionId}`);
  const prompt = page.locator(".composer textarea");
  await expect(prompt).toBeEnabled();
  await prompt.focus();
  await page.keyboard.press("Tab");
  await expect.poll(async () => (await command(request, "session_state")).mode).toBe("plan");
  await expect(page.getByRole("button", { name: "Plan", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Control+n");
  await expect(page.getByRole("dialog", { name: "New session" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "New session" })).toBeHidden();
  await expect(prompt).toBeFocused();
  await command(request, "set_session_mode", { mode: "interactive" });
});

test("selection uploads stay drafts until explicit submit", async ({ page, request }) => {
  await page.goto(`/?session=${sessionId}`);
  await expect(page.locator(".composer textarea")).toBeEnabled();
  const before = await command(request, "session_history_window");
  await page.locator('input[type="file"]').setInputFiles({
    name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("A small selected attachment."),
  });
  await expect(page.locator(".attachment-chip")).toContainText("note.txt");
  const after = await command(request, "session_history_window");
  expect(after.events.filter((event: { type: string }) => event.type === "user.message").length)
    .toBe(before.events.filter((event: { type: string }) => event.type === "user.message").length);
  await page.getByRole("button", { name: "Remove note.txt" }).click();
  await expect(page.locator(".attachment-chip")).toHaveCount(0);
});

test("a submitted response arrives live without a history refresh", async ({ page }) => {
  await page.goto(`/?session=${sessionId}`);
  const prompt = page.locator(".composer textarea");
  await expect(prompt).toBeEnabled();
  await expect(page.locator(".agent-mode-switcher button.active")).toHaveText("Interactive");
  let historyReads = 0;
  page.on("request", (request) => { if (request.url().endsWith("/api/session_history_window")) historyReads++; });
  await prompt.fill("Do not use any tools. Reply exactly PARITY_LIVE_OK.");
  await prompt.press("Enter");
  await expect(page.locator(".message.user").last()).toContainText("PARITY_LIVE_OK");
  await expect(page.locator(".message.assistant").last()).toContainText("PARITY_LIVE_OK", { timeout: 60_000 });
  await expect(page.locator(".composer-status strong")).toHaveText("Session attached · idle", { timeout: 30_000 });
  expect(historyReads).toBe(0);
  await expect(page.locator(".timing-detail")).toContainText("First output");
});

test("native user-input requests can be answered in the client", async ({ page, request }) => {
  await page.goto(`/?session=${sessionId}`);
  const prompt = page.locator(".composer textarea");
  await expect(prompt).toBeEnabled();
  await prompt.fill("Use your user-input tool to ask me to choose red or blue. Do not choose for me. After receiving my answer, reply exactly CHOICE_OK. Do not use any other tools.");
  await prompt.press("Enter");
  const panel = page.locator(".interaction-panel");
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".composer-status strong")).toContainText("needs your input");
  const pending = await command(request, "pending_interactions");
  expect(pending.length).toBeGreaterThan(0);
  await prompt.fill("This queued message will be removed.");
  await prompt.press("Control+q");
  const queuedRow = page.locator(".message-queue-item").filter({ hasText: "This queued message will be removed." });
  await expect(queuedRow).toBeVisible();
  await queuedRow.getByTitle("Edit queued message").click();
  await page.getByRole("textbox", { name: "Edit queued message" }).fill("Edited queue draft.");
  await page.getByRole("textbox", { name: "Edit queued message" }).press("Enter");
  const editedRow = page.locator(".message-queue-item").filter({ hasText: "Edited queue draft." });
  await expect(editedRow).toBeVisible();
  await expect.poll(async () => (await command(request, "queue_items")).items.map((item: { displayText: string }) => item.displayText))
    .toContain("Edited queue draft.");
  await editedRow.getByTitle("Remove queued prompt").click();
  await expect(editedRow).toBeHidden();
  const select = panel.locator("select").first();
  if (await select.count()) {
    const values = await select.locator("option").evaluateAll((options) =>
      options.map((option) => ({ value: (option as HTMLOptionElement).value, label: option.textContent ?? "" })),
    );
    const choice = values.find((option) => /blue/i.test(option.label)) ?? values.find((option) => option.value);
    expect(choice).toBeTruthy();
    await select.selectOption(choice!.value);
  } else {
    await panel.locator("textarea,input[type=text]").first().fill("blue");
  }
  await panel.getByRole("button", { name: /^Submit( answer)?$/ }).click();
  await expect(panel).toBeHidden();
  await expect(page.locator(".message.assistant").last()).toContainText("CHOICE_OK", { timeout: 60_000 });
  expect(await command(request, "pending_interactions")).toHaveLength(0);
});
