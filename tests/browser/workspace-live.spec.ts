import { test, expect } from "@playwright/test";

test("native ask leaves history untouched, rename persists, and fork copies context independently", async ({ page, request }) => {
  test.setTimeout(180_000);
  const owned: string[] = [];
  async function command(name: string, args: Record<string, unknown> = {}) {
    const response = await request.post(`/api/${name}`, { data: args, timeout: 60_000 });
    expect(response.ok(), `${name}: ${await response.text()}`).toBeTruthy();
    return response.json();
  }
  try {
    const source = await command("create_session", { cwd: process.cwd(), model: "gpt-5.6-luna", reasoningEffort: "low" });
    const sessionId = source.sessionId;
    owned.push(sessionId);
    await command("send_message", { sessionId, content: "Remember WORKSPACE_MEMORY_42 as our secret test word. Do not use tools. Reply exactly READY.", deliveryMode: "enqueue" });
    await expect.poll(async () => (await command("session_state", { sessionId })).processing, { timeout: 60_000 }).toBe(false);
    const before = await command("session_history_window", { sessionId });
    const messageIds = (history: { events: { id: string; type: string }[] }) =>
      history.events.filter((event) => ["user.message", "assistant.message"].includes(event.type)).map((event) => event.id);
    await page.goto(`/?session=${sessionId}`);
    const composer = page.locator(".parent-session-view .composer textarea");
    await expect(composer).toBeEnabled();
    await composer.fill("/ask What is our secret test word? Reply only with that word.");
    await composer.press("Enter");
    const ask = page.getByRole("dialog", { name: "Ask about conversation", exact: true });
    await expect(ask.getByRole("article", { name: "Transient answer" })).toContainText("WORKSPACE_MEMORY_42", { timeout: 60_000 });
    expect(messageIds(await command("session_history_window", { sessionId }))).toEqual(messageIds(before));
    await ask.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Rename session", exact: true }).click();
    const rename = page.getByRole("dialog", { name: "Rename session", exact: true });
    await rename.getByLabel("Session name").fill("Workspace actions validation");
    await rename.getByRole("button", { name: "Save name" }).click();
    await expect(page.getByRole("heading", { name: "Workspace actions validation", exact: true })).toBeVisible();
    expect((await command("list_sessions")).find((session: { sessionId: string }) => session.sessionId === sessionId).title)
      .toBe("Workspace actions validation");
    const fork = await command("fork_session", { sessionId, name: "Independent workspace fork" });
    owned.push(fork.sessionId);
    expect(fork.sessionId).not.toBe(sessionId);
    const forkHistory = await command("session_history_window", { sessionId: fork.sessionId });
    expect(forkHistory.events.some((event: { type: string; data: { content?: string } }) =>
      event.type === "user.message" && event.data.content?.includes("WORKSPACE_MEMORY_42"))).toBe(true);
    expect((await command("session_state", { sessionId: fork.sessionId })).processing).toBe(false);
    expect(messageIds(await command("session_history_window", { sessionId }))).toEqual(messageIds(before));
  } finally {
    for (const sessionId of owned.reverse()) {
      await command("abort_session", { sessionId });
      await command("delete_session", { sessionId });
    }
  }
});
