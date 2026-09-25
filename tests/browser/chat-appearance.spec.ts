import { test, expect, type Page, type Route } from "@playwright/test";

const longUrl = "https://example.com/" + "long-path-segment".repeat(30);
const markdown = `Reviewed changes.

| Location | Finding |
| :--- | ---: |
| [\`run-windows.ps1:273-281\`](https://example.com/code) | Generated configuration omits an important field. |
| [logging.rs:562-564](https://example.com/logging) | Preserve the hostname and node ID. |

[${longUrl}](${longUrl})

| One | Two | Three | Four | Five | Six | Seven | Eight |
| --- | --- | --- | --- | --- | --- | --- | --- |
| a | b | c | d | e | f | g | h |
`;
const reasoningMarkdown = "Compare the alternatives.\n\n[Source](https://example.com/source) and `inline code`.\n\n```text\ncode sample\n```\n\n| Step | Result |\n| --- | --- |\n| Review | Ready |";

async function setup(page: Page) {
  const session = { sessionId: "appearance", title: "Appearance preview", cwd: "Q:\\example", model: "model",
    isActive: true, isRemote: false, pinned: false, tags: [], startTime: "", modifiedTime: "" };
  await page.addInitScript(() => {
    class FixtureEventSource extends EventTarget {
      onopen: (() => void) | null = null;
      constructor() { super(); setTimeout(() => this.onopen?.(), 0); }
      close() {}
    }
    Object.defineProperty(window, "EventSource", { value: FixtureEventSource });
  });
  await page.route("**/api/**", (route) => {
    const command = new URL(route.request().url()).pathname.split("/").at(-1);
    let result: unknown;
    switch (command) {
      case "list_sessions": result = [session]; break;
      case "resume_session": result = session; break;
      case "runtime_status": result = { connected: true, acceptingWork: true, activeSessions: 1 }; break;
      case "session_state": result = { sessionId: session.sessionId, processing: false, mode: "interactive" }; break;
      case "session_processing": result = false; break;
      case "agent_tasks": result = { sessionId: session.sessionId, tasks: [] }; break;
      case "pending_interactions": case "pending_permissions": case "subagent_context": result = []; break;
      case "queue_items": result = { items: [], steeringMessages: [] }; break;
      case "git_repository": result = { isRepository: false }; break;
      case "session_history_window": result = {
        events: [
          { id: "u", type: "user.message", timestamp: "", data: { content: "Review these changes.\n\nKeep my formatting." } },
          { id: "r", type: "assistant.reasoning", timestamp: "", data: { content: reasoningMarkdown } },
          { id: "a", type: "assistant.message", timestamp: "", data: { content: markdown } },
        ], hasMore: false, cursor: "", loadedPages: 1, humanMessages: 1,
      }; break;
      default: return route.fulfill({ status: 404, body: `Unexpected ${command}` });
    }
    return route.fulfill({ json: result });
  });
  await page.goto("/?session=appearance");
  await expect(page.locator(".message.assistant")).toBeVisible();
}

