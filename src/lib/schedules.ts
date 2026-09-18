export type PromptSchedule =
  | { kind: "once"; at: string }
  | { kind: "daily"; time: string; timeZone: string };

export interface ScheduledRun {
  id: string;
  scheduledFor: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "completed" | "failed" | "uncertain";
  error: string | null;
}

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  sessionId: string | null;
  cwd: string;
  model: string | null;
  schedule: PromptSchedule;
  enabled: boolean;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  runs: ScheduledRun[];
  lastError?: string | null;
}

export type ScheduledTaskInput = Pick<ScheduledTask, "name" | "prompt" | "sessionId" | "cwd" | "model" | "schedule" | "enabled"> & { id?: string };

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

export function normalizeScheduledTask(value: unknown): ScheduledTask {
  if (!object(value) || typeof value.id !== "string" || !value.id
    || typeof value.name !== "string" || typeof value.prompt !== "string" || typeof value.cwd !== "string"
    || !(value.sessionId === null || typeof value.sessionId === "string")
    || !(value.model === null || typeof value.model === "string")
    || typeof value.enabled !== "boolean" || !(value.nextRunAt === null || timestamp(value.nextRunAt))
    || !timestamp(value.createdAt) || !timestamp(value.updatedAt) || !object(value.schedule)
    || !Array.isArray(value.runs) || value.runs.length > 20
    || !(value.lastError === undefined || value.lastError === null || typeof value.lastError === "string")) {
    throw new Error("The daemon returned invalid scheduled-task metadata.");
  }
  const schedule = value.schedule;
  let normalizedSchedule: PromptSchedule;
  if (schedule.kind === "once" && timestamp(schedule.at)) normalizedSchedule = { kind: "once", at: schedule.at };
  else if (schedule.kind === "daily" && typeof schedule.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)
    && typeof schedule.timeZone === "string") normalizedSchedule = { kind: "daily", time: schedule.time, timeZone: schedule.timeZone };
  else throw new Error("The daemon returned an unsupported schedule.");
  const runs: ScheduledRun[] = value.runs.map((run) => {
    if (!object(run) || typeof run.id !== "string" || !timestamp(run.scheduledFor) || !timestamp(run.startedAt)
      || !(run.finishedAt === null || timestamp(run.finishedAt))
      || !(run.status === "running" || run.status === "completed" || run.status === "failed" || run.status === "uncertain")
      || !(run.error === null || typeof run.error === "string")) throw new Error("The daemon returned invalid scheduled-run history.");
    return { id: run.id, scheduledFor: run.scheduledFor, startedAt: run.startedAt, finishedAt: run.finishedAt, status: run.status, error: run.error };
  });
  return {
    id: value.id, name: value.name, prompt: value.prompt, cwd: value.cwd, sessionId: value.sessionId,
    model: value.model, schedule: normalizedSchedule, enabled: value.enabled, nextRunAt: value.nextRunAt,
    createdAt: value.createdAt, updatedAt: value.updatedAt, runs, lastError: value.lastError,
  };
}

export function normalizeScheduledTasks(value: unknown): ScheduledTask[] {
  if (!object(value) || !Array.isArray(value.tasks) || value.tasks.length > 100) throw new Error("The daemon did not return a scheduled-task list.");
  const tasks = value.tasks.map(normalizeScheduledTask);
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) throw new Error("The daemon returned duplicate schedule IDs.");
  return tasks;
}

export function localDateTime(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

export function oneOffUtc(local: string, now = Date.now(), existingAt?: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) throw new Error("Choose a date and time.");
  // Unchanged edits preserve an overdue occurrence and its exact instant (including DST folds).
  if (timestamp(existingAt) && localDateTime(new Date(existingAt)) === local) return existingAt;
  const parsed = new Date(local);
  if (!Number.isFinite(parsed.getTime()) || localDateTime(parsed) !== local) {
    throw new Error("That local date/time does not exist. Choose another time.");
  }
  if (parsed.getTime() <= now) throw new Error("A one-off schedule must be in the future.");
  return parsed.toISOString();
}

export function validateScheduleInput(value: ScheduledTaskInput): void {
  if (!value.name.trim() || value.name.length > 100) throw new Error("Enter a task name of at most 100 characters.");
  if (!value.prompt.trim()) throw new Error("Enter the prompt or skill instructions to run.");
  if (value.prompt.includes("[replace with the skill name, repositories, projects, or other sources]")) {
    throw new Error("Replace the briefing template's sources with the skill or projects you want reviewed.");
  }
  if (new TextEncoder().encode(value.prompt).length > 32 * 1024) throw new Error("Scheduled prompts are limited to 32 KiB.");
  if (!value.cwd.trim()) throw new Error("Choose a working directory for the task.");
  if (value.schedule.kind === "daily") {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.schedule.time)) throw new Error("Choose a daily time.");
    try { new Intl.DateTimeFormat("en", { timeZone: value.schedule.timeZone }).format(); }
    catch { throw new Error("Enter a valid IANA time zone, such as America/Los_Angeles."); }
  } else if (!timestamp(value.schedule.at)) throw new Error("Choose a valid one-off date and time.");
}

export function scheduleLabel(schedule: PromptSchedule): string {
  return schedule.kind === "daily" ? `Daily at ${schedule.time} (${schedule.timeZone})`
    : `Once at ${new Date(schedule.at).toLocaleString()}`;
}

export const BRIEFING_PROMPT = `Prepare my daily briefing of changes since the previous briefing (or the past 24 hours on the first run).
Use the skills and data sources I specify here: [replace with the skill name, repositories, projects, or other sources].
Summarize important changes, actionable items, and anything needing my attention. Include links to evidence.
State the time range reviewed and any sources you could not access. Do not make changes or send messages on my behalf.`;
