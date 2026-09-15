import { test, expect, type Page } from "@playwright/test";
import { build } from "vite";

// Bundle only the owned component with the existing Vite stack, in memory.
// Every navigation/API request is intercepted; no running daemon is required or touched.
let script = "";
let styles = "";
test.beforeAll(async () => {
  const entry = "virtual:git-workspace-test";
  const result = await build({
    configFile: false,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [{
      name: "git-workspace-test-entry",
      resolveId: (id) => id === entry ? `\0${entry}` : undefined,
      load: (id) => id === `\0${entry}` ? `
        import React, { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { GitPanel } from "/src/components/GitPanel.tsx";
        function Harness() {
          const [open, setOpen] = useState(false);
          const [draft, setDraft] = useState("");
          const [scope, setScope] = useState({ sessionId: "a", cwd: "Q:\\\\example" });
          window.setGitScope = (sessionId, cwd) => setScope({ sessionId, cwd });
          return React.createElement(React.Fragment, null,
            React.createElement("button", { onClick: () => setOpen(true) }, "Open Git workspace"),
            React.createElement("textarea", { "aria-label": "Review draft", value: draft, onChange: e => setDraft(e.target.value) }),
            open && React.createElement(GitPanel, { ...scope,
              onClose: () => setOpen(false),
              onAsk: question => setDraft(previous => previous ? previous + "\\n\\n" + question : question)
            })
          );
        }
        createRoot(document.getElementById("root")).render(React.createElement(Harness));
      ` : undefined,
    }],
    build: { write: false, minify: false, rollupOptions: { input: entry }, assetsInlineLimit: 0 },
  });
  const outputs = Array.isArray(result) ? result : [result];
  for (const output of outputs) {
    if (!("output" in output)) continue;
    for (const chunk of output.output) {
      if (chunk.type === "chunk") script += chunk.code;
      else if (chunk.fileName.endsWith(".css")) styles += String(chunk.source);
    }
  }
});

