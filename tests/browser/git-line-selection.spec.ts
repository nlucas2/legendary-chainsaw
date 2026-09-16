import { expect, test, type Page } from "@playwright/test";
import { build } from "vite";

let script = "";
let styles = "";

test.beforeAll(async () => {
  const entry = "virtual:git-line-selection-test";
  const result = await build({
    configFile: false,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [{
      name: "git-line-selection-test-entry",
      resolveId: (id) => id === entry ? `\0${entry}` : undefined,
      load: (id) => id === `\0${entry}` ? `
        import React, { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { GitDiffLines } from "/src/components/GitDiffLines.tsx";
        const a = [
          { index: 0, kind: "meta", text: "diff --git a/a b/a", oldLine: null, newLine: null },
          { index: 1, kind: "hunk", text: "@@ -1,3 +1,3 @@", oldLine: null, newLine: null },
          { index: 2, kind: "context", text: " shared text", oldLine: 1, newLine: 1 },
          { index: 3, kind: "delete", text: "-old text", oldLine: 2, newLine: null },
          { index: 4, kind: "add", text: "+new text", oldLine: null, newLine: 2 },
          { index: 5, kind: "context", text: " <script>not executable</script> \u202e", oldLine: 3, newLine: 3 },
        ];
        const b = [
          { index: 0, kind: "hunk", text: "@@ -8 +8 @@", oldLine: null, newLine: null },
          { index: 1, kind: "add", text: "+other file", oldLine: null, newLine: 8 },
        ];
        function Harness() {
          const [first, setFirst] = useState(new Set());
          const [second, setSecond] = useState(new Set());
          window.clearFirst = () => setFirst(new Set());
          return React.createElement(React.Fragment, null,
            React.createElement(GitDiffLines, { lines: a, selected: first, onChange: setFirst }),
            React.createElement("output", { "aria-label": "First selected" }, [...first].sort((x,y) => x-y).join(",")),
            React.createElement(GitDiffLines, { lines: b, selected: second, onChange: setSecond }),
            React.createElement("output", { "aria-label": "Second selected" }, [...second].sort((x,y) => x-y).join(",")),
            React.createElement("p", { id: "outside-text" }, "Outside selectable text")
          );
        }
        createRoot(document.getElementById("root")).render(React.createElement(Harness));
      ` : undefined,
    }],
    build: { write: false, minify: false, rollupOptions: { input: entry }, assetsInlineLimit: 0 },
  });
  for (const output of Array.isArray(result) ? result : [result]) {
    if (!("output" in output)) continue;
    for (const chunk of output.output) {
      if (chunk.type === "chunk") script += chunk.code;
      else if (chunk.fileName.endsWith(".css")) styles += String(chunk.source);
    }
  }
});

async function setup(page: Page) {
  await page.route("**/*", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: script });
    if (path === "/fixture.css") return route.fulfill({ contentType: "text/css", body: styles });
    if (path === "/") return route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
    });
    return route.abort();
  });
  await page.goto("/");
  await expect(page.getByRole("listbox", { name: "Diff lines" }).first()).toBeVisible();
}

test("click, range, modifier toggle, reset, metadata, and file locality", async ({ page }) => {
  await setup(page);
  const first = page.getByRole("listbox", { name: "Diff lines" }).first();
  const output = page.getByLabel("First selected");
  await first.getByRole("option", { name: "Added line new:2", exact: true }).click();
  await expect(output).toHaveText("4");
  await first.getByRole("option", { name: "Context line old:3 new:3", exact: true }).click({ modifiers: ["Shift"] });
  await expect(output).toHaveText("4,5");
  await first.getByRole("option", { name: "Deleted line old:2", exact: true }).click({ modifiers: ["Control"] });
  await expect(output).toHaveText("3,4,5");
  await expect(first.getByRole("option")).toHaveCount(4);
  await expect(first.getByText("diff --git a/a b/a")).not.toHaveAttribute("role", "option");
  await expect(page.getByLabel("Second selected")).toHaveText("");
  await first.getByRole("option", { name: "Added line new:2" }).locator("code").selectText();
  expect(await page.evaluate(() => getSelection()?.toString())).toContain("new text");
  await page.evaluate(() => (window as unknown as { clearFirst: () => void }).clearFirst());
  await expect(first.getByRole("option", { name: "Deleted line old:2" })).toHaveAttribute("aria-selected", "false");
  await expect(output).toHaveText("");
  expect(await page.evaluate(() => getSelection()?.toString())).toBe("");

  await first.getByRole("option", { name: "Added line new:2" }).click();
  await page.locator("#outside-text").selectText();
  await page.evaluate(() => (window as unknown as { clearFirst: () => void }).clearFirst());
  expect(await page.evaluate(() => getSelection()?.toString())).toBe("Outside selectable text");
  await expect(first.locator("script")).toHaveCount(0);
  await expect(first).toContainText("<script>not executable</script> \\u202e");
});