test.describe("compact chat header on phones", () => {
  test.use({ isMobile: true, hasTouch: true, colorScheme: "dark" });
  for (const width of [320, 440]) {
    test(`a ${width}px phone keeps title and menu in one row and gives the reclaimed height to chat`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 760 });
      await setup(page);
      const composer = page.locator(".parent-session-view .composer textarea");
      await composer.fill("Keep this draft while changing the header");
      const header = page.locator(".workspace-header");
      const before = (await header.boundingBox())!.height;
      const conversation = page.locator(".parent-session-view .conversation");
      const beforeChat = (await conversation.boundingBox())!.height;
      await header.getByRole("button", { name: "Collapse chat header", exact: true }).tap();
      await expect(header).toHaveAttribute("data-collapsed", "true");
      const compact = (await header.boundingBox())!;
      expect(compact.height).toBeLessThanOrEqual(52);
      expect(compact.height).toBeLessThan(before);
      const menu = (await header.getByRole("button", { name: "Open sessions", exact: true }).boundingBox())!;
      const title = (await header.getByRole("heading", { name: "Appearance preview", exact: true }).boundingBox())!;
      expect(Math.abs(menu.y + menu.height / 2 - title.y - title.height / 2)).toBeLessThan(3);
      expect(menu.height).toBeGreaterThanOrEqual(44);
      expect(title.x).toBeGreaterThanOrEqual(menu.x + menu.width);
      expect((await conversation.boundingBox())!.height).toBeGreaterThan(beforeChat + 40);
      await expect(page.locator("#workspace-tools")).toBeHidden();
      await expect(page.locator("#session-metadata")).toBeHidden();
      await expect(page.locator("#workspace-history")).toBeHidden();
      await expect(header.locator(".compact-session-activity")).toBeVisible();
      expect(await header.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await expect(composer).toHaveValue("Keep this draft while changing the header");
      await page.screenshot({ path: testInfo.outputPath(`compact-header-${width}.png`) });
      await page.reload();
      await expect(page.locator(".message.assistant")).toBeVisible();
      await expect(header).toHaveAttribute("data-collapsed", "true");
      await header.getByRole("button", { name: "Open sessions", exact: true }).tap();
      await expect(page.locator(".sidebar")).toHaveClass("sidebar open");
      await page.locator(".sidebar").getByRole("button", { name: "Close sessions", exact: true }).tap();
      await header.getByRole("button", { name: "Expand chat header", exact: true }).tap();
      await expect(page.locator("#workspace-tools")).toBeVisible();
      await expect(page.locator("#session-metadata")).toBeVisible();
      await expect(page.locator("#workspace-history")).toBeVisible();
      await expect(header.getByRole("button", { name: "Ask about conversation", exact: true })).toBeHidden();
      await header.getByRole("button", { name: "Additional options", exact: true }).tap();
      await expect(page.getByRole("dialog", { name: "Additional options" })
        .getByRole("button", { name: "Ask about conversation", exact: true })).toBeVisible();
    });
  }
});

test("desktop compact header is keyboard accessible and syncs without hiding active catch-up or errors", async ({ page }) => {
  await setup(page);
  const toggle = page.getByRole("button", { name: "Collapse chat header", exact: true });
  await toggle.focus();
  await toggle.press("Enter");
  const expand = page.getByRole("button", { name: "Expand chat header", exact: true });
  await expect(expand).toBeFocused();
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#workspace-tools")).toBeHidden();
  await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", {
    key: "copilot-sessions.chat-header", newValue: "expanded", storageArea: localStorage,
  })));
  await expect(page.locator("#workspace-tools")).toBeVisible();
  let refresh: Route | undefined;
  await page.route("**/api/refresh_session", (route) => { refresh = route; });
  await page.getByTitle("Merge recent history without restarting Copilot or other sessions", { exact: true }).click();
  await expect.poll(() => !!refresh).toBe(true);
  await toggle.click();
  await expect(page.locator("#workspace-history")).toBeVisible();
  await expect(page.locator("#workspace-history")).toContainText("Catching up");
  await refresh!.fulfill({ status: 503, body: "Refresh unavailable" });
  await expect(page.locator(".parent-session-view .error-banner")).toContainText("Refresh unavailable");
  await expect(page.locator(".workspace-header")).toHaveAttribute("data-collapsed", "true");
});

test("header persistence failures stay visible while compact mode still works locally", async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === "copilot-sessions.chat-header") throw new Error("Header storage blocked");
      return original.call(this, key, value);
    };
  });
  await setup(page);
  await page.getByRole("button", { name: "Collapse chat header", exact: true }).click();
  await expect(page.locator(".workspace-header")).toHaveAttribute("data-collapsed", "true");
  await expect(page.locator(".workspace > [role='alert']")).toContainText("Header storage blocked");
  expect(await page.evaluate(() => localStorage.getItem("copilot-sessions.chat-header"))).toBeNull();
});

test("font controls collapse by default, remain keyboard accessible, and preserve settings", async ({ page }) => {
  await setup(page);
  await page.locator(".daemon-state").click();
  const disclosure = page.locator(".typography-disclosure");
  await expect(disclosure).not.toHaveAttribute("open");
  await expect(page.getByRole("button", { name: /CLI-like/ })).toBeHidden();
  await expect(page.getByRole("button", { name: /Runtime maintenance/ })).toBeInViewport();
  await disclosure.locator("summary").focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: /CLI-like/ }).click();
  await disclosure.locator("summary").click();
  await expect(page.getByRole("slider", { name: "Chat font size", exact: true })).toBeHidden();
  await disclosure.locator("summary").focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: /CLI-like/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.locator(".daemon-state").click();
  await expect(page.locator(".typography-disclosure")).not.toHaveAttribute("open");
});

