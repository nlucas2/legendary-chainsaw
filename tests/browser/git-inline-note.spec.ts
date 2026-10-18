import { expect, test, type Locator, type Page } from "@playwright/test";
import { build } from "vite";

let script = "";
let styles = "";
const firstPath = "src/" + "long-directory/".repeat(10) + "large-file.ts";
const secondPath = "src/second.ts";
const commentsKey = "copilot-sessions.git-comments.v1";

test.beforeAll(async () => {
  const entry = "virtual:git-inline-note-test";
  const result = await build({
    configFile: false,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [{
      name: "git-inline-note-test-entry",
      resolveId: (id) => id === entry ? `\0${entry}` : undefined,
      load: (id) => id === `\0${entry}` ? `
        import React, { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { GitFileReview } from "/src/components/GitFileReview.tsx";
        import "/src/components/git-panel.css";
        const load = (run) => run();
        const noop = () => {};
        const initialWorkspace = {
          state: "repository", repoRoot: "Q:/selected-repo", head: "a".repeat(40),
          base: null, baseCommit: null, mergeBase: null, warnings: [], refs: [],
          staged: [], unstaged: [], untracked: [], compare: []
        };
        function Harness() {
          const [open, setOpen] = useState(true);
          const [continuous, setContinuous] = useState(false);
          const [workspace, setWorkspace] = useState(initialWorkspace);
          const [comments, setComments] = useState([]);
          const [draftStore] = useState(() => new Map());
          window.getInlineDrafts = () => [...draftStore];
          window.refreshInlineDiff = () => setWorkspace(previous => ({ ...previous, head: "b".repeat(40) }));
          window.changeInlineRepo = repoRoot => setWorkspace(previous => ({ ...previous, repoRoot }));
          window.changeInlineFile = path => setPath(path);
          window.setInlineContinuous = setContinuous;
          const [path, setPath] = useState(${JSON.stringify(firstPath)});
          return open && React.createElement("section", {
            className: "git-panel", role: "dialog", "aria-label": "Git workspace", tabIndex: -1,
            onKeyDown: event => {
              if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
            }
          },
            React.createElement("header", { className: "git-panel-header" },
              React.createElement("h2", null, "Git workspace"),
              React.createElement("button", { onClick: () => setContinuous(value => !value) }, "Toggle continuous")
            ),
            React.createElement("div", { className: "git-panel-review" },
              ...[path, ...(continuous ? [${JSON.stringify(secondPath)}] : [])].map(filePath =>
                React.createElement(GitFileReview, {
                  key: workspace.repoRoot + ":" + filePath, sessionId: "inline-test", workspace, view: "unstaged", path: filePath,
                  comments, onCommentsChange: setComments, onAsk: noop, onDiscuss: noop, load, continuous, draftStore
                })
              )
            )
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

async function setup(page: Page, continuous = false) {
  const requests: { command: string; args: Record<string, unknown> }[] = [];
  const state = { contentId: "first", head: "a".repeat(40), delay: 0, repoRoot: "Q:/selected-repo" };
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: script });
    if (url.pathname === "/fixture.css") return route.fulfill({ contentType: "text/css", body: styles });
    if (url.pathname.startsWith("/api/")) {
      const command = url.pathname.split("/").at(-1)!;
      const args = route.request().postDataJSON() ?? {};
      requests.push({ command, args });
      if (command !== "git_diff") return route.fulfill({ status: 405, body: "Unexpected repository operation" });
      const snapshot = { ...state };
      if (snapshot.delay) await new Promise((resolve) => setTimeout(resolve, snapshot.delay));
      return route.fulfill({ json: {
        repoRoot: snapshot.repoRoot, path: args.path, originalPath: null, view: args.view,
        head: snapshot.head, base: null, baseCommit: null, mergeBase: null, contentId: snapshot.contentId,
        truncated: false, binary: false, kind: "file", added: 300, deleted: 0,
        context: args.context ?? "changes", fullContextComplete: args.context === "full",
        unavailableReason: null, warnings: [],
        patch: `diff --git a/${args.path} b/${args.path}\n--- a/${args.path}\n+++ b/${args.path}\n@@ -0,0 +1,300 @@\n`
          + Array.from({ length: 300 }, (_, i) => `+const selectedLine${i + 1} = "${"long source ".repeat(30)}";`).join("\n") + "\n",
      } });
    }
    if (url.pathname === "/") return route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
    });
    return route.abort();
  });
  await page.goto("/");
  await expect(page.getByRole("listbox", { name: "Diff lines" })).toBeVisible();
  if (continuous) await page.getByRole("button", { name: "Toggle continuous" }).click();
  return { requests, state };
}

function file(page: Page, path = firstPath) {
  return page.locator("[data-diff-path]").filter({ has: page.getByRole("heading", { name: path, exact: true }) });
}

function line(review: Locator, number: number) {
  return review.getByRole("option", { name: `Added line new:${number}`, exact: true });
}

async function alignLine(page: Page, row: Locator) {
  await row.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest" }));
  await expect(row).toBeInViewport();
  // Leave enough vertical room for the editor in the clipped diff viewport.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

async function scrollPositions(page: Page) {
  return page.evaluate(() => ({
    panel: document.querySelector(".git-panel")!.scrollTop,
    diff: document.querySelector(".git-diff-lines")!.scrollTop,
    x: document.querySelector(".git-diff-lines")!.scrollLeft,
  }));
}

async function expectNear(page: Page, editor: Locator, row: Locator) {
  await expect(editor).toBeInViewport();
  await expect.poll(async () => {
    const note = (await editor.boundingBox())!;
    const code = (await row.boundingBox())!;
    return Math.min(Math.abs(note.y - code.y - code.height), Math.abs(note.y + note.height - code.y));
  }).toBeLessThan(40);
  const note = (await editor.boundingBox())!;
  const panel = (await page.getByRole("dialog").boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(note.x).toBeGreaterThanOrEqual(Math.max(0, panel.x));
  expect(note.x + note.width).toBeLessThanOrEqual(Math.min(viewport.width, panel.x + panel.width));
  expect(note.y).toBeGreaterThanOrEqual(Math.max(0, panel.y));
  expect(note.y + note.height).toBeLessThanOrEqual(Math.min(viewport.height, panel.y + panel.height));
}

test("large continuous mouse drag commits one nearby local editor and preserves native highlight", async ({ page }) => {
  const { requests } = await setup(page, true);
  const review = file(page);
  const start = line(review, 110), end = line(review, 112);
  await alignLine(page, start);
  const normalEditor = (await review.locator(".git-panel-comment-editor").boundingBox())!;
  expect(normalEditor.y).toBeGreaterThan(page.viewportSize()!.height * 2);
  const a = (await start.locator("code").boundingBox())!;
  const b = (await end.locator("code").boundingBox())!;
  await page.mouse.move(a.x + 12, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 200, b.y + b.height / 2, { steps: 12 });
  await expect(page.getByRole("region", { name: "Inline local review note" })).toHaveCount(0);
  await page.mouse.up();
  const editor = review.getByRole("region", { name: "Inline local review note" });
  await expectNear(page, editor, end);
  await expect(review.locator(".git-diff-line[aria-selected='true']")).toHaveCount(3);
  const highlighted = await page.evaluate(() => getSelection()?.toString());
  expect(highlighted).toContain("selectedLine110");
  expect(highlighted).toContain("selectedLine112");
  await expect(editor.getByRole("textbox")).not.toBeFocused();
  await page.waitForTimeout(80);
  expect(await page.evaluate(() => getSelection()?.toString())).toBe(highlighted);
  await expect(review.getByLabel("Local review comment", { exact: true })).toHaveCount(1);
  await expect(editor).toContainText("Local only");
  await page.mouse.move(a.x + 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 200, b.y + b.height / 2, { steps: 12 });
  await expect(editor).toHaveCount(0);
  await page.mouse.up();
  await expectNear(page, editor, end);
  expect(await page.evaluate(() => getSelection()?.toString())).toContain("selectedLine112");
  await editor.getByLabel("Local review comment").fill("This belongs to selected repository and file");
  const before = await scrollPositions(page);
  await editor.getByRole("button", { name: "Save local comment", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(review.getByRole("listbox")).toBeFocused();
  expect(await scrollPositions(page)).toEqual(before);
  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), commentsKey);
  expect(saved).toHaveLength(1);
  expect(JSON.parse(saved[0].identity).slice(0, 2)).toEqual(["Q:/selected-repo", firstPath]);
  expect(saved[0].locations.map((location: { location: string }) => location.location)).toEqual(["new:110", "new:111", "new:112"]);
  expect(requests.every((request) => request.command === "git_diff" && request.args.workingPath === "Q:/selected-repo")).toBe(true);
});

test("keyboard ranges and toggles position after scrolling, Escape closes editor before parent", async ({ page }) => {
  await setup(page, true);
  const review = file(page), row = line(review, 130);
  const list = review.getByRole("listbox");
  await list.focus();
  await list.press("Home");
  expect((await review.locator(".git-panel-comment-editor").boundingBox())!.y).toBeGreaterThan(page.viewportSize()!.height * 2);
  await list.press(" ");
  await expectNear(page, review.getByRole("region", { name: "Inline local review note" }), line(review, 1));
  await list.press("Escape");
  await alignLine(page, row);
  await row.click();
  await list.press("Shift+ArrowDown");
  await list.press("Shift+ArrowDown");
  const end = line(review, 132);
  const editor = review.getByRole("region", { name: "Inline local review note" });
  await expectNear(page, editor, end);
  await expect(editor).toContainText("3/40 selected lines");
  await list.press("Control+Enter");
  await expect(editor).toContainText("2/40 selected lines");
  await list.press("Meta+Enter");
  await expect(editor).toContainText("3/40 selected lines");
  await editor.getByLabel("Local review comment").fill("Keep draft after escape");
  const before = await scrollPositions(page);
  await editor.getByLabel("Local review comment").press("Escape");
  await expect(page.getByRole("dialog", { name: "Git workspace" })).toBeVisible();
  await expect(editor).toHaveCount(0);
  await expect(list).toBeFocused();
  expect(await scrollPositions(page)).toEqual(before);
  await list.press("Shift+ArrowUp");
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel("Local review comment")).toHaveValue("Keep draft after escape");
  await list.press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
  await list.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("same-line highlighting opens only on release, Close and temporary clear keep the draft", async ({ page }) => {
  await setup(page);
  const review = file(page), row = line(review, 80);
  await alignLine(page, row);
  const box = (await row.locator("code").boundingBox())!;
  await page.mouse.move(box.x + 8, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 145, box.y + box.height / 2, { steps: 10 });
  await expect(review.locator(".git-inline-note")).toHaveCount(0);
  await page.mouse.up();
  const editor = review.getByRole("region", { name: "Inline local review note" });
  await expectNear(page, editor, row);
  expect(await page.evaluate(() => getSelection()?.toString().length ?? 0)).toBeGreaterThan(0);
  await editor.getByLabel("Local review comment").fill("Draft survives dismissal");
  const before = await scrollPositions(page);
  await editor.getByRole("button", { name: "Close note editor" }).click();
  expect(await scrollPositions(page)).toEqual(before);
  await expect(review.getByRole("listbox")).toBeFocused();
  await row.click();
  await expect(editor.getByLabel("Local review comment")).toHaveValue("Draft survives dismissal");
  await review.getByRole("button", { name: "Clear selection", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(review.getByLabel("Local review comment")).toHaveValue("Draft survives dismissal");
  await expect(review.getByRole("button", { name: "Save local comment" })).toBeDisabled();
  expect(await page.evaluate(() => getSelection()?.toString())).toBe("");
  await alignLine(page, row);
  await row.click();
  await expect(editor.getByLabel("Local review comment")).toHaveValue("Draft survives dismissal");
});

test("storage errors remain beside inline editor and preserve the draft for retry", async ({ page }) => {
  await setup(page);
  const review = file(page), row = line(review, 100);
  await alignLine(page, row);
  await row.click();
  const editor = review.getByRole("region", { name: "Inline local review note" });
  await editor.getByLabel("Local review comment").fill("Do not lose this note");
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function () {
      Storage.prototype.setItem = original;
      throw new DOMException("Synthetic quota failure", "QuotaExceededError");
    };
  });
  await editor.getByRole("button", { name: "Save local comment" }).click();
  await expect(editor.getByRole("alert")).toContainText("Synthetic quota failure");
  await expect(editor.getByLabel("Local review comment")).toHaveValue("Do not lose this note");
  await expect(editor).toBeInViewport();
  expect(await page.evaluate((key) => localStorage.getItem(key), commentsKey)).toBeNull();
  expect(await page.evaluate(() => (window as unknown as { getInlineDrafts: () => [string, string][] }).getInlineDrafts().map(([, text]) => text))).toEqual(["Do not lose this note"]);
  await editor.getByRole("button", { name: "Save local comment" }).click();
  await expect(editor).toHaveCount(0);
  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), commentsKey);
  expect(saved[0].body).toBe("Do not lose this note");
  expect(await page.evaluate(() => (window as unknown as { getInlineDrafts: () => [string, string][] }).getInlineDrafts())).toEqual([]);
});

test("40-line budget and metadata-only clicks cannot silently change note locations", async ({ page }) => {
  await setup(page);
  const review = file(page);
  await line(review, 1).click();
  await line(review, 41).click({ modifiers: ["Shift"] });
  await review.getByLabel("Local review comment").fill("Over the budget");
  await expect(review.getByRole("button", { name: "Save local comment" })).toBeDisabled();
  await expect(review.getByLabel("Local review comment")).toHaveValue("Over the budget");
  await review.getByRole("button", { name: "Clear selection" }).click();
  await review.getByText("@@ -0,0 +1,300 @@", { exact: true }).click();
  await expect(review.locator(".git-inline-note")).toHaveCount(0);
  await expect(review.getByRole("button", { name: "Save local comment" })).toBeDisabled();
  expect(await page.evaluate((key) => localStorage.getItem(key), commentsKey)).toBeNull();
});

test("refresh hides stale selections immediately, retains draft, and saves only the new content", async ({ page }) => {
  const { state, requests } = await setup(page);
  const review = file(page), row = line(review, 90);
  await alignLine(page, row);
  await row.click();
  await review.getByLabel("Local review comment").fill("Draft during refresh");
  state.delay = 300; state.contentId = "refreshed"; state.head = "b".repeat(40);
  await page.evaluate(() => (window as unknown as { refreshInlineDiff: () => void }).refreshInlineDiff());
  await expect(review.getByRole("status")).toContainText("Loading");
  await expect(review.getByLabel("Local review comment")).toHaveCount(0);
  await expect(review.locator(".git-inline-note")).toHaveCount(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), commentsKey)).toBeNull();
  await expect(review.getByRole("listbox")).toBeVisible();
  await expect(review.locator("[aria-selected='true']")).toHaveCount(0);
  await expect(review.getByLabel("Local review comment")).toHaveValue("Draft during refresh");
  await expect(review.getByRole("button", { name: "Save local comment" })).toBeDisabled();
  await line(review, 25).click();
  await review.getByRole("button", { name: "Save local comment" }).click();
  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), commentsKey);
  expect(JSON.parse(saved[0].identity).at(-1)).toBe("refreshed");
  expect(saved[0].locations.map((location: { location: string }) => location.location)).toEqual(["new:25"]);
  expect(requests).toHaveLength(2);
});

test("late diff for a different file cannot create an editor or cross-file note", async ({ page }) => {
  const { state, requests } = await setup(page);
  const review = file(page);
  await line(review, 1).click();
  await review.getByLabel("Local review comment").fill("First file draft");
  state.delay = 250;
  await review.getByLabel("Whole-file context").check();
  await expect.poll(() => requests.filter((request) => request.args.context === "full").length).toBe(1);
  await page.evaluate((path) => (window as unknown as { changeInlineFile: (value: string) => void }).changeInlineFile(path), secondPath);
  const second = file(page, secondPath);
  await expect(second.getByRole("listbox")).toBeVisible();
  await expect(second.getByLabel("Local review comment")).toHaveValue("");
  await expect(second.locator("[aria-selected='true']")).toHaveCount(0);
  await expect(second.locator(".git-inline-note")).toHaveCount(0);
  await expect(second.getByRole("button", { name: "Save local comment" })).toBeDisabled();
  await page.evaluate((path) => (window as unknown as { changeInlineFile: (value: string) => void }).changeInlineFile(path), firstPath);
  await expect(file(page).getByLabel("Local review comment")).toHaveValue("First file draft");
  await expect(file(page).getByRole("button", { name: "Save local comment" })).toBeDisabled();
});

test("shared drafts survive repository and file remounts without restoring stale line selections", async ({ page }) => {
  const { state } = await setup(page);
  await line(file(page), 10).click();
  await file(page).getByLabel("Local review comment").fill("Repository A first file draft");
  await page.evaluate((path) => (window as unknown as { changeInlineFile: (value: string) => void }).changeInlineFile(path), secondPath);
  await expect(file(page, secondPath).getByLabel("Local review comment")).toHaveValue("");
  await line(file(page, secondPath), 20).click();
  await file(page, secondPath).getByLabel("Local review comment").fill("Repository A second file draft");
  state.repoRoot = "Q:/other-repo";
  await page.evaluate((root) => (window as unknown as { changeInlineRepo: (value: string) => void }).changeInlineRepo(root), state.repoRoot);
  await expect(file(page, secondPath).getByLabel("Local review comment")).toHaveValue("");
  await line(file(page, secondPath), 30).click();
  await file(page, secondPath).getByLabel("Local review comment").fill("Repository B second file draft");
  state.repoRoot = "Q:/selected-repo";
  await page.evaluate((root) => (window as unknown as { changeInlineRepo: (value: string) => void }).changeInlineRepo(root), state.repoRoot);
  await expect(file(page, secondPath).getByLabel("Local review comment")).toHaveValue("Repository A second file draft");
  await expect(file(page, secondPath).locator("[aria-selected='true']")).toHaveCount(0);
  await expect(file(page, secondPath).getByRole("button", { name: "Save local comment" })).toBeDisabled();
  await page.evaluate((path) => (window as unknown as { changeInlineFile: (value: string) => void }).changeInlineFile(path), firstPath);
  await expect(file(page).getByLabel("Local review comment")).toHaveValue("Repository A first file draft");
  await line(file(page), 40).click();
  await file(page).getByRole("button", { name: "Save local comment" }).click();
  await page.evaluate((path) => (window as unknown as { changeInlineFile: (value: string) => void }).changeInlineFile(path), secondPath);
  await expect(file(page, secondPath).getByLabel("Local review comment")).toHaveValue("Repository A second file draft");
  await page.evaluate((path) => (window as unknown as { changeInlineFile: (value: string) => void }).changeInlineFile(path), firstPath);
  await expect(file(page).getByLabel("Local review comment")).toHaveValue("");
  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), commentsKey);
  expect(saved[0].locations[0].location).toBe("new:40");
  state.repoRoot = "Q:/other-repo";
  await page.evaluate((root) => (window as unknown as { changeInlineRepo: (value: string) => void }).changeInlineRepo(root), state.repoRoot);
  await page.evaluate((path) => (window as unknown as { changeInlineFile: (value: string) => void }).changeInlineFile(path), secondPath);
  await expect(file(page, secondPath).getByLabel("Local review comment")).toHaveValue("Repository B second file draft");
});

test("shared draft cache keeps the newest 32 file identities and preserves explicit empty edits", async ({ page }) => {
  await setup(page);
  for (let index = 0; index < 33; index++) {
    const path = `src/draft-${index}.ts`;
    await page.evaluate((next) => (window as unknown as { changeInlineFile: (value: string) => void }).changeInlineFile(next), path);
    await file(page, path).getByLabel("Local review comment").fill(`Draft ${index}`);
  }
  const drafts = await page.evaluate(() => (window as unknown as { getInlineDrafts: () => [string, string][] }).getInlineDrafts());
  expect(drafts).toHaveLength(32);
  expect(drafts.map(([, text]) => text)).toEqual(Array.from({ length: 32 }, (_, index) => `Draft ${index + 1}`));
  const active = file(page, "src/draft-32.ts");
  await active.getByLabel("Local review comment").fill("");
  const cleared = await page.evaluate(() => (window as unknown as { getInlineDrafts: () => [string, string][] }).getInlineDrafts());
  expect(cleared).toHaveLength(32);
  expect(cleared.at(-1)?.[1]).toBe("");
  expect(await page.evaluate((key) => localStorage.getItem(key), commentsKey)).toBeNull();
});

test("remount restores a draft only when the verified diff content identity matches", async ({ page }) => {
  const { state } = await setup(page);
  await file(page).getByLabel("Local review comment").fill("Draft for original diff only");
  state.contentId = "changed-content";
  await page.evaluate((path) => (window as unknown as { changeInlineFile: (value: string) => void }).changeInlineFile(path), secondPath);
  await expect(file(page, secondPath).getByLabel("Local review comment")).toBeVisible();
  await page.evaluate((path) => (window as unknown as { changeInlineFile: (value: string) => void }).changeInlineFile(path), firstPath);
  await expect(file(page).getByLabel("Local review comment")).toHaveValue("");
  state.contentId = "first";
  await page.evaluate((path) => (window as unknown as { changeInlineFile: (value: string) => void }).changeInlineFile(path), secondPath);
  await expect(file(page, secondPath).getByLabel("Local review comment")).toBeVisible();
  await page.evaluate((path) => (window as unknown as { changeInlineFile: (value: string) => void }).changeInlineFile(path), firstPath);
  await expect(file(page).getByLabel("Local review comment")).toHaveValue("Draft for original diff only");
  await expect(file(page).locator("[aria-selected='true']")).toHaveCount(0);
  await expect(file(page).getByRole("button", { name: "Save local comment" })).toBeDisabled();
});

test("a mismatched repository response exposes an error instead of attaching stale note locations", async ({ page }) => {
  const { state } = await setup(page);
  const review = file(page);
  await line(review, 1).click();
  await review.getByLabel("Local review comment").fill("Never attach to the wrong repository");
  state.repoRoot = "Q:/wrong-repo";
  await review.getByLabel("Whole-file context").check();
  await expect(review.getByRole("alert")).toContainText("does not match this selection");
  await expect(review.getByRole("listbox")).toHaveCount(0);
  await expect(review.locator(".git-inline-note")).toHaveCount(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), commentsKey)).toBeNull();
});

test("continuous enclosing scroll and resize track/clamp the note, then fall back when anchor is offscreen", async ({ page }) => {
  await setup(page, true);
  const review = file(page), row = line(review, 150);
  await alignLine(page, row);
  await row.click();
  const editor = review.getByRole("region", { name: "Inline local review note" });
  await editor.getByLabel("Local review comment").fill("Scroll-safe draft");
  await expectNear(page, editor, row);
  const oldTop = (await editor.boundingBox())!.y;
  await page.getByRole("dialog").evaluate((element) => { element.scrollTop += 35; });
  await expectNear(page, editor, row);
  await expect.poll(async () => (await editor.boundingBox())!.y).not.toBe(oldTop);
  await page.setViewportSize({ width: 820, height: 680 });
  await alignLine(page, row);
  await expectNear(page, editor, row);
  await page.getByRole("dialog").evaluate((element) => { element.scrollTop += 1600; });
  await expect(editor).toHaveCount(0);
  await expect(review.getByLabel("Local review comment")).toHaveValue("Scroll-safe draft");
  await alignLine(page, row);
  await expectNear(page, editor, row);
  await expect(editor.getByLabel("Local review comment")).toHaveValue("Scroll-safe draft");
});

test("diff scrolling follows its row and switching continuous files never shows two floating editors", async ({ page }) => {
  await setup(page);
  const review = file(page), row = line(review, 70);
  await alignLine(page, row);
  await row.click();
  const editor = review.getByRole("region", { name: "Inline local review note" });
  await editor.getByLabel("Local review comment").fill("First local draft");
  await expectNear(page, editor, row);
  await review.getByRole("region", { name: "Selected file unified diff" }).evaluate((element) => { element.scrollTop += 25; });
  await expectNear(page, editor, row);
  await page.getByRole("button", { name: "Toggle continuous" }).click();
  const second = file(page, secondPath), secondRow = line(second, 90);
  await expect(second.getByRole("listbox")).toBeVisible();
  await alignLine(page, secondRow);
  await secondRow.click();
  await expect(page.getByRole("region", { name: "Inline local review note" })).toHaveCount(1);
  await expect(second.getByRole("region", { name: "Inline local review note" })).toBeInViewport();
  await expect(second.getByLabel("Local review comment")).toHaveValue("");
  await expect(review.getByLabel("Local review comment")).toHaveValue("First local draft");
  await second.getByLabel("Local review comment").fill("Second local note");
  await second.getByRole("button", { name: "Save local comment" }).click();
  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), commentsKey);
  expect(JSON.parse(saved[0].identity)[1]).toBe(secondPath);
  expect(saved[0].locations[0].location).toBe("new:90");
});

test("760px and smaller keep one textarea in normal mobile flow, resizing preserves draft", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 780 });
  await setup(page);
  const review = file(page), row = line(review, 120);
  await alignLine(page, row);
  await row.click();
  await expect(review.locator(".git-inline-note")).toHaveCount(0);
  const editor = review.locator(".git-panel-comment-editor");
  const diffBox = (await review.locator(".git-diff-lines").boundingBox())!;
  const editorBox = (await editor.boundingBox())!;
  expect(editorBox.y).toBeGreaterThanOrEqual(diffBox.y + diffBox.height);
  expect(await editor.evaluate((element) => getComputedStyle(element).position)).toBe("static");
  await editor.getByLabel("Local review comment").fill("Mobile draft");
  await page.setViewportSize({ width: 1000, height: 900 });
  await alignLine(page, row);
  await expect(review.getByRole("region", { name: "Inline local review note" })).toBeInViewport();
  await expect(editor.getByLabel("Local review comment")).toHaveValue("Mobile draft");
  await page.setViewportSize({ width: 390, height: 780 });
  await expect(review.locator(".git-inline-note")).toHaveCount(0);
  await expect(editor.getByLabel("Local review comment")).toHaveValue("Mobile draft");
  await expect(review.getByLabel("Local review comment")).toHaveCount(1);
});