test("mouse text drag preserves native selection while selecting crossed lines", async ({ page }) => {
  await setup(page);
  const first = page.getByRole("listbox", { name: "Diff lines" }).first();
  const start = first.getByRole("option", { name: "Context line old:1 new:1" }).locator("code");
  const end = first.getByRole("option", { name: "Added line new:2" }).locator("code");
  const startBox = await start.boundingBox();
  const endBox = await end.boundingBox();
  expect(startBox).not.toBeNull();
  expect(endBox).not.toBeNull();
  await page.mouse.move(startBox!.x + 8, startBox!.y + startBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(endBox!.x + endBox!.width - 4, endBox!.y + endBox!.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByLabel("First selected")).toHaveText("2,3,4");
  expect(await page.evaluate(() => getSelection()?.toString().length ?? 0)).toBeGreaterThan(0);
  await first.getByRole("option", { name: "Context line old:3 new:3" }).click({ modifiers: ["Shift"] });
  await expect(page.getByLabel("First selected")).toHaveText("2,3,4,5");
});

test("keyboard navigation and selection skip non-source rows", async ({ page }) => {
  await setup(page);
  const first = page.getByRole("listbox", { name: "Diff lines" }).first();
  await first.focus();
  await first.press(" ");
  await expect(page.getByLabel("First selected")).toHaveText("2");
  await first.press("Shift+ArrowDown");
  await first.press("Shift+ArrowDown");
  await expect(page.getByLabel("First selected")).toHaveText("2,3,4");
  await first.press("End");
  await first.press("Enter");
  await expect(page.getByLabel("First selected")).toHaveText("2,3,4,5");
  await first.press("Home");
  await first.press(" ");
  await expect(page.getByLabel("First selected")).toHaveText("3,4,5");
});

test("touch scroll does not select, while taps toggle lines", async ({ page }) => {
  await setup(page);
  const option = page.getByRole("listbox", { name: "Diff lines" }).first()
    .getByRole("option", { name: "Added line new:2" });
  const box = await option.boundingBox();
  expect(box).not.toBeNull();
  await option.dispatchEvent("pointerdown", {
    pointerType: "touch", pointerId: 7, clientX: box!.x + 10, clientY: box!.y + 5, bubbles: true,
  });
  await option.dispatchEvent("pointermove", {
    pointerType: "touch", pointerId: 7, clientX: box!.x + 80, clientY: box!.y + 5, bubbles: true,
  });
  await option.dispatchEvent("pointerup", {
    pointerType: "touch", pointerId: 7, clientX: box!.x + 80, clientY: box!.y + 5, bubbles: true,
  });
  await option.dispatchEvent("click");
  await expect(page.getByLabel("First selected")).toHaveText("");
  await option.dispatchEvent("pointerdown", { pointerType: "touch", pointerId: 8, clientX: box!.x + 10, clientY: box!.y + 5 });
  await option.dispatchEvent("pointerup", { pointerType: "touch", pointerId: 8, clientX: box!.x + 10, clientY: box!.y + 5 });
  await option.dispatchEvent("click");
  await expect(page.getByLabel("First selected")).toHaveText("4");
  await option.dispatchEvent("pointerdown", { pointerType: "touch", pointerId: 9, clientX: box!.x + 10, clientY: box!.y + 5 });
  await option.dispatchEvent("pointerup", { pointerType: "touch", pointerId: 9, clientX: box!.x + 10, clientY: box!.y + 5 });
  await option.dispatchEvent("click");
  await expect(page.getByLabel("First selected")).toHaveText("");
});

test("horizontal arrow keys scroll long code without moving the active line", async ({ page }) => {
  await setup(page);
  await page.addStyleTag({ content: ".git-diff-lines .git-diff-line code { min-width: 2000px; }" });
  const list = page.getByRole("listbox", { name: "Diff lines" }).first();
  const region = page.getByRole("region", { name: "Selected file unified diff" }).first();
  await list.focus();
  const active = await list.getAttribute("aria-activedescendant");
  await list.press("ArrowRight");
  await expect.poll(() => region.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await expect(list).toHaveAttribute("aria-activedescendant", active!);
  await expect(page.getByLabel("First selected")).toHaveText("");
});