test("full chat width uses the desktop pane, persists, and leaves mobile width unchanged", async ({ page }) => {
  await page.routeWebSocket((url) => url.pathname === "/api/terminal", (socket) => {
    socket.send(JSON.stringify({ type: "ready", shell: "Test shell", cwd: "Q:\\example", restored: false, hasControl: true, viewers: 1 }));
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await setup(page);
  const transcript = page.locator(".parent-session-view .transcript");
  const composer = page.locator(".parent-session-view .composer");
  const original = (await transcript.boundingBox())!.width;
  expect(original).toBeLessThanOrEqual(920);
  await page.locator(".daemon-state").click();
  await page.getByRole("checkbox", { name: /Use full chat width on desktop/ }).check();
  await page.getByRole("button", { name: "Close settings" }).click();
  const workspace = (await page.locator(".workspace").boundingBox())!;
  expect((await transcript.boundingBox())!.width).toBeGreaterThan(original + 200);
  expect((await composer.boundingBox())!.width).toBeCloseTo(workspace.width - 44, 0);
  await page.reload();
  await expect(page.locator(".app-shell")).toHaveAttribute("data-chat-width", "full");
  await expect(composer).toBeVisible();
  await page.getByTitle("Open terminal").click();
  await page.getByRole("button", { name: "Terminal beside chat", exact: true }).click();
  const splitWidth = (await page.locator(".workspace").boundingBox())!.width;
  expect((await composer.boundingBox())!.width).toBeCloseTo(splitWidth - 44, 0);
  expect((await transcript.boundingBox())!.width).toBeLessThan(splitWidth);
  await page.getByTitle("Hide terminal").click();
  await page.setViewportSize({ width: 440, height: 900 });
  const mobileFull = (await transcript.boundingBox())!.width;
  // Exercise the storage-event path as another client window would.
  await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", {
    key: "copilot-sessions.chat-width", newValue: "readable", storageArea: localStorage,
  })));
  await expect(page.locator(".app-shell")).toHaveAttribute("data-chat-width", "readable");
  expect((await transcript.boundingBox())!.width).toBeCloseTo(mobileFull, 0);
  expect(mobileFull).toBeLessThan(440);
});

test("chat width storage failures are visible without changing typography", async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === "copilot-sessions.chat-width") throw new Error("Storage blocked");
      return original.call(this, key, value);
    };
  });
  await setup(page);
  await page.locator(".daemon-state").click();
  await page.getByRole("checkbox", { name: /Use full chat width on desktop/ }).check();
  await expect(page.locator(".settings-panel [role=alert]")).toContainText("Storage blocked");
  await expect(page.locator(".app-shell")).toHaveAttribute("data-chat-width", "full");
  expect(await page.evaluate(() => localStorage.getItem("copilot-sessions.typography"))).toBeNull();
});

