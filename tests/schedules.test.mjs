import test from "node:test";
import assert from "node:assert/strict";
import { BRIEFING_PROMPT, localDateTime, normalizeScheduledTasks, oneOffUtc, validateScheduleInput } from "../src/lib/schedules.ts";

const task = {
  id: "task-1", name: "Daily briefing", prompt: "Review local changes.", sessionId: null, cwd: "Q:\\example", model: null,
  schedule: { kind: "daily", time: "09:15", timeZone: "America/Los_Angeles" }, enabled: true,
  nextRunAt: "2030-01-02T17:15:00Z", createdAt: "2030-01-01T01:00:00Z", updatedAt: "2030-01-01T01:00:00Z", runs: [],
};

test("scheduled tasks preserve explicit source prompt, session binding and run outcomes", () => {
  const [normalized] = normalizeScheduledTasks({ tasks: [task] });
  assert.equal(normalized.sessionId, null);
  assert.equal(normalized.prompt, task.prompt);
  const completed = { ...task, sessionId: "briefing", runs: [{
    id: "run", scheduledFor: task.nextRunAt, startedAt: task.nextRunAt, finishedAt: "2030-01-02T17:18:00Z",
    status: "completed", error: null,
  }] };
  assert.equal(normalizeScheduledTasks({ tasks: [completed] })[0].runs[0].status, "completed");
  for (const invalid of [{}, { tasks: null }, { tasks: [task, task] }, { tasks: [{ ...task, schedule: { kind: "cron" } }] },
    { tasks: [{ ...task, runs: [{ status: "success" }] }] }, { tasks: [{ ...task, enabled: "true" }] }]) {
    assert.throws(() => normalizeScheduledTasks(invalid));
  }
});

test("schedule validation requires instructions, a usable directory, timezone and time", () => {
  assert.doesNotThrow(() => validateScheduleInput(task));
  for (const patch of [
    { name: "" }, { prompt: " " }, { cwd: " " }, { prompt: "x".repeat(32769) },
    { prompt: BRIEFING_PROMPT }, { schedule: { kind: "daily", time: "25:00", timeZone: "UTC" } },
    { schedule: { kind: "daily", time: "09:00", timeZone: "Invalid/Timezone" } },
  ]) assert.throws(() => validateScheduleInput({ ...task, ...patch }));
  assert.doesNotThrow(() => validateScheduleInput({ ...task, schedule: { kind: "once", at: "2030-01-01T01:00:00Z" } }));
});

test("one-off local input converts exactly to an instant and rejects invalid/past dates", () => {
  const date = new Date(2030, 5, 4, 9, 30);
  assert.equal(localDateTime(date), "2030-06-04T09:30");
  assert.equal(oneOffUtc("2030-06-04T09:30", 0), date.toISOString());
  for (const invalid of ["", "2030-02-30T09:00", "2030-01-01T25:00", "2020-01-01T00:00Z"]) {
    assert.throws(() => oneOffUtc(invalid, 0));
  }
  assert.throws(() => oneOffUtc("2000-01-01T09:00"), /future/);
});

test("editing an unchanged one-off preserves an overdue instant rather than rescheduling it", () => {
  const original = "2020-11-01T06:30:12Z";
  const local = localDateTime(new Date(original));
  assert.equal(oneOffUtc(local, Date.now(), original), original);
  assert.throws(() => oneOffUtc("2001-01-01T09:00", Date.now(), original), /future/);
});
