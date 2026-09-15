import { test, expect, type APIRequestContext } from "@playwright/test";

test("an actual background subagent opens under its parent and accepts a direct follow-up", async ({ page, request }) => {
  test.setTimeout(150_000);
  let sessionId: string | undefined;
  async function command(api: APIRequestContext, name: string, args: Record<string, unknown> = {}) {
    const response = await api.post(`/api/${name}`, { data: { sessionId, ...args }, timeout: 60_000 });
    expect(response.ok(), `${name}: ${await response.text()}`).toBeTruthy();
    return response.json();
  }
  try {
    const created = await command(request, "create_session", {
      cwd: process.cwd(), model: "gpt-5.6-luna", reasoningEffort: "low", reasoningSummary: "detailed",
    });
    sessionId = created.sessionId;
    await command(request, "send_message", {
      content: 'Start exactly one background general-purpose subagent named SidebarProbe. Its instructions: "Do not use tools or modify anything. Reply exactly SIDEBAR_READY, then be available for follow-up messages." Use background mode. Do not wait for it or call read_agent. Once launched, reply exactly PARENT_READY.',
      deliveryMode: "enqueue",
    });
    let child: { id: string; name: string; status: string } | undefined;
    await expect.poll(async () => {
      const result = await command(request, "agent_tasks");
      child = result.tasks.find((task: { name: string }) => task.name.includes("SidebarProbe"));
      return !!child;
    }, { timeout: 60_000 }).toBe(true);
    await page.goto(`/?session=${sessionId}`);
    await expect(page.locator(".parent-session-view .composer textarea")).toBeEnabled();
    const row = page.locator(".session-node").filter({ has: page.locator(`[data-session-id="${sessionId}"]`) });
    await row.locator(".session-expander").click();
    await expect(row.locator(`[data-task-id="${child!.id}"]`)).toBeVisible();
    await row.locator(`[data-task-id="${child!.id}"]`).click();
    const conversation = page.locator(".agent-conversation");
    await expect(conversation.locator(".message.assistant")).toContainText("SIDEBAR_READY", { timeout: 60_000 });
    const prompt = conversation.getByRole("textbox");
    await expect(prompt).toBeEnabled();
    let parentSends = 0;
    page.on("request", (request) => { if (request.url().endsWith("/api/send_message")) parentSends++; });
    await prompt.fill("Do not use tools. Reply exactly SIDEBAR_FOLLOWUP.");
    await prompt.press("Enter");
    await expect(conversation.locator(".message.assistant").last()).toContainText("SIDEBAR_FOLLOWUP", { timeout: 60_000 });
    expect(parentSends).toBe(0);
    const history = await command(request, "agent_history", { taskId: child!.id });
    expect(history.events.every((event: { agentId: string }) => event.agentId === history.agentId)).toBe(true);
    expect(history.events.some((event: { type: string; data: { content?: string } }) =>
      event.type === "assistant.message" && event.data.content?.includes("SIDEBAR_FOLLOWUP"))).toBe(true);
    await page.getByRole("button", { name: "Back to parent" }).click();
    await expect(page.locator(".parent-session-view")).toBeVisible();
  } catch (error) {
    if (sessionId) {
      const tasks = await command(request, "agent_tasks");
      const context = await command(request, "subagent_context");
      console.info(JSON.stringify({ tasks, lifecycle: context }, null, 2));
    }
    throw error;
  } finally {
    if (sessionId) {
      await command(request, "abort_session");
      await command(request, "delete_session");
    }
  }
});