const change = (path: string, extra = {}) => ({
  path, originalPath: null, status: "M", kind: "file", added: 1, deleted: 1, binary: false, ...extra,
});
const snapshot = (extra = {}) => ({
  state: "repository", repoRoot: "Q:/example", branch: "feature", head: "a".repeat(40),
  upstream: "refs/remotes/origin/feature", base: "refs/remotes/origin/feature",
  baseCommit: "b".repeat(40), mergeBase: "c".repeat(40), detached: false, unborn: false,
  refs: [
    { name: "refs/remotes/origin/feature", commit: "b".repeat(40) },
    { name: "refs/remotes/origin/main", commit: "d".repeat(40) },
    { name: "refs/heads/main", commit: "d".repeat(40) },
  ],
  staged: [change("staged file.txt")],
  unstaged: [change("working file.txt"), change("line\nname.txt")],
  compare: [change("committed file.txt")],
  untracked: [change("new.txt", { status: "?", kind: "untracked", added: null, deleted: null })],
  compareUnavailableReason: null, warnings: [], ...extra,
});
const preview = (path: string, view = "unstaged", extra = {}) => ({
  repoRoot: "Q:/example", path, originalPath: null, view,
  head: "a".repeat(40), base: "refs/remotes/origin/feature", baseCommit: "b".repeat(40),
  mergeBase: "c".repeat(40), contentId: `${view}-one`, truncated: false, binary: false,
  kind: "file", added: 1, deleted: 1, unavailableReason: null, warnings: [],
  patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old ${view}\n+new ${view}\n`,
  ...extra,
});

async function setup(page: Page) {
  const requests: { command: string; args: Record<string, unknown> }[] = [];
  const state = {
    workspace: snapshot(),
    statusError: "",
    diffError: "",
    delayedPath: "",
    delay: 0,
    overrideDiff: {} as Record<string, unknown>,
  };
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/__git-workspace-harness.js") return route.fulfill({ contentType: "text/javascript", body: script });
    if (url.pathname === "/__git-workspace-harness.css") return route.fulfill({ contentType: "text/css", body: styles });
    if (url.pathname.startsWith("/api/")) {
      const command = url.pathname.split("/").at(-1)!;
      const args = route.request().postDataJSON() ?? {};
      requests.push({ command, args });
      if (command === "git_workspace") {
        if (state.statusError) return route.fulfill({ status: 500, body: state.statusError });
        return route.fulfill({ json: { ...state.workspace, ...(args.base ? { base: args.base } : {}) } });
      }
      if (command === "git_diff") {
        if (args.path === state.delayedPath) await new Promise((resolve) => setTimeout(resolve, state.delay));
        if (state.diffError) return route.fulfill({ status: 500, body: state.diffError });
        return route.fulfill({ json: preview(args.path, args.view, { ...state.overrideDiff, ...(args.base ? { base: args.base } : {}) }) });
      }
      return route.fulfill({ status: 405, body: `Unexpected endpoint: ${command}` });
    }
    if (url.pathname === "/") return route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><head><link rel="stylesheet" href="/__git-workspace-harness.css"></head><body><div id="root"></div><script type="module" src="/__git-workspace-harness.js"></script></body></html>',
    });
    return route.abort();
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Open Git workspace" })).toBeVisible();
  return { requests, state };
}

async function open(page: Page) {
  await page.getByRole("button", { name: "Open Git workspace" }).click();
  await expect(page.getByRole("dialog", { name: "Git workspace" })).toBeVisible();
}

test("inspection is explicit, status is fetched once, and only selected file patches load", async ({ page }) => {
  const { requests } = await setup(page);
  expect(requests).toEqual([]);
  await open(page);
  await expect(page.getByRole("button", { name: /working file.txt/ })).toBeVisible();
  expect(requests.filter((request) => request.command === "git_workspace")).toHaveLength(1);
  expect(requests.filter((request) => request.command === "git_diff")).toHaveLength(0);
  await page.getByRole("button", { name: /working file.txt/ }).click();
  await expect(page.getByRole("region", { name: "Selected file unified diff" })).toContainText("+new unstaged");
  expect(requests.filter((request) => request.command === "git_diff")).toEqual([{
    command: "git_diff", args: { sessionId: "a", view: "unstaged", path: "working file.txt", base: "refs/remotes/origin/feature" },
  }]);
  await page.getByRole("button", { name: "Staged 1", exact: true }).click();
  await page.getByRole("button", { name: /staged file.txt/ }).click();
  await expect(page.getByRole("region", { name: "Selected file unified diff" })).toContainText("+new staged");
  expect(requests.filter((request) => request.command === "git_workspace")).toHaveLength(1);
  expect(requests.every((request) => ["git_workspace", "git_diff"].includes(request.command))).toBe(true);
});

test("PR comparison explains committed-only merge-base semantics and target selection", async ({ page }) => {
  const { requests } = await setup(page);
  await open(page);
  await expect(page.getByText(/Tracking upstream is a default/)).toBeVisible();
  await page.getByLabel("Comparison target").selectOption("refs/remotes/origin/main");
  await expect.poll(() => requests.filter((request) => request.command === "git_workspace").length).toBe(2);
  await page.getByRole("button", { name: "PR comparison 1", exact: true }).click();
  await expect(page.getByText("Committed changes only.", { exact: true })).toBeVisible();
  await expect(page.getByText(/Excludes staged, unstaged and untracked edits/)).toBeVisible();
  await page.getByRole("button", { name: /committed file.txt/ }).click();
  await expect(page.getByRole("region", { name: "Selected file unified diff" })).toContainText("+new compare");
  expect(requests[requests.length - 1].args.base).toBe("refs/remotes/origin/main");
});

test("newline paths are displayed escaped but requested literally and rendered as text", async ({ page }) => {
  const { requests, state } = await setup(page);
  state.overrideDiff = { patch: "@@ -1 +1 @@\n-old\n+<script>alert('not executable')</script>\n" };
  await open(page);
  await page.getByRole("button", { name: /line\\nname.txt/ }).click();
  await expect(page.getByRole("region", { name: "Selected file unified diff" })).toContainText("<script>");
  expect(requests[requests.length - 1].args.path).toBe("line\nname.txt");
  await expect(page.locator(".git-panel-diff script")).toHaveCount(0);
});

test("stale file responses cannot replace the latest selection or session", async ({ page }) => {
  const { state, requests } = await setup(page);
  state.delayedPath = "working file.txt";
  state.delay = 600;
  await open(page);
  await page.getByRole("button", { name: /working file.txt/ }).click();
  await expect.poll(() => requests.some((request) => request.args.path === "working file.txt")).toBe(true);
  await page.getByRole("button", { name: /line\\nname.txt/ }).click();
  await expect(page.getByRole("heading", { name: "line\\nname.txt", exact: true })).toBeVisible();
  await page.waitForTimeout(800);
  await expect(page.getByRole("heading", { name: "working file.txt", exact: true })).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { setGitScope: (sessionId: string, cwd: string) => void }).setGitScope("b", "Q:\\other"));
  await expect.poll(() => requests.filter((request) => request.command === "git_workspace" && request.args.sessionId === "b").length).toBe(1);
  await expect(page.getByRole("heading", { name: "line\\nname.txt", exact: true })).toHaveCount(0);
});

test("a comparison target moving after status requires refresh instead of showing a mismatched patch", async ({ page }) => {
  const { state } = await setup(page);
  await open(page);
  await page.getByRole("button", { name: /^PR comparison / }).click();
  state.overrideDiff = { baseCommit: "e".repeat(40), mergeBase: "f".repeat(40) };
  await page.getByRole("button", { name: /committed file.txt/ }).click();
  await expect(page.getByRole("alert")).toContainText("comparison target or HEAD changed");
  await expect(page.getByRole("region", { name: "Selected file unified diff" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Ask about/ })).toHaveCount(0);
});

test("local comments persist, attach to exact diff identity, and Ask only adds a draft", async ({ page }) => {
  const { state, requests } = await setup(page);
  await page.getByLabel("Review draft").fill("Keep existing draft.");
  await open(page);
  await page.getByRole("button", { name: /working file.txt/ }).click();
  await page.getByLabel("Select added line new:1", { exact: true }).check();
  await page.getByLabel("Local review comment", { exact: true }).fill("Could this fail on an empty input?");
  await page.getByRole("button", { name: "Save local comment", exact: true }).click();
  await expect(page.getByLabel("Local Git review comments")).toContainText("Could this fail");
  await page.getByRole("button", { name: "Ask about comment", exact: true }).click();
  await expect(page.getByText("Review question opened as a draft. Nothing was sent.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Review draft")).toHaveValue(/Keep existing draft\.[\s\S]*UNTRUSTED CODE BOUNDARY[\s\S]*Could this fail/);
  expect(requests.some((request) => /send|message|comment/.test(request.command))).toBe(false);
  await page.getByRole("button", { name: "Close Git workspace" }).click();
  await open(page);
  await page.getByRole("button", { name: /working file.txt/ }).click();
  await expect(page.getByLabel("Local Git review comments")).toContainText("Could this fail");
  state.overrideDiff = { contentId: "new-index-or-worktree-content" };
  await page.getByRole("button", { name: "Refresh Git workspace" }).click();
  await page.getByRole("button", { name: /working file.txt/ }).click();
  await expect(page.getByText(/older comment\(s\) belong to a different/)).toBeVisible();
  await expect(page.getByLabel("Local Git review comments")).toHaveCount(0);
});

test("no repo, detached/no upstream, failed status and bounded binary previews are explicit", async ({ page }) => {
  const { state } = await setup(page);
  state.workspace = snapshot({ state: "noRepo", repoRoot: null, warnings: [] });
  await open(page);
  await expect(page.getByText("This session is not in a Git working tree.", { exact: true })).toBeVisible();
  state.workspace = snapshot({ detached: true, branch: null, upstream: null, base: null, compareUnavailableReason: "No upstream is configured. Choose a target." });
  await page.getByRole("button", { name: "Refresh Git workspace" }).click();
  await expect(page.getByText("Detached HEAD", { exact: true })).toBeVisible();
  state.overrideDiff = { patch: "", binary: true, unavailableReason: "Binary file changed; no text diff is available.", truncated: false };
  await page.getByRole("button", { name: /working file.txt/ }).click();
  await expect(page.getByText(/Binary file changed/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Ask about/ })).toHaveCount(0);
  state.statusError = "Git inspection timed out after 15 seconds.";
  await page.getByRole("button", { name: "Refresh Git workspace" }).click();
  await expect(page.getByRole("alert")).toContainText("timed out");
  state.statusError = "";
  state.overrideDiff = { truncated: true };
  await page.getByRole("button", { name: "Refresh Git workspace" }).click();
  await page.getByRole("button", { name: /working file.txt/ }).click();
  await expect(page.getByText(/Partial preview/)).toBeVisible();
});

test("storage failure and selected-file errors are visible without erasing stored comments", async ({ page }) => {
  const { state } = await setup(page);
  await page.evaluate(() => localStorage.setItem("copilot-sessions.git-comments.v1", "invalid json"));
  await open(page);
  await expect(page.getByRole("alert")).toContainText("unreadable");
  state.diffError = "Selected file is no longer changed. Refresh the workspace.";
  await page.getByRole("button", { name: /working file.txt/ }).click();
  await expect(page.getByRole("alert").filter({ hasText: "no longer changed" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("copilot-sessions.git-comments.v1"))).toBe("invalid json");
});

test("a missing local upstream does not block worktree inspection or leak invalid base refs", async ({ page }) => {
  const { state, requests } = await setup(page);
  state.workspace = snapshot({
    upstream: "refs/remotes/origin/gone", base: "refs/remotes/origin/gone", baseCommit: null,
    compareUnavailableReason: "The configured upstream is not available locally. Choose another target; this panel never fetches.",
  });
  await open(page);
  await page.getByRole("button", { name: /working file.txt/ }).click();
  await expect(page.getByRole("region", { name: "Selected file unified diff" })).toBeVisible();
  expect(requests[requests.length - 1].args.base).toBeUndefined();
  await page.getByRole("button", { name: "PR comparison 1", exact: true }).click();
  await expect(page.getByText(/configured upstream is not available locally/)).toBeVisible();
});
