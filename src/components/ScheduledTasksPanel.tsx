import { useEffect, useId, useRef, useState } from "react";
import { CalendarClock, Plus, RefreshCw, X } from "lucide-react";
import { daemonInvoke } from "../lib/daemon";
import { createSingleflightReader } from "../lib/context";
import {
  BRIEFING_PROMPT, localDateTime, normalizeScheduledTask, normalizeScheduledTasks, oneOffUtc,
  scheduleLabel, validateScheduleInput, type ScheduledTask, type ScheduledTaskInput,
} from "../lib/schedules";
import type { SessionSummary } from "../lib/types";
import "./scheduled-tasks.css";

export function ScheduledTasksPanel({ sessions, defaultCwd, onClose, onOpenSession }: {
  sessions: SessionSummary[];
  defaultCwd: string;
  onClose: () => void;
  onOpenSession: (sessionId: string) => Promise<void>;
}) {
  const [tasks, setTasks] = useState<ScheduledTask[] | null>(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<{ task?: ScheduledTask } | null>(null);
  const reader = useRef<ReturnType<typeof createSingleflightReader<ScheduledTask[]>> | undefined>(undefined);
  const latest = useRef<ScheduledTask[]>([]);
  const pending = useRef(false);
  const mounted = useRef(false);
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement;
    root.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const request = createSingleflightReader(async (signal) =>
      normalizeScheduledTasks(await daemonInvoke("list_scheduled_tasks", {}, signal)), {
      loading: () => setLoading(true),
      value: (value) => { latest.current = value; setTasks(value); setLoading(false); setLoadError(""); },
      error: (cause) => { setLoading(false); setLoadError(`Could not read schedules: ${String(cause)}`); },
    });
    reader.current = request;
    void request.refresh();
    const interval = setInterval(() => { if (!document.hidden && !pending.current) void request.refresh(); }, 5000);
    return () => {
      mounted.current = false;
      clearInterval(interval);
      request.dispose();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  async function action(label: string, run: () => Promise<ScheduledTask[]>, message: string) {
    if (pending.current) return;
    pending.current = true;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      const next = await run();
      if (!mounted.current) return;
      reader.current?.replace(next);
      setNotice(message);
      setEditing(null);
    } catch (cause) {
      if (mounted.current) setError(String(cause));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy("");
    }
  }
  function runAction(label: string, run: () => Promise<ScheduledTask[]>, message: string) {
    void action(label, run, message);
  }
  const replace = (next: ScheduledTask) => {
    const exists = latest.current.some((task) => task.id === next.id);
    return exists ? latest.current.map((task) => task.id === next.id ? next : task) : [next, ...latest.current];
  };
  return <div className="scheduled-tasks-backdrop">
    <section ref={root} className="scheduled-tasks-panel" role="dialog" aria-modal="true" aria-label="Scheduled tasks"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); if (!busy) onClose(); }
        if (event.key === "Tab") {
          const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex='0']",
          )).filter((control) => control.getClientRects().length > 0);
          if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls[controls.length - 1]?.focus(); }
          if (!event.shiftKey && document.activeElement === controls[controls.length - 1]) { event.preventDefault(); controls[0]?.focus(); }
        }
      }}>
      <header>
        <h2><CalendarClock size={19} />Scheduled tasks</h2>
        <button type="button" aria-label="Close scheduled tasks" disabled={!!busy} onClick={onClose}><X size={18} /></button>
      </header>
      <div className="scheduled-tasks-content">
        <p className="scheduled-hint">Run a prompt once or daily, in a dedicated ongoing conversation or an existing session. The daemon must be running; after sleep or downtime, one missed run catches up—not every missed day.</p>
        <p className="scheduled-hint">Normal Copilot tool permissions still apply. A run may wait for your approval. Schedules do not wake the computer, bypass approvals, or interrupt a busy conversation.</p>
        <div className="scheduled-toolbar">
          <button type="button" disabled={tasks === null || !!busy || !!editing} onClick={() => setEditing({})}><Plus size={15} />New scheduled task</button>
          <button type="button" disabled={!!busy || loading} onClick={() => void reader.current?.refresh()}><RefreshCw size={15} />Refresh schedules</button>
        </div>
        {loading && tasks === null && <p role="status">Loading schedules...</p>}
        {loadError && <p role="alert" className="scheduled-error">{loadError}</p>}
        {error && <p role="alert" className="scheduled-error">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {editing && <ScheduleEditor key={editing.task?.id ?? "new"} task={editing.task} sessions={sessions}
          defaultCwd={defaultCwd} busy={!!busy} onCancel={() => setEditing(null)}
          onSave={async (input) => {
            const current = latest.current.find((task) => task.id === input.id);
            if (input.enabled && current?.runs[0]?.status === "uncertain" && !current.enabled
              && !window.confirm("The previous run may already have been delivered. Have you inspected its conversation and do you want to allow another run?")) return;
            await action("save", async () => replace(normalizeScheduledTask(await daemonInvoke("save_scheduled_task", input))),
              input.enabled ? "Schedule saved and enabled. It will run automatically at the scheduled time." : "Schedule saved paused.");
          }} />}
        {!editing && tasks?.length === 0 && <p>No scheduled tasks yet. Add a briefing prompt to get started.</p>}
        {!editing && tasks?.map((task) => {
          const running = task.runs.some((run) => run.status === "running");
          const needsReview = !task.enabled && task.runs[0]?.status === "uncertain";
          const confirmUncertain = () => task.runs[0]?.status !== "uncertain"
            || window.confirm("The previous run may already have been delivered. Have you inspected its conversation and do you want to allow another run?");
          return <article key={task.id} className="scheduled-task" aria-label={`Scheduled task ${task.name}`}>
            <div className="scheduled-task-heading"><h3>{task.name}</h3><span>{running ? "Running" : task.enabled ? "Enabled" : "Paused"}</span></div>
            <p>{scheduleLabel(task.schedule)}</p>
            <p className="scheduled-hint">Next: {task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : "No upcoming run"} · {task.sessionId ? "Continuing in the same conversation" : "Creates a dedicated session on its first run"}</p>
            {task.lastError && <p className="scheduled-error">{task.lastError}</p>}
            {task.runs[0]?.status === "uncertain" && <p className="scheduled-error">The previous run was interrupted and its delivery is uncertain. Inspect the conversation before resuming or running again to avoid duplicate work.{needsReview && " Use Enable schedule after reviewing before requesting Run now."}</p>}
            <div className="scheduled-toolbar">
              <button type="button" disabled={!!busy || running} onClick={() => setEditing({ task })}>Edit schedule</button>
              <button type="button" disabled={!!busy} onClick={() => {
                if (!task.enabled && !confirmUncertain()) return;
                runAction(task.id,
                async () => replace(normalizeScheduledTask(await daemonInvoke("set_scheduled_task_enabled", { id: task.id, enabled: !task.enabled }))),
                task.enabled ? "Schedule paused. Any current run is unchanged." : "Schedule enabled; one missed run can catch up.");
              }}>{task.enabled ? "Pause schedule" : "Enable schedule"}</button>
              <button type="button" disabled={!!busy || running || needsReview} onClick={() => {
                if (!confirmUncertain()) return;
                runAction(task.id,
                async () => replace(normalizeScheduledTask(await daemonInvoke("run_scheduled_task", { id: task.id }))),
                "Run requested. Its result will appear in the task's conversation.");
              }}>Run now</button>
              {task.sessionId && <button type="button" disabled={!!busy} onClick={() => {
                void onOpenSession(task.sessionId!).catch((cause) => setError(`Could not open task conversation: ${String(cause)}`));
              }}>Open conversation</button>}
              <button type="button" disabled={!!busy} onClick={() => {
                if (!window.confirm(`Delete schedule "${task.name}"? Its conversation and any current run are not deleted.`)) return;
                runAction(task.id, async () => {
                  await daemonInvoke("delete_scheduled_task", { id: task.id });
                  return latest.current.filter((item) => item.id !== task.id);
                }, "Schedule deleted. Its conversation is unchanged.");
              }}>Delete schedule</button>
            </div>
            <details><summary>Prompt and recent runs ({task.runs.length})</summary>
              <pre>{task.prompt}</pre>
              {!task.runs.length && <p>No runs yet.</p>}
              {task.runs.map((run) => <div className="scheduled-run" key={run.id}>
                <strong>{run.status}</strong><span>{new Date(run.startedAt).toLocaleString()}</span>
                <small>Scheduled for {new Date(run.scheduledFor).toLocaleString()}{run.finishedAt && ` · Finished ${new Date(run.finishedAt).toLocaleString()}`}</small>
                {run.error && <p className="scheduled-error">{run.error}</p>}
              </div>)}
            </details>
          </article>;
        })}
      </div>
    </section>
  </div>;
}

