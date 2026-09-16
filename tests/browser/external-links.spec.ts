import { test, expect, type Page } from "@playwright/test";
import { build } from "vite";

let script = "";
let styles = "";
test.beforeAll(async () => {
  const entry = "virtual:external-links-test";
  const result = await build({
    configFile: false, logLevel: "silent",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [{
      name: "external-links-test",
      resolveId: (id) => id === entry ? `\0${entry}` : undefined,
      load: (id) => id === `\0${entry}` ? `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { MarkdownContent } from "/src/components/MarkdownContent.tsx";
        import { InteractionPanel } from "/src/components/InteractionPanel.tsx";
        import { ExternalLink } from "/src/components/ExternalLink.tsx";
        const markdown = "[Reference](https://example.invalid/reference) and [Jump](#spot).\\n\\n| Location | Note |\\n| --- | --- |\\n| [code](https://example.invalid/code) | Detail |";
        createRoot(document.getElementById("root")).render(
          React.createElement(React.StrictMode, null,
            React.createElement("textarea", { "aria-label": "Existing draft", defaultValue: "Keep my work" }),
            React.createElement(MarkdownContent, null, markdown),
            React.createElement("div", { className: "reasoning-content" }, React.createElement(MarkdownContent, null, "[Reasoning source](https://example.invalid/reasoning)")),
            React.createElement(ExternalLink, { href: "file:///C:/private.txt" }, "Local file"),
            React.createElement(ExternalLink, { href: "javascript:alert(1)" }, "Unsafe link"),
            React.createElement(ExternalLink, { href: "relative/file.rs" }, "Repository file"),
            React.createElement(InteractionPanel, {
              interaction: { sessionId:"s", requestId:"url", kind:"elicitation", data:{ mode:"url", url:"https://example.invalid/auth", message:"Authenticate separately" } },
              onRespond: async () => { window.responded = true; }
            }),
            React.createElement("h2", { id:"spot" }, "Local anchor")
          )
        );
      ` : undefined,
    }],
    build: { write: false, minify: false, rollupOptions: { input: entry } },
  });
  for (const output of Array.isArray(result) ? result : [result]) {
    if (!("output" in output)) continue;
    for (const chunk of output.output) {
      if (chunk.type === "chunk") script += chunk.code;
      else if (chunk.fileName.endsWith(".css")) styles += String(chunk.source);
    }
  }
});

async function setup(page: Page, tauri = false) {
  if (tauri) await page.addInitScript(() => {
    const state = { calls: [] as { command: string; args: unknown }[], fail: false };
    Object.defineProperty(window, "openerFixture", { value: state });
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {
      invoke: async (command: string, args: unknown) => {
        state.calls.push({ command, args });
        if (state.fail) throw new Error("Opener denied this request");
      },
    } });
  });
  await page.context().route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "example.invalid") return route.fulfill({ contentType: "text/html", body: "<h1>External fixture</h1>" });
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: script });
    if (url.pathname === "/fixture.css") return route.fulfill({ contentType: "text/css", body: styles });
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body:
      '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>' });
    return route.abort();
  });
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Reference", exact: true })).toBeVisible();
}

test("browser links open a separate tab without replacing the session page", async ({ page, context }) => {
  await setup(page);
  const current = page.url();
  const link = page.getByRole("link", { name: "Reference", exact: true });
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  const opened = context.waitForEvent("page");
  await link.click();
  const external = await opened;
  await expect(external.getByRole("heading")).toHaveText("External fixture");
  expect(external.url()).toBe("https://example.invalid/reference");
  expect(await external.evaluate(() => window.opener === null)).toBe(true);
  expect(page.url()).toBe(current);
  await expect(page.getByRole("textbox", { name: "Existing draft" })).toHaveValue("Keep my work");
  await external.close();
});

test("Tauri activation uses its system opener once for ordinary, modified, middle and keyboard clicks", async ({ page, context }) => {
  await setup(page, true);
  const current = page.url();
  const link = page.getByRole("link", { name: "Reference", exact: true });
  await link.click();
  await link.click({ modifiers: ["Control"] });
  await link.click({ button: "middle" });
  await link.focus();
  await link.press("Enter");
  await page.getByRole("link", { name: "Reasoning source", exact: true }).click();
  await page.getByRole("link", { name: "Open requested page", exact: true }).click();
  const calls = await page.evaluate(() => (window as unknown as { openerFixture: { calls: { command: string; args: { url: string } }[] } }).openerFixture.calls);
  expect(calls.map((call) => call.command)).toEqual(Array(6).fill("plugin:opener|open_url"));
  expect(calls.map((call) => call.args.url)).toEqual([
    ...Array(4).fill("https://example.invalid/reference"), "https://example.invalid/reasoning", "https://example.invalid/auth",
  ]);
  expect(context.pages()).toHaveLength(1);
  expect(page.url()).toBe(current);
  await expect(page.getByRole("textbox", { name: "Existing draft" })).toHaveValue("Keep my work");
  expect(await page.evaluate(() => (window as unknown as { responded?: boolean }).responded)).toBeUndefined();
});

test("opener failures stay visible and never navigate the Tauri page", async ({ page }) => {
  await setup(page, true);
  const current = page.url();
  await page.evaluate(() => { (window as unknown as { openerFixture: { fail: boolean } }).openerFixture.fail = true; });
  await page.getByRole("link", { name: "Reference", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Opener denied this request");
  expect(page.url()).toBe(current);
  await expect(page.getByRole("textbox", { name: "Existing draft" })).toHaveValue("Keep my work");
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("local anchors stay local and unsupported links cannot invoke external applications", async ({ page }) => {
  await setup(page, true);
  for (const name of ["Local file", "Unsafe link", "Repository file"]) {
    const link = page.getByRole("link", { name, exact: true });
    await expect(link).toHaveAttribute("aria-disabled", "true");
    await expect(link).not.toHaveAttribute("href");
  }
  await page.getByRole("link", { name: "Jump", exact: true }).click();
  expect(new URL(page.url()).hash).toBe("#spot");
  await page.getByRole("link", { name: "Jump", exact: true }).click({ modifiers: ["Control"] });
  expect(await page.evaluate(() => (window as unknown as { openerFixture: { calls: unknown[] } }).openerFixture.calls.length)).toBe(0);
  await expect(page.getByRole("textbox", { name: "Existing draft" })).toHaveValue("Keep my work");
});
