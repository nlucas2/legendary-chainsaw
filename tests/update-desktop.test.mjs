import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("desktop updater guards and workflow run against process/API/build mocks only", { skip: process.platform !== "win32" }, async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "desktop-update-test-"));
  try {
    const result = spawnSync("pwsh", [
      "-NoProfile", "-NonInteractive", "-File", path.resolve("tests", "update-desktop.tests.ps1"),
      "-UpdaterPath", path.resolve("scripts", "update-desktop.ps1"), "-FixtureRoot", fixture,
    ], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Updater safety scenarios passed/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