test("Markdown tables have padded borders, themed links and bounded overflow in light and dark", async ({ page }) => {
  await setup(page);
  for (const theme of ["Dark", "Light"]) {
    await page.locator(".daemon-state").click();
    await page.getByRole("button", { name: new RegExp(`^${theme} `) }).click();
    await page.getByRole("button", { name: "Close settings" }).click();
    const styles = await page.locator(".message.assistant .markdown-body").evaluate((body) => {
      const header = body.querySelector("th")!;
      const cell = body.querySelector("td")!;
      const link = body.querySelector("a")!;
      const code = link.querySelector("code")!;
      const rgb = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number);
      const luminance = (value: string) => rgb(value).map((channel) => {
        const c = channel / 255;
        return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
      }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
      const color = getComputedStyle(link).color;
      const background = getComputedStyle(cell).backgroundColor;
      const a = luminance(color), b = luminance(background);
      return {
        border: getComputedStyle(cell).borderBottomWidth,
        padding: parseFloat(getComputedStyle(cell).paddingLeft),
        headerBackground: getComputedStyle(header).backgroundColor, background,
        color, codeColor: getComputedStyle(code).color,
        contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05),
        underline: getComputedStyle(link).textDecorationLine,
        longLinkFits: body.scrollWidth <= body.clientWidth + 1,
      };
    });
    expect(styles.border).toBe("1px");
    expect(styles.padding).toBeGreaterThanOrEqual(10);
    expect(styles.headerBackground).not.toBe(styles.background);
    expect(styles.color).not.toBe("rgb(0, 0, 238)");
    expect(styles.codeColor).toBe(styles.color);
    expect(styles.contrast).toBeGreaterThanOrEqual(4.5);
    expect(styles.underline).toContain("underline");
    expect(styles.longLinkFits).toBe(true);
    await expect(page.locator(".reasoning-content a")).toHaveCSS("color", styles.color);
  }
  await page.setViewportSize({ width: 440, height: 900 });
  const table = page.locator(".message.assistant .markdown-table-scroll").last();
  expect(await table.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await table.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => table.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  expect(await page.locator(".conversation").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});

test("Ask answers and plan previews share the same Markdown table and link styling", async ({ page }) => {
  await setup(page);
  await page.route("**/api/ask_session", (route) => route.fulfill({ json: { sessionId: "appearance", answer: markdown } }));
  await page.getByRole("button", { name: "Ask about conversation", exact: true }).click();
  const ask = page.getByRole("dialog", { name: "Ask about conversation" });
  await ask.getByLabel("Question", { exact: true }).fill("Show the table");
  await ask.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(ask.locator(".markdown-table-scroll").first()).toBeVisible();
  await expect(ask.locator("td").first()).toHaveCSS("border-bottom-width", "1px");
  const color = await ask.locator("a").first().evaluate((element) => getComputedStyle(element).color);
  await ask.getByRole("button", { name: "Close", exact: true }).click();
  await page.route("**/api/pending_interactions", (route) => route.fulfill({ json: [{
    sessionId: "appearance", requestId: "plan", kind: "exit_plan_mode",
    data: { actions: ["interactive"], summary: "Plan review", planContent: markdown },
  }] }));
  await page.reload();
  await expect(page.locator(".plan-preview .markdown-table-scroll").first()).toBeVisible();
  await expect(page.locator(".plan-preview td").first()).toHaveCSS("border-bottom-width", "1px");
  await expect(page.locator(".plan-preview a").first()).toHaveCSS("color", color);
});

test("independent reasoning styling persists without changing chat, composer or terminal", async ({ page }) => {
  let terminalConnections = 0;
  await page.routeWebSocket((url) => url.pathname === "/api/terminal", (socket) => {
    terminalConnections++;
    socket.send(JSON.stringify({ type: "ready", shell: "Test shell", cwd: "Q:\\example", restored: false, hasControl: true, viewers: 1 }));
  });
  await setup(page);
  await page.getByTitle("Open terminal").click();
  await expect(page.locator(".xterm-screen")).toBeVisible();
  await expect(page.locator(".terminal-title strong")).toHaveText("Test shell");
  const reasoning = page.locator(".transcript .reasoning-content");
  const unaffectedStyles = () => page.evaluate(() => {
    const text = [".message.assistant .message-content", ".composer textarea"].map((selector) => {
      const style = getComputedStyle(document.querySelector(selector)!);
      return { family: style.fontFamily, size: style.fontSize, lineHeight: style.lineHeight, italic: style.fontStyle };
    });
    const terminal = document.querySelector(".xterm-screen")!.getBoundingClientRect();
    return { text, terminal: { width: terminal.width, height: terminal.height } };
  });
  const before = await unaffectedStyles();
  await page.locator(".daemon-state").click();
  await page.locator(".typography-disclosure summary").click();
  await expect(page.getByRole("combobox", { name: "Reasoning styling", exact: true })).toHaveValue("shared");
  await expect(page.getByRole("combobox", { name: "Reasoning font", exact: true })).toBeHidden();
  await page.getByRole("combobox", { name: "Reasoning styling", exact: true }).selectOption("custom");
  await expect(page.locator(".typography-reasoning-preview")).toHaveCSS("color",
    await reasoning.evaluate((element) => getComputedStyle(element).color));
  await page.getByRole("combobox", { name: "Reasoning font", exact: true }).selectOption("custom");
  await page.getByLabel("Custom reasoning font families").fill("Georgia");
  await page.getByLabel("Custom reasoning font families").press("Enter");
  for (const name of ["Reasoning font size", "Reasoning line spacing", "Reasoning paragraph spacing"]) {
    await page.getByRole("slider", { name, exact: true }).press("End");
  }
  await page.getByLabel("Italic reasoning").check();
  await page.getByRole("combobox", { name: "Reasoning tone", exact: true }).selectOption("normal");
  await expect(reasoning).toHaveCSS("font-size", "24px");
  await expect(reasoning).toHaveCSS("line-height", "52.8px");
  await expect(reasoning).toHaveCSS("font-style", "italic");
  await expect(reasoning).toHaveCSS("font-family", /Georgia/);
  await expect(reasoning.locator("p").first()).toHaveCSS("margin-bottom", "24px");
  await expect(reasoning.locator("code").first()).toHaveCSS("font-family", /monospace/);
  await expect(reasoning.locator("code").first()).toHaveCSS("font-style", "normal");
  expect(await unaffectedStyles()).toEqual(before);
  expect(terminalConnections).toBe(1);
  await expect(page.locator("html")).not.toHaveAttribute("data-typography");
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByTitle("Hide terminal").click();
  await page.reload();
  await expect(reasoning).toHaveCSS("font-size", "24px");
  await expect(reasoning).toHaveCSS("font-family", /Georgia/);
  await page.locator(".daemon-state").click();
  await expect(page.locator(".typography-disclosure")).not.toHaveAttribute("open");
  await page.locator(".typography-disclosure summary").click();
  await page.getByRole("button", { name: /CLI-like/ }).click();
  await expect(reasoning).toHaveCSS("font-family", /Georgia/);
  await expect(reasoning).toHaveCSS("font-size", "24px");
  await expect(page.locator(".message.assistant .message-content")).toHaveCSS("font-size", "14px");
  await page.getByRole("combobox", { name: "Reasoning styling", exact: true }).selectOption("shared");
  await expect(reasoning).toHaveCSS("font-size", "14px");
  await expect(reasoning).toHaveCSS("font-style", "normal");
  await page.getByRole("combobox", { name: "Reasoning styling", exact: true }).selectOption("custom");
  await expect(reasoning).toHaveCSS("font-size", "24px");
  await page.getByRole("button", { name: "Reset font & spacing", exact: true }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-reasoning-typography");
  expect(await page.evaluate(() => localStorage.getItem("copilot-sessions.typography"))).toBeNull();
});

test("reasoning tone and preview follow themes without overriding Markdown link and table colors", async ({ page }) => {
  await setup(page);
  const reasoning = page.locator(".transcript .reasoning-content");
  await page.locator(".daemon-state").click();
  await page.locator(".typography-disclosure summary").click();
  await page.getByRole("combobox", { name: "Reasoning styling", exact: true }).selectOption("custom");
  for (const theme of ["Dark", "Light"]) {
    await page.getByRole("button", { name: new RegExp(`^${theme} `) }).click();
    const tableColor = await reasoning.locator("td").first().evaluate((element) => getComputedStyle(element).backgroundColor);
    const linkColor = await page.locator(".message.assistant a").first().evaluate((element) => getComputedStyle(element).color);
    for (const tone of ["muted", "normal", "original"]) {
      await page.getByRole("combobox", { name: "Reasoning tone", exact: true }).selectOption(tone);
      const color = await reasoning.evaluate((element) => getComputedStyle(element).color);
      await expect(page.locator(".typography-reasoning-preview")).toHaveCSS("color", color);
      await expect(reasoning.locator("a")).toHaveCSS("color", linkColor);
      await expect(reasoning.locator("td").first()).toHaveCSS("background-color", tableColor);
      if (tone !== "original") {
        const expected = await page.evaluate((tone) => {
          const sample = document.createElement("span");
          sample.style.color = `var(--${tone === "normal" ? "text" : "muted"})`;
          document.body.append(sample);
          const color = getComputedStyle(sample).color;
          sample.remove();
          return color;
        }, tone);
        expect(color).toBe(expected);
      }
    }
  }
});
