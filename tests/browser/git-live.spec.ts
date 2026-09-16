import { test, expect } from "@playwright/test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

test("Git UI reads real staged, unstaged and PR diffs without changing repository state", async ({ page, request }) => {
  test.setTimeout(120_000);
  const cwd = await mkdtemp(path.join(tmpdir(), "copilot-git-view-"));
  let sessionId: string | undefined;
  const git = (...args: string[]) => execFileSync("git", ["--no-pager", "-c", `core.hooksPath=${path.join(cwd, "disabled-hooks")}`, "-C", cwd, ...args], {
    encoding: "utf8", windowsHide: true,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_"))),
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  async function command(name: string, args: Record<string, unknown> = {}) {
    const response = await request.post(`/api/${name}`, { data: { sessionId, ...args }, timeout: 60_000 });
    expect(response.ok(), `${name}: ${await response.text()}`).toBeTruthy();
    return response.json();
  }
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    for (const file of ["branch.txt", "staged.txt"]) await writeFile(path.join(cwd, file), "old\n");
    const originalLines = Array.from({ length: 50 }, (_, index) => `original line ${index + 1}`);
    await writeFile(path.join(cwd, "working.txt"), originalLines.join("\n") + "\n");
    git("add", ".");
    git("-c", "commit.gpgSign=false", "commit", "-qm", "Fixture base");
    git("switch", "-qc", "feature");
    await writeFile(path.join(cwd, "branch.txt"), "committed branch change\n");
    git("add", "branch.txt");
    git("-c", "commit.gpgSign=false", "commit", "-qm", "Fixture branch");
    git("branch", "--set-upstream-to=main", "feature");
    await writeFile(path.join(cwd, "staged.txt"), "staged change\n");
    git("add", "staged.txt");
    const changedLines = [...originalLines];
    changedLines[24] = "unstaged change";
    const workingContent = changedLines.join("\n") + "\n";
    await writeFile(path.join(cwd, "working.txt"), workingContent);
    await writeFile(path.join(cwd, "new.txt"), "untracked\n");
    const before = { head: git("rev-parse", "HEAD"), status: git("status", "--porcelain=v2", "-z"), index: await readFile(path.join(cwd, ".git", "index")) };
    sessionId = (await command("create_session", { cwd, model: "gpt-5.6-luna", reasoningEffort: "low" })).sessionId;
    expect((await command("git_repository")).isRepository).toBe(true);
    await page.goto(`/?session=${sessionId}`);
    await expect(page.locator(".parent-session-view .composer textarea")).toBeEnabled();
    await page.getByRole("button", { name: "Open Git workspace" }).click();
    const panel = page.getByRole("dialog", { name: "Git workspace" });
    await panel.getByRole("button", { name: /working\.txt/ }).click();
    await expect(panel.getByRole("region", { name: "Selected file unified diff" })).toContainText("+unstaged change");
    await expect(panel.getByRole("region", { name: "Selected file unified diff" })).not.toContainText("original line 50");
    await expect(panel.getByRole("button", { name: "Unstaged 2", exact: true })).toBeVisible();
    await panel.getByTitle("new.txt", { exact: true }).click();
    await expect(panel.getByRole("region", { name: "Selected file unified diff" })).toContainText("+untracked");
    await expect(panel.getByLabel("Whole-file context", { exact: true })).toHaveCount(0);
    const untracked = await command("git_diff", { view: "untracked", path: "new.txt" });
    expect(untracked.view).toBe("untracked");
    expect(untracked.kind).toBe("untracked");
    expect(untracked.patch).toContain("+untracked");
    expect(untracked.deleted).toBe(0);
    await panel.getByRole("button", { name: "Untracked 1", exact: true }).click();
    await panel.getByTitle("new.txt", { exact: true }).click();
    await expect(panel.getByRole("region", { name: "Selected file unified diff" })).toContainText("+untracked");
    await panel.getByRole("button", { name: "Unstaged 2", exact: true }).click();
    await panel.getByTitle("working.txt", { exact: true }).click();
    await expect(panel.getByRole("region", { name: "Selected file unified diff" })).toContainText("+unstaged change");
    await panel.getByLabel("Whole-file context", { exact: true }).check();
    await expect(panel.getByRole("region", { name: "Selected file unified diff" })).toContainText("original line 50");
    await expect(panel.getByRole("region", { name: "Selected file unified diff" })).toContainText("original line 1");
    const full = await command("git_diff", { view: "unstaged", path: "working.txt", context: "full" });
    expect(full.context).toBe("full");
    expect(full.fullContextComplete).toBe(true);
    expect(full.truncated).toBe(false);
    await panel.getByLabel("Whole-file context", { exact: true }).uncheck();
    await expect(panel.getByRole("region", { name: "Selected file unified diff" })).not.toContainText("original line 50");
    await panel.getByRole("button", { name: /^Staged / }).click();
    await panel.getByRole("button", { name: /staged\.txt/ }).click();
    await expect(panel.getByRole("region", { name: "Selected file unified diff" })).toContainText("+staged change");
    await panel.getByRole("button", { name: /^PR comparison / }).click();
    await panel.getByRole("button", { name: /branch\.txt/ }).click();
    await expect(panel.getByRole("region", { name: "Selected file unified diff" })).toContainText("+committed branch change");
    await expect(panel.getByText("Committed changes only.", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: /working\.txt/ })).toHaveCount(0);
    const invalid = await request.post("/api/git_diff", { data: { sessionId, cwd, view: "unstaged", path: "working.txt" } });
    expect(invalid.status()).toBe(400);
    expect(git("rev-parse", "HEAD")).toBe(before.head);
    expect(await readFile(path.join(cwd, ".git", "index"))).toEqual(before.index);
    expect(git("status", "--porcelain=v2", "-z")).toBe(before.status);
    expect(await readFile(path.join(cwd, "working.txt"), "utf8")).toBe(workingContent);
    expect(await readFile(path.join(cwd, "new.txt"), "utf8")).toBe("untracked\n");
  } finally {
    if (sessionId) await command("delete_session");
    await rm(cwd, { recursive: true, force: true });
  }
});
