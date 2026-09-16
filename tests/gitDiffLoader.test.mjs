import test from "node:test";
import assert from "node:assert/strict";
import { createGitDiffLoader } from "../src/lib/gitDiffLoader.ts";

test("continuous previews limit concurrent reads and cancel queued requests", async () => {
  const load = createGitDiffLoader(2);
  const started = [];
  const finish = [];
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const jobs = controllers.map((controller, index) => load(() => {
    started.push(index);
    return new Promise((resolve) => { finish[index] = resolve; });
  }, controller.signal));
  const cancelled = assert.rejects(jobs[2], /cancelled/);
  await Promise.resolve();
  assert.deepEqual(started, [0, 1]);
  controllers[2].abort(new Error("cancelled"));
  finish[0]("one");
  await jobs[0];
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 3]);
  finish[1]("two");
  finish[3]("four");
  assert.deepEqual(await Promise.all([jobs[1], jobs[3]]), ["two", "four"]);
  await cancelled;
});

test("failed reads release the slot and an already cancelled read never runs", async () => {
  const load = createGitDiffLoader(1);
  const signal = new AbortController().signal;
  const first = load(() => Promise.reject(new Error("failure")), signal);
  const next = load(() => Promise.resolve("next"), signal);
  await assert.rejects(first, /failure/);
  assert.equal(await next, "next");
  const aborted = new AbortController();
  aborted.abort(new Error("abort"));
  await assert.rejects(load(() => { throw new Error("must not run"); }, aborted.signal), /abort/);
});
