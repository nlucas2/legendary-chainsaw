import { test, expect, type Page, type Route } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

let bundle: string;

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import React, { StrictMode } from "react";
        import { createRoot } from "react-dom/client";
        import { AskPanel } from "./AskPanel";
        import { ingestAskEvent } from "../lib/ask";
        const root = createRoot(document.getElementById("root"));
        window.openAsk = (props) => root.render(React.createElement(StrictMode, null,
          React.createElement(AskPanel, {...props, onClose: () => root.render(null)})));
        window.ingestAskEvent = ingestAskEvent;
      `,
      resolveDir: path.resolve("src", "components"),
      loader: "tsx",
    },
    bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{
      name: "inline-css",
      setup(builder) {
        builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
      },
    }],
  });
  bundle = result.outputFiles[0].text;
});

async function mount(page: Page, props: Record<string, unknown> = {}) {
  // All requests are intercepted. This fixture never calls a real daemon or model.
  await page.route("**/api/**", (route) => route.fulfill({ status: 500, body: "Unexpected API request" }));
  await page.route("**/__ask-panel-fixture__", (route) => route.fulfill({
    contentType: "text/html", body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main id="root"></main></body></html>',
  }));
  await page.goto("/__ask-panel-fixture__");
  await page.addScriptTag({ content: bundle });
  await open(page, { sessionId: "parent-a", ...props });
}

async function open(page: Page, props: Record<string, unknown>) {
  await page.evaluate((values) => {
    (window as unknown as { openAsk: (props: Record<string, unknown>) => void }).openAsk(values);
  }, props);
}

test("prefill waits for explicit submit, stays transient, and ignores other native query output", async ({ page }) => {
  await mount(page, { initialQuestion: "Review these changes" });
  const calls: Record<string, unknown>[] = [];
  let pending: Route | undefined;
  await page.route("**/api/ask_session", (route) => {
    calls.push(route.request().postDataJSON());
    pending = route;
  });
  await expect(page.getByLabel("Question", { exact: true })).toHaveValue("Review these changes");
  await page.waitForTimeout(100);
  expect(calls).toEqual([]);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]).toEqual({ sessionId: "parent-a", question: "Review these changes" });
  await expect(page.getByText("Cancel unavailable")).toBeDisabled();
  await page.evaluate(() => {
    (window as unknown as { ingestAskEvent: (event: unknown) => void }).ingestAskEvent({
      type: "session_event", sessionId: "parent-a",
      event: { type: "ui.ephemeral_query", data: { requestId: "other-client", phase: "completed", answer: "STOLEN ANSWER" } },
    });
  });
  await expect(page.getByText("STOLEN ANSWER")).toHaveCount(0);
  await pending!.fulfill({ json: { sessionId: "parent-a", answer: "The **correct** answer" } });
  await expect(page.getByRole("article", { name: "Transient answer" })).toContainText("The correct answer");
  await expect(page.locator("strong")).toHaveText("correct");
  await expect(page.getByText("No tools run and nothing is added", { exact: false })).toBeVisible();
  await page.getByLabel("Question", { exact: true }).fill("New unsent question");
  await expect(page.getByRole("article", { name: "Transient answer" })).toContainText("Review these changes");
  await expect(page.getByRole("article", { name: "Transient answer" })).not.toContainText("New unsent question");
});

test("explicit slash submit runs exactly once under StrictMode and close never aborts parent", async ({ page }) => {
  await mount(page);
  const requests: string[] = [];
  let pending: Route | undefined;
  await page.route("**/api/**", (route) => {
    requests.push(new URL(route.request().url()).pathname);
    if (route.request().url().endsWith("/ask_session")) pending = route;
    else void route.fulfill({ status: 500, body: "Forbidden fixture action" });
  });
  await open(page, { sessionId: "explicit-slash", initialQuestion: "Why?", submitOnOpen: true });
  await expect.poll(() => !!pending).toBe(true);
  expect(requests).toEqual(["/api/ask_session"]);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("region", { name: "Ask about this conversation" })).toHaveCount(0);
  await pending!.fulfill({ json: { sessionId: "explicit-slash", answer: "Finishes after closing" } });
  await page.waitForTimeout(100);
  expect(requests).toEqual(["/api/ask_session"]);
  await expect(page.getByText("Finishes after closing")).toHaveCount(0);
});

test("switching sessions does not expose a late answer; malformed responses remain errors", async ({ page }) => {
  await mount(page);
  const pending = new Map<string, Route>();
  await page.route("**/api/ask_session", (route) => {
    pending.set(route.request().postDataJSON().sessionId, route);
  });

  await page.getByLabel("Question", { exact: true }).fill("A question");
  await page.getByLabel("Question", { exact: true }).press("Enter");
  await expect.poll(() => pending.has("parent-a")).toBe(true);
  await open(page, { sessionId: "parent-b", initialQuestion: "B question" });
  await pending.get("parent-a")!.fulfill({ json: { sessionId: "parent-a", answer: "A ANSWER" } });
  await expect(page.getByText("A ANSWER")).toHaveCount(0);
  await page.getByLabel("Question", { exact: true }).press("Shift+Enter");
  expect(pending.size).toBe(1);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect.poll(() => pending.has("parent-b")).toBe(true);
  await pending.get("parent-b")!.fulfill({ json: { sessionId: "parent-a", answer: "WRONG PARENT" } });
  await expect(page.getByRole("alert")).toContainText("mismatched");
  await expect(page.getByText("WRONG PARENT")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ask", exact: true })).toBeEnabled();
});

test.describe("mobile questions", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test("Enter keeps a multiline question unsent until Ask is tapped", async ({ page }) => {
    await mount(page);
    const calls: Record<string, unknown>[] = [];
    await page.route("**/api/ask_session", (route) => {
      calls.push(route.request().postDataJSON());
      return route.fulfill({ json: { sessionId: "parent-a", answer: "Fixture answer" } });
    });
    const input = page.getByLabel("Question", { exact: true });
    await input.fill("First question");
    await input.press("Enter");
    await input.pressSequentially("With more context");
    await expect(input).toHaveValue("First question\nWith more context");
    expect(calls).toHaveLength(0);
    await page.getByRole("button", { name: "Ask", exact: true }).tap();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0].question).toBe("First question\nWith more context");
  });
});
