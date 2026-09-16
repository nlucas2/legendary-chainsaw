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
              onAsk: (question, context) => setDraft(previous => [previous, question, context?.text].filter(Boolean).join("\\n\\n")),
              onDiscuss: context => setDraft(context.suggestedQuestion + "\\n\\n" + context.text)
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
  kind: view === "untracked" ? "untracked" : "file", added: 1, deleted: view === "untracked" ? 0 : 1, unavailableReason: null, warnings: [],
  patch: view === "untracked"
    ? `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+new untracked contents\n`
    : `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old ${view}\n+new ${view}\n`,
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
        return route.fulfill({ json: preview(args.path, args.view, { context: args.context ?? "changes", ...state.overrideDiff, ...(args.base ? { base: args.base } : {}) }) });
      }
      return route.fulfill({ status: 405, body: `Unexpected endpoint: ${command}` });
    }
    if (url.pathname === "/") return route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/__git-workspace-harness.css"></head><body><div id="root"></div><script type="module" src="/__git-workspace-harness.js"></script></body></html>',
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
  await page.getByRole("option", { name: "Added line new:1", exact: true }).click();
  await page.getByLabel("Local review comment", { exact: true }).fill("Could this fail on an empty input?");
  await page.getByRole("button", { name: "Save local comment", exact: true }).click();
  await expect(page.getByLabel("Local Git review comments")).toContainText("Could this fail");
  await page.getByRole("button", { name: "Quick ask about comment", exact: true }).click();
  await expect(page.getByText("Review context prepared. Nothing was sent.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Review draft")).toHaveValue(/Keep existing draft\.[\s\S]*Could this fail[\s\S]*git-review-context/);
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

test("common PR targets stay ahead of feature branches without changing the chosen upstream", async ({ page }) => {
  const { state, requests } = await setup(page);
  state.workspace.refs.unshift(
    { name: "refs/heads/aaa-feature", commit: "a".repeat(40) },
    { name: "refs/remotes/origin/HEAD", commit: "d".repeat(40) },
  );
  await open(page);
  const select = page.getByLabel("Comparison target");
  const groups = await select.locator("optgroup").evaluateAll((groups) => groups.map((group) => ({
    label: group.getAttribute("label"), values: Array.from(group.querySelectorAll("option"), (option) => option.value),
  })));
  expect(groups[0]).toEqual({ label: "Likely PR targets", values: [
    "refs/remotes/origin/HEAD", "refs/remotes/origin/main", "refs/heads/main", "refs/remotes/origin/feature",
  ] });
  await expect(select).toHaveValue("");
  expect(requests.filter((request) => request.command === "git_workspace")).toHaveLength(1);
});

test("continuous diffs load in small batches on scroll and keep per-file comments separate", async ({ page }) => {
  const { state, requests } = await setup(page);
  state.workspace.untracked = [];
  state.workspace.unstaged = Array.from({ length: 9 }, (_, index) => change(`file-${index}.txt`));
  state.overrideDiff = { patch: "@@ -1,30 +1,30 @@\n-old\n+new\n" + " context line\n".repeat(29) };
  await open(page);
  await page.getByRole("button", { name: "Continuous diffs", exact: true }).click();
  await expect.poll(() => requests.filter((request) => request.command === "git_diff").length).toBe(3);
  expect(requests.filter((request) => request.command === "git_diff").map((request) => request.args.path))
    .toEqual(["file-0.txt", "file-1.txt", "file-2.txt"]);
  const panel = page.getByRole("dialog", { name: "Git workspace" });
  await panel.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => requests.filter((request) => request.command === "git_diff").length).toBe(6);
  await expect(page.locator("[data-diff-path]")).toHaveCount(6);
  await panel.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => requests.filter((request) => request.command === "git_diff").length).toBe(9);
  const second = page.getByRole("article", { name: "Diff for file-1.txt", exact: true });
  await second.getByRole("option", { name: "Added line new:1", exact: true }).click();
  await second.getByLabel("Local review comment", { exact: true }).fill("Only the second file");
  await second.getByRole("button", { name: "Save local comment", exact: true }).click();
  await expect(second.getByLabel("Local Git review comments")).toContainText("Only the second file");
  await expect(page.getByRole("article", { name: "Diff for file-0.txt", exact: true }).getByLabel("Local Git review comments")).toHaveCount(0);
  expect(requests.filter((request) => request.command === "git_diff")).toHaveLength(9);
});