function ScheduleEditor({ task, sessions, defaultCwd, busy, onSave, onCancel }: {
  task?: ScheduledTask;
  sessions: SessionSummary[];
  defaultCwd: string;
  busy: boolean;
  onSave: (value: ScheduledTaskInput) => Promise<void>;
  onCancel: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(task?.name ?? "Daily briefing");
  const [prompt, setPrompt] = useState(task?.prompt ?? "");
  const [target, setTarget] = useState(task?.sessionId ?? "");
  const [cwd, setCwd] = useState(task?.cwd ?? defaultCwd);
  const [model, setModel] = useState(task?.model ?? "");
  const [kind, setKind] = useState(task?.schedule.kind ?? "daily");
  const [time, setTime] = useState(task?.schedule.kind === "daily" ? task.schedule.time : "09:00");
  const [timeZone, setTimeZone] = useState(task?.schedule.kind === "daily" ? task.schedule.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [once, setOnce] = useState(localDateTime(task?.schedule.kind === "once" ? new Date(task.schedule.at) : new Date(Date.now() + 3600000)));
  const [enabled, setEnabled] = useState(task?.enabled ?? true);
  const [error, setError] = useState("");
  const targets = sessions.some((session) => session.sessionId === target) || !target ? sessions
    : [...sessions, { sessionId: target, title: `Session ${target}`, archived: false, cwd }];
  return <form className="schedule-editor" aria-label="Schedule editor" onSubmit={async (event) => {
    event.preventDefault();
    if (busy) return;
    try {
      const input: ScheduledTaskInput = {
        ...(task ? { id: task.id } : {}), name: name.trim(), prompt: prompt.trim(), sessionId: target || null,
        cwd: cwd.trim(), model: model.trim() || null, enabled,
        schedule: kind === "daily" ? { kind, time, timeZone: timeZone.trim() }
          : { kind: "once", at: oneOffUtc(once, Date.now(), task?.schedule.kind === "once" ? task.schedule.at : undefined) },
      };
      validateScheduleInput(input);
      setError("");
      await onSave(input);
    } catch (cause) { setError(String(cause)); }
  }}>
    <h3>{task ? "Edit scheduled task" : "New scheduled task"}</h3>
    <fieldset disabled={busy}>
      <label htmlFor={`${id}-name`}>Task name</label><input id={`${id}-name`} value={name} maxLength={100} onChange={(event) => setName(event.target.value)} autoFocus />
      <label htmlFor={`${id}-prompt`}>Prompt or skill instructions</label>
      <textarea id={`${id}-prompt`} value={prompt} rows={6} onChange={(event) => setPrompt(event.target.value)} placeholder="Use the [skill name] skill to prepare a briefing of overnight changes in..." />
      {!task && <button type="button" onClick={() => setPrompt(BRIEFING_PROMPT)}>Use briefing template</button>}
      <p className="scheduled-hint">Specify the skill and sources to review. This exact text becomes a normal Copilot prompt, not a terminal command. Choose what the agent may do explicitly.</p>
      <label htmlFor={`${id}-target`}>Conversation</label>
      <select id={`${id}-target`} value={target} disabled={!!task?.sessionId} onChange={(event) => {
        setTarget(event.target.value);
        const chosen = sessions.find((session) => session.sessionId === event.target.value);
        if (chosen?.cwd) setCwd(chosen.cwd);
      }}>
        <option value="">Create a dedicated session on first run</option>
        {targets.map((session) => <option key={session.sessionId} value={session.sessionId}>{session.title}{session.archived ? " (archived)" : ""}</option>)}
      </select>
      <label htmlFor={`${id}-cwd`}>Working directory</label><input id={`${id}-cwd`} value={cwd} onChange={(event) => setCwd(event.target.value)} readOnly={!!target} />
      {!target && <><label htmlFor={`${id}-model`}>Model (optional)</label><input id={`${id}-model`} value={model} onChange={(event) => setModel(event.target.value)} placeholder="Use the runtime default" /></>}
      <label htmlFor={`${id}-kind`}>Schedule</label><select id={`${id}-kind`} value={kind} onChange={(event) => setKind(event.target.value === "once" ? "once" : "daily")}>
        <option value="daily">Daily</option><option value="once">One-off</option>
      </select>
      {kind === "daily" ? <div className="schedule-time-row">
        <label>Time<input type="time" value={time} onChange={(event) => setTime(event.target.value)} /></label>
        <label>Time zone<input value={timeZone} onChange={(event) => setTimeZone(event.target.value)} placeholder="America/Los_Angeles" /></label>
      </div> : <label>Run at (your local time)<input type="datetime-local" value={once} onChange={(event) => setOnce(event.target.value)} /></label>}
      <label className="schedule-enabled"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />Enable automatic runs</label>
      <p className="scheduled-hint">One missed occurrence catches up when available. Busy sessions wait; normal approvals remain required. Saving an enabled schedule authorizes this prompt to run automatically.</p>
      {error && <p role="alert" className="scheduled-error">{error}</p>}
      <div className="scheduled-toolbar"><button type="submit">{busy ? "Saving..." : "Save schedule"}</button><button type="button" onClick={onCancel}>Cancel edit</button></div>
    </fieldset>
  </form>;
}