test("continuous sidebar follows scrolling and jumps without loading skipped files or losing drafts", async ({ page }) => {
  const { state, requests } = await setup(page);
  state.workspace.untracked = [];
  state.workspace.unstaged = Array.from({ length: 61 }, (_, index) => change(`file-${index}.txt`));
  state.overrideDiff = { patch: "@@ -1,100 +1,100 @@\n-old\n+new\n" + " context line\n".repeat(99) };
  await open(page);
  await page.getByRole("button", { name: "Continuous diffs", exact: true }).click();
  await expect.poll(() => requests.filter((request) => request.command === "git_diff").length).toBe(3);
  const panel = page.getByRole("dialog", { name: "Git workspace" });
  const list = panel.locator(".git-panel-files");
  const first = page.getByRole("article", { name: "Diff for file-0.txt", exact: true });
  await first.getByLabel("Local review comment", { exact: true }).fill("Keep this unfinished note");
  const second = page.getByRole("article", { name: "Diff for file-1.txt", exact: true });
  await second.evaluate((element) => {
    const panel = element.closest(".git-panel")!;
    panel.scrollTop += element.getBoundingClientRect().top - panel.getBoundingClientRect().top + 300;
  });
  await expect(list.locator("[aria-current='location']")).toHaveAttribute("title", "file-1.txt");
  await expect(list).toBeInViewport();
  const listBox = (await list.boundingBox())!;
  const panelBox = (await panel.boundingBox())!;
  expect(listBox.y).toBeGreaterThanOrEqual(panelBox.y);
  expect(listBox.y + listBox.height).toBeLessThanOrEqual(panelBox.y + panelBox.height);
  await list.getByTitle("file-40.txt", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Continuous diffs", exact: true })).toHaveAttribute("aria-pressed", "true");
  const target = page.getByRole("article", { name: "Diff for file-40.txt", exact: true });
  await expect(target.getByRole("region", { name: "Selected file unified diff" })).toContainText("+new");
  await expect(target.getByRole("heading")).toBeInViewport();
  await expect(list.locator("[aria-current='location']")).toHaveAttribute("title", "file-40.txt");
  await expect(list.getByTitle("file-40.txt", { exact: true })).toBeInViewport();
  expect(requests.filter((request) => request.command === "git_diff").map((request) => request.args.path))
    .toEqual(["file-0.txt", "file-1.txt", "file-2.txt", "file-40.txt", "file-41.txt", "file-42.txt"]);
  // Back-scroll through a skipped area: it must lazy-load normally and reveal the current list entry.
  await panel.locator(".git-diff-slot[data-feed-path='file-10.txt']").evaluate((element) => {
    const panel = element.closest(".git-panel")!;
    panel.scrollTop += element.getBoundingClientRect().top - panel.getBoundingClientRect().top - 13;
  });
  await expect(page.getByRole("article", { name: "Diff for file-10.txt", exact: true })).toBeVisible();
  await expect(list.locator("[aria-current='location']")).toHaveAttribute("title", "file-10.txt");
  await expect(list.getByTitle("file-10.txt", { exact: true })).toBeInViewport();
  expect(await list.evaluate((element) => element.scrollTop)).toBeLessThan(600);
  await list.getByTitle("file-0.txt", { exact: true }).click();
  await expect(first.getByRole("heading")).toBeInViewport();
  await expect(first.getByLabel("Local review comment", { exact: true })).toHaveValue("Keep this unfinished note");
  expect(requests.filter((request) => request.command === "git_diff" && request.args.path === "file-0.txt")).toHaveLength(1);
  await page.getByRole("button", { name: "One file", exact: true }).click();
  await expect(page.locator("[data-diff-path]")).toHaveCount(1);
  await expect(first).toBeVisible();
});

test("manual scrolling cancels a pending distant jump and late previews cannot pull the reader back", async ({ page }) => {
  const { state, requests } = await setup(page);
  state.workspace.untracked = [];
  state.workspace.unstaged = Array.from({ length: 20 }, (_, index) => change(`file-${index}.txt`));
  state.overrideDiff = { patch: "@@ -1,100 +1,100 @@\n-old\n+new\n" + " context line\n".repeat(99) };
  state.delayedPath = "file-15.txt";
  state.delay = 900;
  await open(page);
  await page.getByRole("button", { name: "Continuous diffs", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Git workspace" });
  const list = panel.locator(".git-panel-files");
  await expect.poll(() => requests.filter((request) => request.command === "git_diff").length).toBe(3);
  await list.getByTitle("file-15.txt", { exact: true }).click();
  await expect.poll(() => requests.some((request) => request.args.path === "file-15.txt")).toBe(true);
  await panel.dispatchEvent("wheel", { deltaY: -300 });
  await panel.evaluate((element) => { element.scrollTop = 0; });
  await expect(list.locator("[aria-current='location']")).toHaveAttribute("title", "file-0.txt");
  await page.waitForTimeout(1100);
  expect(await panel.evaluate((element) => element.scrollTop)).toBe(0);
  await expect(list.locator("[aria-current='location']")).toHaveAttribute("title", "file-0.txt");
  await page.getByRole("button", { name: "Staged 1", exact: true }).click();
  await expect(page.locator("[data-diff-path]")).toHaveCount(1);
  await expect(list.locator("[aria-current='location']")).toHaveAttribute("title", "staged file.txt");
});

test("whole-file context requests are explicit, reversible, and display truncation", async ({ page }) => {
  const { state, requests } = await setup(page);
  await open(page);
  await page.getByRole("button", { name: /working file.txt/ }).click();
  await expect(page.getByRole("region", { name: "Selected file unified diff" })).toBeVisible();
  state.overrideDiff = { patch: "@@ -1,8 +1,8 @@\n prefix context\n-old\n+new\n suffix context\n", truncated: true };
  await page.getByLabel("Whole-file context", { exact: true }).check();
  await expect(page.getByRole("region", { name: "Selected file unified diff" })).toContainText("prefix context");
  await expect(page.getByText(/Partial preview/)).toBeVisible();
  expect(requests.at(-1)!.args.context).toBe("full");
  await page.getByLabel("Whole-file context", { exact: true }).uncheck();
  await expect.poll(() => requests.filter((request) => request.command === "git_diff").length).toBe(3);
  expect(requests.at(-1)!.args.context).toBeUndefined();
});

test("an old daemon cannot silently pretend a short diff contains the whole file", async ({ page }) => {
  const { state } = await setup(page);
  state.overrideDiff = { context: "changes" };
  await open(page);
  await page.getByRole("button", { name: /working file.txt/ }).click();
  await expect(page.getByRole("region", { name: "Selected file unified diff" })).toBeVisible();
  await page.getByLabel("Whole-file context", { exact: true }).check();
  await expect(page.getByRole("alert")).toContainText("does not support the requested file context");
  await expect(page.getByRole("region", { name: "Selected file unified diff" })).toHaveCount(0);
});

test("switching change views resets the continuous stream and ignores old in-flight files", async ({ page }) => {
  const { state, requests } = await setup(page);
  state.workspace.untracked = [];
  state.workspace.unstaged = Array.from({ length: 7 }, (_, index) => change(`file-${index}.txt`));
  state.delayedPath = "file-0.txt";
  state.delay = 600;
  await open(page);
  await page.getByRole("button", { name: "Continuous diffs", exact: true }).click();
  await expect.poll(() => requests.filter((request) => request.command === "git_diff").length).toBe(3);
  await page.getByRole("button", { name: "Staged 1", exact: true }).click();
  const card = page.getByRole("article", { name: "Diff for staged file.txt", exact: true });
  await expect(card.getByRole("region", { name: "Selected file unified diff" })).toContainText("+new staged");
  await page.waitForTimeout(700);
  await expect(page.locator("[data-diff-path]")).toHaveCount(1);
  expect(requests.filter((request) => request.command === "git_diff" && request.args.path === "file-3.txt")).toHaveLength(0);
});

test("untracked previews appear in Unstaged and retain line comments in the Untracked filter", async ({ page }) => {
  const { requests } = await setup(page);
  await open(page);
  await expect(page.getByRole("button", { name: "Unstaged 3", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Untracked 1", exact: true })).toBeVisible();
  await expect(page.getByTitle("new.txt", { exact: true })).toContainText("[untracked]");
  await page.getByTitle("new.txt", { exact: true }).click();
  const patch = page.getByRole("region", { name: "Selected file unified diff" });
  await expect(patch).toContainText("+new untracked contents");
  await expect(page.getByLabel("Whole-file context")).toHaveCount(0);
  expect(requests.filter((request) => request.command === "git_diff").at(-1)?.args.view).toBe("untracked");
  await page.getByRole("option", { name: "Added line new:1", exact: true }).click();
  await page.getByLabel("Local review comment", { exact: true }).fill("Why add this new file?");
  await page.getByRole("button", { name: "Save local comment", exact: true }).click();
  await page.getByRole("button", { name: "Untracked 1", exact: true }).click();
  await expect(page.getByTitle("working file.txt", { exact: true })).toHaveCount(0);
  await page.getByTitle("new.txt", { exact: true }).click();
  await expect(page.getByLabel("Local Git review comments")).toContainText("Why add this new file?");
  await page.getByRole("button", { name: "Quick ask about comment", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Review draft" })).toHaveValue(/"view":\s*"untracked"/);
  await expect(page.getByRole("textbox", { name: "Review draft" })).toHaveValue(/Why add this new file/);
  expect(requests.every((request) => ["git_workspace", "git_diff"].includes(request.command))).toBe(true);
  await page.getByRole("button", { name: "Staged 1", exact: true }).click();
  await expect(page.getByTitle("new.txt", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "PR comparison 1", exact: true }).click();
  await expect(page.getByTitle("new.txt", { exact: true })).toHaveCount(0);
});

test("mixed continuous diffs use each file's native view and clearly report unavailable untracked content", async ({ page }) => {
  const { state, requests } = await setup(page);
  await open(page);
  await page.getByRole("button", { name: "Continuous diffs", exact: true }).click();
  const added = page.getByRole("article", { name: "Diff for new.txt", exact: true });
  await expect(added.getByRole("region")).toContainText("+new untracked contents");
  await expect(page.getByRole("article", { name: "Diff for working file.txt", exact: true }).getByRole("region")).toContainText("+new unstaged");
  expect(requests.filter((request) => request.command === "git_diff").map((request) => [request.args.path, request.args.view]))
    .toEqual([["working file.txt", "unstaged"], ["line\nname.txt", "unstaged"], ["new.txt", "untracked"]]);
  state.overrideDiff = { patch: "", binary: true, unavailableReason: "Binary untracked file; text preview is unavailable." };
  await page.getByRole("button", { name: "Untracked 1", exact: true }).click();
  await expect(added).toContainText("Binary untracked file");
  await expect(added.getByRole("region")).toHaveCount(0);
  await expect(added.getByRole("button", { name: /Ask about/ })).toHaveCount(0);
});

test("line highlighting makes the forty-line note limit explicit without silently dropping selection", async ({ page }) => {
  const { state } = await setup(page);
  state.overrideDiff = { patch: "@@ -0,0 +1,41 @@\n" + Array.from({ length: 41 }, (_, index) => `+line ${index + 1}\n`).join("") };
  await open(page);
  await page.getByTitle("working file.txt", { exact: true }).click();
  await page.getByRole("option", { name: "Added line new:1", exact: true }).click();
  await page.getByRole("option", { name: "Added line new:41", exact: true }).click({ modifiers: ["Shift"] });
  await expect(page.locator(".git-diff-line[aria-selected='true']")).toHaveCount(41);
  await expect(page.getByText("Select 40 or fewer code lines to save one note.", { exact: false })).toBeVisible();
  await page.getByLabel("Local review comment", { exact: true }).fill("Review this range");
  await expect(page.getByRole("button", { name: "Save local comment", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Clear selection", exact: true }).click();
  await page.getByRole("option", { name: "Added line new:1", exact: true }).click();
  await page.getByRole("option", { name: "Added line new:40", exact: true }).click({ modifiers: ["Shift"] });
  await expect(page.locator(".git-diff-line[aria-selected='true']")).toHaveCount(40);
  await page.getByRole("button", { name: "Save local comment", exact: true }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("copilot-sessions.git-comments.v1")!)[0].locations.length)).toBe(40);
});

test.describe("mobile Git layout", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  const longBranch = "joklein/windows-driver-rust-integration-with-a-long-branch-name";
  const pathFor = (index: number) => `rust/crates/tunnel-tun-linux/src/very-long-module-name-${index}.rs`;
  async function mobileSetup(page: Page) {
    const state = await setup(page);
    state.state.workspace = snapshot({
      branch: longBranch, repoRoot: "Q:/gits/db/windows-driver-rust-integration",
      upstream: `refs/remotes/origin/${longBranch}`, base: `refs/remotes/origin/${longBranch}`,
      compare: Array.from({ length: 61 }, (_, index) => change(pathFor(index))),
      unstaged: [], staged: [], untracked: [],
    });
    state.state.overrideDiff = {
      patch: "@@ -20,40 +20,40 @@\n-old line\n+new line with a very long expression " + "X".repeat(180) + "\n" + " unchanged context\n".repeat(39),
      base: `refs/remotes/origin/${longBranch}`,
      repoRoot: state.state.workspace.repoRoot,
    };
    await open(page);
    return state;
  }

  test("comparison controls fit narrow screens and empty views have no phantom whitespace", async ({ page }) => {
    await mobileSetup(page);
    const panel = page.getByRole("dialog", { name: "Git workspace" });
    await expect(page.locator(".git-mobile-options")).not.toHaveAttribute("open");
    await expect(page.getByLabel("Comparison target")).toBeHidden();
    await expect(page.getByRole("combobox", { name: "Git change view" })).toBeVisible();
    await expect(page.locator(".git-panel-tabs")).toHaveCount(0);
    await expect(page.getByText("No files in this view.", { exact: true })).toHaveCount(1);
    const empty = (await page.getByText("No files in this view.", { exact: true }).boundingBox())!;
    const footer = (await panel.locator("footer").boundingBox())!;
    expect(footer.y - (empty.y + empty.height)).toBeLessThan(80);
    expect(footer.y).toBeGreaterThanOrEqual(empty.y + empty.height);
    await page.locator(".git-mobile-options summary").tap();
    const target = page.getByLabel("Comparison target");
    await expect(target).toBeVisible();
    for (const width of [320, 390, 540]) {
      await page.setViewportSize({ width, height: 844 });
      const box = (await target.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    }
    await target.selectOption("refs/heads/main");
    await expect(page.locator(".git-mobile-options")).not.toHaveAttribute("open");
    await expect(page.getByRole("combobox", { name: "Git change view" })).toBeVisible();
  });

  test("file navigation stays reachable during a long diff and the editor/footer never overlap", async ({ page }, testInfo) => {
    const { requests } = await mobileSetup(page);
    await page.getByRole("combobox", { name: "Git change view" }).selectOption("compare");
    const picker = page.getByRole("combobox", { name: "Choose file" });
    await picker.selectOption(pathFor(0));
    const panel = page.getByRole("dialog", { name: "Git workspace" });
    const diff = panel.getByRole("region", { name: "Selected file unified diff" });
    await expect(diff).toContainText("new line");
    expect(await diff.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await diff.evaluate((element) => { element.scrollLeft = 250; });
    expect(await panel.evaluate((element) => element.scrollLeft)).toBe(0);
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await panel.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(picker).toBeInViewport();
    await expect(page.getByRole("button", { name: "Next file", exact: true })).toBeInViewport();
    const diffBox = (await diff.boundingBox())!;
    const editorBox = (await panel.locator(".git-panel-comment-editor").boundingBox())!;
    const footerBox = (await panel.locator("footer").boundingBox())!;
    expect(editorBox.y).toBeGreaterThanOrEqual(diffBox.y + diffBox.height);
    expect(footerBox.y).toBeGreaterThanOrEqual(editorBox.y + editorBox.height);
    await page.getByRole("button", { name: "Next file", exact: true }).tap();
    await expect(picker).toHaveValue(pathFor(1));
    await expect(page.getByRole("heading", { name: pathFor(1), exact: true })).toBeInViewport();
    await picker.selectOption(pathFor(60));
    await expect(diff).toBeVisible();
    await expect(page.getByRole("button", { name: "Next file", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Previous file", exact: true }).tap();
    await expect(picker).toHaveValue(pathFor(59));
    expect(requests.filter((request) => request.command === "git_diff")).toHaveLength(4);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(page.locator(".git-panel-files")).toBeVisible();
    await expect(page.getByRole("heading", { name: pathFor(59), exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(picker).toHaveValue(pathFor(59));
    await page.setViewportSize({ width: 390, height: 460 });
    await expect(picker).toBeInViewport();
    await expect(page.getByRole("button", { name: "Close Git workspace" })).toBeInViewport();
    await page.setViewportSize({ width: 390, height: 844 });
    await panel.evaluate((element) => { element.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath("mobile-git-review.png") });
  });

  test("continuous mobile diffs use page scrolling and retain the file selector", async ({ page }) => {
    const { state, requests } = await mobileSetup(page);
    state.workspace.compare = Array.from({ length: 7 }, (_, index) => change(pathFor(index)));
    await page.getByRole("button", { name: "Refresh Git workspace" }).tap();
    await page.getByRole("combobox", { name: "Git change view" }).selectOption("compare");
    await page.getByRole("combobox", { name: "Diff layout" }).selectOption("continuous");
    await expect.poll(() => requests.filter((request) => request.command === "git_diff").length).toBe(3);
    const panel = page.getByRole("dialog", { name: "Git workspace" });
    await panel.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect.poll(() => requests.filter((request) => request.command === "git_diff").length).toBe(6);
    await expect(page.getByRole("combobox", { name: "Choose file" })).toBeInViewport();
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    const patch = panel.getByRole("region", { name: "Selected file unified diff" }).first();
    expect(await patch.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    await page.getByRole("combobox", { name: "Choose file" }).selectOption(pathFor(6));
    await expect(page.getByRole("combobox", { name: "Diff layout" })).toHaveValue("continuous");
    await expect(page.getByRole("article", { name: `Diff for ${pathFor(6)}`, exact: true }).getByRole("region")).toContainText("new line");
    await expect(page.getByRole("heading", { name: pathFor(6), exact: true })).toBeInViewport();
    await expect(page.getByRole("combobox", { name: "Choose file" })).toHaveValue(pathFor(6));
    await page.getByRole("button", { name: "Previous file", exact: true }).tap();
    await expect(page.getByRole("heading", { name: pathFor(5), exact: true })).toBeInViewport();
    await expect(page.getByRole("combobox", { name: "Diff layout" })).toHaveValue("continuous");
  });

  test("mobile comparison controls work by keyboard and close without hiding file navigation", async ({ page }) => {
    await mobileSetup(page);
    await page.getByRole("combobox", { name: "Git change view" }).selectOption("compare");
    await page.getByRole("combobox", { name: "Choose file" }).selectOption(pathFor(0));
    const summary = page.locator(".git-mobile-options summary");
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Comparison target")).toBeVisible();
    await summary.focus();
    await page.keyboard.press("Space");
    await expect(page.getByLabel("Comparison target")).toBeHidden();
    await expect(page.getByRole("combobox", { name: "Choose file" })).toBeVisible();
    await page.getByRole("button", { name: "Close Git workspace" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Git workspace" })).toHaveCount(0);
  });

  test("mobile Unstaged can review a new file even without any tracked edits", async ({ page }) => {
    const { state, requests } = await setup(page);
    state.workspace.unstaged = [];
    state.workspace.untracked = [change(pathFor(0), { kind: "untracked", status: "?", added: null, deleted: null })];
    await open(page);
    await expect(page.getByRole("combobox", { name: "Git change view" })).toHaveValue("unstaged");
    await expect(page.getByRole("option", { name: "Unstaged (1)", exact: true })).toHaveCount(1);
    const picker = page.getByRole("combobox", { name: "Choose file" });
    await picker.selectOption(pathFor(0));
    await expect(page.getByRole("region", { name: "Selected file unified diff" })).toContainText("+new untracked contents");
    expect(requests.filter((request) => request.command === "git_diff").at(-1)?.args.view).toBe("untracked");
    const panel = page.getByRole("dialog", { name: "Git workspace" });
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.getByRole("combobox", { name: "Diff layout" }).selectOption("continuous");
    await expect(page.getByRole("region", { name: "Selected file unified diff" })).toContainText("+new untracked contents");
    await expect(page.getByLabel("Whole-file context")).toHaveCount(0);
  });
});
