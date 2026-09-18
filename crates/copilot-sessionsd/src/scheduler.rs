//! Durable daemon-owned prompt scheduling. A claim is saved before any side effect.
use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Datelike, LocalResult, NaiveDate, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use copilot_sessions_core::{ScheduledDelivery, ServiceError, SessionService};
use futures_util::FutureExt;
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;
use uuid::Uuid;

type Result<T> = std::result::Result<T, ServiceError>;
const MAX_TASKS: usize = 100;
const MAX_RUNS: usize = 20;
const MAX_STORE_BYTES: u64 = 32 * 1024 * 1024;
const INTERRUPTED: &str = "Daemon stopped before completion was recorded. Inspect the conversation, then explicitly resume; delivery may already have occurred.";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Schedule {
    Once {
        at: String,
    },
    Daily {
        time: String,
        #[serde(rename = "timeZone")]
        time_zone: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Running,
    Completed,
    Failed,
    Uncertain,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduledRun {
    id: String,
    scheduled_for: DateTime<Utc>,
    started_at: DateTime<Utc>,
    finished_at: Option<DateTime<Utc>>,
    status: RunStatus,
    error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    message_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduledTask {
    id: String,
    name: String,
    prompt: String,
    session_id: Option<String>,
    cwd: String,
    model: Option<String>,
    schedule: Schedule,
    enabled: bool,
    next_run_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    runs: Vec<ScheduledRun>,
    #[serde(default)]
    last_error: Option<String>,
}

// A stale editor can still submit null after the first run binds a dedicated
// target. Once bound, null/omitted preserves the binding and changes are refused.
#[derive(Clone, Debug, Default)]
pub enum TargetUpdate {
    #[default]
    Unchanged,
    Set(Option<String>),
}

fn target_update<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<TargetUpdate, D::Error> {
    Ok(TargetUpdate::Set(Option::<String>::deserialize(d)?))
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveScheduledTask {
    id: Option<String>,
    name: String,
    prompt: String,
    #[serde(default, deserialize_with = "target_update")]
    session_id: TargetUpdate,
    cwd: String,
    model: Option<String>,
    schedule: Schedule,
    enabled: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    task: ScheduledTask,
    run_now: Option<DateTime<Utc>>,
    #[serde(default)]
    review_required: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Store {
    version: u32,
    tasks: Vec<Record>,
}

impl Default for Store {
    fn default() -> Self {
        Self {
            version: 1,
            tasks: vec![],
        }
    }
}

struct State {
    store: Store,
    fault: Option<String>,
    workers: HashSet<String>,
}

trait Clock: Send + Sync {
    fn now(&self) -> DateTime<Utc>;
}
struct WallClock;
impl Clock for WallClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
}

#[async_trait]
trait Runtime: Send + Sync {
    async fn validate_target(&self, id: &str) -> Result<()>;
    async fn availability(&self, id: Option<&str>) -> Result<Option<String>>;
    async fn create(&self, task: &ScheduledTask) -> Result<String>;
    async fn deliver(
        &self,
        id: String,
        prompt: String,
        source: String,
    ) -> Result<ScheduledDelivery>;
}

struct CopilotRuntime(Arc<SessionService>);
#[async_trait]
impl Runtime for CopilotRuntime {
    async fn validate_target(&self, id: &str) -> Result<()> {
        self.0.validate_scheduled_target(id).await
    }
    async fn availability(&self, id: Option<&str>) -> Result<Option<String>> {
        self.0.scheduled_availability(id).await
    }
    async fn create(&self, task: &ScheduledTask) -> Result<String> {
        self.0
            .create_scheduled_session(&task.name, task.cwd.clone(), task.model.clone())
            .await
    }
    async fn deliver(
        &self,
        id: String,
        prompt: String,
        source: String,
    ) -> Result<ScheduledDelivery> {
        self.0.deliver_scheduled_prompt(id, prompt, source).await
    }
}

pub struct Scheduler {
    path: PathBuf,
    state: Mutex<State>,
    runtime: Arc<dyn Runtime>,
    clock: Arc<dyn Clock>,
    wake: Notify,
    _owner: Option<File>,
}

impl Scheduler {
    pub fn open(service: Arc<SessionService>) -> Arc<Self> {
        Self::load(
            service.data_dir().join("schedules.json"),
            Arc::new(CopilotRuntime(service)),
            Arc::new(WallClock),
        )
    }

    fn load(path: PathBuf, runtime: Arc<dyn Runtime>, clock: Arc<dyn Clock>) -> Arc<Self> {
        let mut owner = None;
        let loaded = (|| -> Result<Store> {
            let lock = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(path.with_extension("lock"))
                .map_err(persistence)?;
            lock.try_lock().map_err(persistence)?;
            owner = Some(lock);
            let mut store = match std::fs::metadata(&path) {
                Ok(meta) if meta.len() > MAX_STORE_BYTES => {
                    return Err(persistence("Schedule store exceeds size limit"));
                }
                Ok(_) => {
                    serde_json::from_slice::<Store>(&std::fs::read(&path).map_err(persistence)?)
                        .map_err(persistence)?
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Store::default(),
                Err(error) => return Err(persistence(error)),
            };
            validate_store(&store)?;
            let mut interrupted = false;
            for record in &mut store.tasks {
                for run in &mut record.task.runs {
                    if run.status == RunStatus::Running {
                        interrupted = true;
                        run.status = RunStatus::Uncertain;
                        run.finished_at = Some(clock.now());
                        run.error = Some(INTERRUPTED.into());
                        record.task.enabled = false;
                        record.task.last_error = Some(INTERRUPTED.into());
                        record.task.updated_at = clock.now();
                        record.run_now = None;
                        record.review_required = true;
                    }
                }
            }
            if interrupted {
                write_store(&path, &store)?;
            }
            Ok(store)
        })();
        let (store, fault) = match loaded {
            Ok(store) => (store, None),
            Err(error) => {
                tracing::error!(%error, "scheduled tasks are unavailable; store was not reset");
                (Store::default(), Some(error.to_string()))
            }
        };
        Arc::new(Self {
            path,
            state: Mutex::new(State {
                store,
                fault,
                workers: HashSet::new(),
            }),
            runtime,
            clock,
            wake: Notify::new(),
            _owner: owner,
        })
    }

    pub fn start(self: &Arc<Self>) -> SchedulerLoop {
        let scheduler = Arc::clone(self);
        SchedulerLoop(tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(5));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! { _ = interval.tick() => {}, _ = scheduler.wake.notified() => {} }
                scheduler.tick();
            }
        }))
    }

    pub fn list(&self) -> Result<Vec<ScheduledTask>> {
        let state = self.state.lock().expect("schedule state poisoned");
        healthy(&state)?;
        Ok(state.store.tasks.iter().map(|r| r.task.clone()).collect())
    }

    pub async fn save(&self, request: SaveScheduledTask) -> Result<ScheduledTask> {
        validate_input(&request)?;
        if let TargetUpdate::Set(Some(id)) = &request.session_id {
            self.runtime.validate_target(id).await?;
        }
        let now = self.clock.now();
        let mut state = self.state.lock().expect("schedule state poisoned");
        healthy(&state)?;
        let mut candidate = state.store.clone();
        let existing = match &request.id {
            Some(id) => Some(index(&candidate, id)?),
            None => None,
        };
        if let Some(i) = existing
            && (state.workers.contains(&candidate.tasks[i].task.id) || running(&candidate.tasks[i]))
        {
            return Err(ServiceError::SessionProcessing(
                "scheduled task; pause or wait before editing".into(),
            ));
        }
        let previous = existing.map(|i| &candidate.tasks[i].task);
        let schedule_changed = previous.is_none_or(|old| old.schedule != request.schedule);
        if schedule_changed
            && let Schedule::Once { at } = &request.schedule
            && utc_at(at)? <= now
        {
            return Err(invalid("A new one-off time must be in the future"));
        }
        let target = match (
            previous.and_then(|p| p.session_id.clone()),
            request.session_id,
        ) {
            (Some(bound), TargetUpdate::Set(Some(id))) if id != bound => {
                return Err(invalid(
                    "A bound scheduled task cannot change its target session",
                ));
            }
            (Some(bound), _) => Some(bound),
            (None, TargetUpdate::Set(id)) => id,
            (None, TargetUpdate::Unchanged) => None,
        };
        let next = if schedule_changed {
            request.schedule.next_after(now)?
        } else {
            previous.and_then(|p| p.next_run_at)
        };
        let review_required =
            existing.is_some_and(|i| candidate.tasks[i].review_required) && !request.enabled;
        let task = ScheduledTask {
            id: request.id.unwrap_or_else(|| Uuid::new_v4().to_string()),
            name: request.name.trim().into(),
            prompt: request.prompt,
            session_id: target,
            cwd: request.cwd,
            model: request.model.filter(|s| !s.is_empty()),
            schedule: request.schedule,
            enabled: request.enabled,
            next_run_at: next,
            created_at: previous.map_or(now, |p| p.created_at),
            updated_at: now,
            runs: previous.map_or_else(Vec::new, |p| p.runs.clone()),
            last_error: if review_required {
                previous.and_then(|p| p.last_error.clone())
            } else {
                None
            },
        };
        match existing {
            Some(i) => {
                candidate.tasks[i].task = task.clone();
                candidate.tasks[i].review_required = review_required;
                if !task.enabled {
                    candidate.tasks[i].run_now = None;
                }
            }
            None => {
                if candidate.tasks.len() >= MAX_TASKS {
                    return Err(invalid("At most 100 scheduled tasks are allowed"));
                }
                candidate.tasks.push(Record {
                    task: task.clone(),
                    run_now: None,
                    review_required: false,
                });
            }
        }
        self.commit(&mut state, candidate)?;
        self.wake.notify_one();
        Ok(task)
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<ScheduledTask> {
        let task = self.edit(id, |record, now| {
            record.task.enabled = enabled;
            record.task.updated_at = now;
            if enabled {
                record.review_required = false;
                record.task.last_error = None;
            } else if !record.review_required {
                record.task.last_error = None;
            }
            if !enabled {
                record.run_now = None;
            }
            // Keep overdue due dates: explicit resume allows exactly one catch-up.
            Ok(())
        })?;
        self.wake.notify_one();
        Ok(task)
    }

    pub fn run_now(&self, id: &str) -> Result<ScheduledTask> {
        let task = self.edit(id, |record, _| {
            if running(record) || record.run_now.is_some() {
                return Err(ServiceError::SessionProcessing(
                    "scheduled task already requested or running".into(),
                ));
            }
            if record.review_required {
                return Err(invalid(
                    "Review the uncertain run and explicitly resume the task before Run now",
                ));
            }
            record.run_now = Some(self.clock.now());
            record.task.last_error =
                Some("Run now requested; waiting for an idle, available target".into());
            Ok(())
        })?;
        self.wake.notify_one();
        Ok(task)
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let mut state = self.state.lock().expect("schedule state poisoned");
        healthy(&state)?;
        let mut candidate = state.store.clone();
        let i = index(&candidate, id)?;
        candidate.tasks.remove(i);
        self.commit(&mut state, candidate)
    }

    fn edit(
        &self,
        id: &str,
        update: impl FnOnce(&mut Record, DateTime<Utc>) -> Result<()>,
    ) -> Result<ScheduledTask> {
        let mut state = self.state.lock().expect("schedule state poisoned");
        healthy(&state)?;
        let mut candidate = state.store.clone();
        let i = index(&candidate, id)?;
        update(&mut candidate.tasks[i], self.clock.now())?;
        let result = candidate.tasks[i].task.clone();
        self.commit(&mut state, candidate)?;
        Ok(result)
    }

    fn commit(&self, state: &mut State, candidate: Store) -> Result<()> {
        healthy(state)?;
        if let Err(error) = write_store(&self.path, &candidate) {
            state.fault = Some(error.to_string());
            return Err(error);
        }
        state.store = candidate;
        Ok(())
    }

    fn tick(self: &Arc<Self>) {
        let jobs = {
            let mut state = self.state.lock().expect("schedule state poisoned");
            if healthy(&state).is_err() {
                return;
            }
            let due = state
                .store
                .tasks
                .iter()
                .filter(|r| due(r, self.clock.now()) && !state.workers.contains(&r.task.id))
                .map(|r| r.task.clone())
                .collect::<Vec<_>>();
            state.workers.extend(due.iter().map(|task| task.id.clone()));
            due
        };
        for task in jobs {
            let scheduler = Arc::clone(self);
            tokio::spawn(async move {
                let id = task.id.clone();
                let result = std::panic::AssertUnwindSafe(scheduler.work(task))
                    .catch_unwind()
                    .await;
                if result.is_err() {
                    tracing::error!(task_id = %id, "scheduled worker panicked");
                    scheduler.record_outcome(
                        &id,
                        ScheduledDelivery::Uncertain(
                            "Scheduler worker interrupted; review before resuming".into(),
                        ),
                    );
                }
                scheduler
                    .state
                    .lock()
                    .expect("schedule state poisoned")
                    .workers
                    .remove(&id);
            });
        }
    }

    async fn work(&self, snapshot: ScheduledTask) {
        let availability = self
            .runtime
            .availability(snapshot.session_id.as_deref())
            .await;
        let reason = match availability {
            Ok(None) => None,
            Ok(reason) => reason,
            Err(error) => Some(error.to_string()),
        };
        if let Some(reason) = reason {
            self.blocked(&snapshot.id, reason);
            return;
        }
        let Some(task) = self.claim(&snapshot.id).unwrap_or_else(|error| {
            tracing::error!(%error, "could not claim scheduled run");
            None
        }) else {
            return;
        };
        let target = match task.session_id.clone() {
            Some(id) => id,
            None => match self.runtime.create(&task).await {
                Ok(id) => {
                    // Save the reusable target before sending even the first prompt.
                    if let Err(error) = self.bind(&task.id, &id) {
                        tracing::error!(task_id = %task.id, session_id = %id, %error,
                            "scheduled session binding could not be saved; prompt suppressed");
                        return;
                    }
                    id
                }
                Err(error) => {
                    let outcome = if retryable(&error) {
                        ScheduledDelivery::Deferred(error.to_string())
                    } else {
                        ScheduledDelivery::Uncertain(format!(
                            "Session creation could not be confirmed: {error}"
                        ))
                    };
                    self.record_outcome(&task.id, outcome);
                    return;
                }
            },
        };
        // Deleting after a claim must not cancel an already submitted prompt,
        // but suppress it when deletion happened during initialization.
        if !self.can_dispatch(&task.id) {
            return;
        }
        let source = match Uuid::parse_str(&task.id) {
            Ok(id) => format!("schedule-{}", id.as_u128()),
            Err(error) => {
                self.record_outcome(
                    &task.id,
                    ScheduledDelivery::Failed {
                        message_id: String::new(),
                        error: format!("Invalid scheduled task identity: {error}"),
                    },
                );
                return;
            }
        };
        let outcome = match self.runtime.deliver(target, task.prompt, source).await {
            Ok(outcome) => outcome,
            Err(error)
                if retryable(&error)
                    || matches!(&error, ServiceError::Copilot(error) if error.is_transport_failure()) =>
            {
                ScheduledDelivery::Deferred(error.to_string())
            }
            Err(error) => ScheduledDelivery::Failed {
                message_id: String::new(),
                error: error.to_string(),
            },
        };
        self.record_outcome(&task.id, outcome);
    }

    fn record_outcome(&self, id: &str, outcome: ScheduledDelivery) {
        if let Err(error) = self.finish(id, outcome) {
            tracing::error!(task_id = id, %error, "scheduled result could not be saved");
        }
    }

    fn can_dispatch(&self, id: &str) -> bool {
        let state = self.state.lock().expect("schedule state poisoned");
        if let Err(error) = healthy(&state) {
            tracing::error!(task_id = id, %error, "schedule store is unavailable; prompt suppressed");
            return false;
        }
        state.store.tasks.iter().any(|record| record.task.id == id)
    }

    fn exists(&self, id: &str) -> bool {
        self.state
            .lock()
            .expect("schedule state poisoned")
            .store
            .tasks
            .iter()
            .any(|r| r.task.id == id)
    }

    fn blocked(&self, id: &str, reason: String) {
        let reason = bounded_error(reason);
        let unchanged = self
            .state
            .lock()
            .expect("schedule state poisoned")
            .store
            .tasks
            .iter()
            .find(|r| r.task.id == id)
            .is_none_or(|r| r.task.last_error.as_ref() == Some(&reason));
        if !unchanged {
            if let Err(error) = self.edit(id, |record, _| {
                record.task.last_error = Some(reason);
                Ok(())
            }) {
                tracing::warn!(task_id = id, %error, "scheduled blocked state could not be saved");
            }
        }
    }

    fn claim(&self, id: &str) -> Result<Option<ScheduledTask>> {
        let now = self.clock.now();
        let mut state = self.state.lock().expect("schedule state poisoned");
        healthy(&state)?;
        let mut candidate = state.store.clone();
        let Some(record) = candidate.tasks.iter_mut().find(|r| r.task.id == id) else {
            return Ok(None);
        };
        if !due(record, now) {
            return Ok(None);
        }
        let scheduled_for = record
            .run_now
            .or(record.task.next_run_at)
            .expect("due time");
        record.task.runs.insert(
            0,
            ScheduledRun {
                id: Uuid::new_v4().to_string(),
                scheduled_for,
                started_at: now,
                finished_at: None,
                status: RunStatus::Running,
                error: None,
                message_id: None,
            },
        );
        record.task.runs.truncate(MAX_RUNS);
        record.task.last_error = None;
        let task = record.task.clone();
        self.commit(&mut state, candidate)?;
        Ok(Some(task))
    }

    fn bind(&self, id: &str, target: &str) -> Result<()> {
        self.edit(id, |record, _| {
            record.task.session_id = Some(target.into());
            Ok(())
        })
        .map(|_| ())
    }

    fn finish(&self, id: &str, outcome: ScheduledDelivery) -> Result<()> {
        if !self.exists(id) {
            return Ok(());
        }
        self.edit(id, |record, now| {
            if !running(record) {
                return Ok(());
            }
            if let ScheduledDelivery::Deferred(reason) = outcome {
                record.task.runs.remove(0);
                record.task.last_error = Some(bounded_error(reason));
                return Ok(());
            }
            let run = &mut record.task.runs[0];
            run.finished_at = Some(now);
            match outcome {
                ScheduledDelivery::Completed { message_id } => {
                    run.status = RunStatus::Completed;
                    run.message_id = Some(message_id);
                }
                ScheduledDelivery::Failed { message_id, error } => {
                    run.status = RunStatus::Failed;
                    run.message_id = (!message_id.is_empty()).then_some(message_id);
                    run.error = Some(bounded_error(error));
                }
                ScheduledDelivery::Uncertain(error) => {
                    run.status = RunStatus::Uncertain;
                    run.error = Some(bounded_error(error));
                    record.task.enabled = false;
                    record.review_required = true;
                }
                ScheduledDelivery::Deferred(_) => unreachable!(),
            }
            record.task.last_error = run.error.clone();
            // Collapse all missed occurrences while offline or busy into this one
            // run, including time elapsed while the actual turn was executing.
            if record.task.next_run_at.is_some_and(|at| at <= now) {
                record.task.next_run_at = record.task.schedule.next_after(now)?;
            }
            record.run_now = None;
            record.task.updated_at = now;
            Ok(())
        })
        .map(|_| ())
    }
}

pub struct SchedulerLoop(tokio::task::JoinHandle<()>);
impl Drop for SchedulerLoop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn due(record: &Record, now: DateTime<Utc>) -> bool {
    !record.review_required
        && !running(record)
        && (record.run_now.is_some()
            || (record.task.enabled && record.task.next_run_at.is_some_and(|at| at <= now)))
}
fn running(record: &Record) -> bool {
    record
        .task
        .runs
        .iter()
        .any(|r| r.status == RunStatus::Running)
}
fn healthy(state: &State) -> Result<()> {
    match &state.fault {
        Some(error) => Err(persistence(error)),
        None => Ok(()),
    }
}
fn index(store: &Store, id: &str) -> Result<usize> {
    store
        .tasks
        .iter()
        .position(|r| r.task.id == id)
        .ok_or_else(|| invalid("Unknown scheduled task"))
}
fn invalid(error: impl std::fmt::Display) -> ServiceError {
    ServiceError::InvalidArgument(error.to_string())
}
fn persistence(error: impl std::fmt::Display) -> ServiceError {
    ServiceError::Persistence(format!("schedules.json: {error}"))
}
fn retryable(error: &ServiceError) -> bool {
    matches!(
        error,
        ServiceError::CopilotDisconnected
            | ServiceError::Draining
            | ServiceError::SessionProcessing(_)
            | ServiceError::SessionNotReady { .. }
    )
}
fn bounded_error(error: String) -> String {
    error.chars().take(2048).collect()
}

fn bounded(label: &str, value: &str, max: usize) -> Result<()> {
    if value.trim().is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return Err(invalid(format!(
            "{label} must be nonempty, at most {max} bytes, and contain no control characters"
        )));
    }
    Ok(())
}

fn validate_input(request: &SaveScheduledTask) -> Result<()> {
    bounded("name", &request.name, 400)?;
    if request.name.encode_utf16().count() > 100 {
        return Err(invalid("name must be at most 100 characters"));
    }
    bounded("cwd", &request.cwd, 4096)?;
    if !Path::new(&request.cwd).is_dir() {
        return Err(ServiceError::InvalidWorkingDirectory(request.cwd.clone()));
    }
    if request.prompt.trim().is_empty()
        || request.prompt.len() > 32 * 1024
        || request.prompt.contains('\0')
    {
        return Err(invalid("prompt must contain 1–32768 bytes and no NUL"));
    }
    if let Some(id) = &request.id {
        bounded("id", id, 128)?;
    }
    if let TargetUpdate::Set(Some(id)) = &request.session_id {
        bounded("sessionId", id, 256)?;
    }
    if let Some(model) = &request.model {
        bounded("model", model, 256)?;
    }
    request.schedule.validate()
}

fn validate_store(store: &Store) -> Result<()> {
    if store.version != 1 || store.tasks.len() > MAX_TASKS {
        return Err(persistence("Unsupported or oversized schedule store"));
    }
    let mut ids = HashSet::new();
    for record in &store.tasks {
        let task = &record.task;
        if !ids.insert(&task.id)
            || task.runs.len() > MAX_RUNS
            || task
                .runs
                .iter()
                .filter(|r| r.status == RunStatus::Running)
                .count()
                > 1
        {
            return Err(persistence("Invalid task identifiers or run history"));
        }
        bounded("id", &task.id, 128).map_err(persistence)?;
        bounded("name", &task.name, 400).map_err(persistence)?;
        bounded("cwd", &task.cwd, 4096).map_err(persistence)?;
        if task.prompt.trim().is_empty()
            || task.prompt.len() > 32 * 1024
            || task.prompt.contains('\0')
        {
            return Err(persistence("Invalid stored prompt"));
        }
        if let Some(id) = &task.session_id {
            bounded("sessionId", id, 256).map_err(persistence)?;
        }
        if let Some(model) = &task.model {
            bounded("model", model, 256).map_err(persistence)?;
        }
        task.schedule.validate().map_err(persistence)?;
        for at in [
            Some(task.created_at),
            Some(task.updated_at),
            task.next_run_at,
            record.run_now,
        ]
        .into_iter()
        .flatten()
        {
            valid_year(at.year()).map_err(persistence)?;
        }
        let mut run_ids = HashSet::new();
        for (i, run) in task.runs.iter().enumerate() {
            bounded("run id", &run.id, 128).map_err(persistence)?;
            if !run_ids.insert(&run.id)
                || (run.status == RunStatus::Running && (i != 0 || run.finished_at.is_some()))
                || (run.status != RunStatus::Running && run.finished_at.is_none())
                || run.error.as_ref().is_some_and(|error| error.len() > 8192)
            {
                return Err(persistence("Invalid stored run history"));
            }
            for at in [
                Some(run.scheduled_for),
                Some(run.started_at),
                run.finished_at,
            ]
            .into_iter()
            .flatten()
            {
                valid_year(at.year()).map_err(persistence)?;
            }
        }
    }
    Ok(())
}

fn write_store(path: &Path, store: &Store) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(store).map_err(persistence)?;
    if bytes.len() as u64 > MAX_STORE_BYTES {
        return Err(persistence("Schedule store exceeds size limit"));
    }
    let staging = path.with_extension("json.tmp");
    let result = (|| -> std::io::Result<()> {
        let mut file = File::create(&staging)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        // std::fs::rename replaces the destination atomically on Windows too.
        std::fs::rename(&staging, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&staging);
    }
    result.map_err(persistence)
}

fn valid_year(year: i32) -> Result<()> {
    if (2000..=2100).contains(&year) {
        Ok(())
    } else {
        Err(invalid("Dates must be between years 2000 and 2100"))
    }
}
fn utc_at(value: &str) -> Result<DateTime<Utc>> {
    if value.len() > 64 {
        return Err(invalid("Invalid UTC timestamp"));
    }
    let at = DateTime::parse_from_rfc3339(value).map_err(invalid)?;
    if at.offset().local_minus_utc() != 0 {
        return Err(invalid("One-off timestamp must use UTC"));
    }
    valid_year(at.year())?;
    Ok(at.with_timezone(&Utc))
}
fn daily_parts(time: &str, zone: &str) -> Result<(NaiveTime, Tz)> {
    if time.len() != 5 || time.as_bytes()[2] != b':' {
        return Err(invalid("Daily time must be HH:mm"));
    }
    bounded("timeZone", zone, 128)?;
    let time = NaiveTime::parse_from_str(time, "%H:%M").map_err(invalid)?;
    if time.format("%H:%M").to_string().len() != 5 {
        return Err(invalid("Invalid daily time"));
    }
    Ok((time, zone.parse::<Tz>().map_err(invalid)?))
}

impl Schedule {
    fn validate(&self) -> Result<()> {
        match self {
            Self::Once { at } => {
                utc_at(at)?;
            }
            Self::Daily { time, time_zone } => {
                daily_parts(time, time_zone)?;
            }
        }
        Ok(())
    }

    fn next_after(&self, after: DateTime<Utc>) -> Result<Option<DateTime<Utc>>> {
        match self {
            Self::Once { at } => Ok(Some(utc_at(at)?).filter(|at| *at > after)),
            Self::Daily { time, time_zone } => {
                let (time, zone) = daily_parts(time, time_zone)?;
                let mut day = after.with_timezone(&zone).date_naive();
                for _ in 0..370 {
                    valid_year(day.year())?;
                    if let Some(at) = daily_on(day, time, zone)
                        && at > after
                    {
                        return Ok(Some(at));
                    }
                    day = day
                        .succ_opt()
                        .ok_or_else(|| invalid("Schedule date overflow"))?;
                }
                Err(invalid("Could not resolve next calendar occurrence"))
            }
        }
    }
}

fn daily_on(day: NaiveDate, time: NaiveTime, zone: Tz) -> Option<DateTime<Utc>> {
    let mut local = day.and_time(time);
    // Fold: choose the earlier UTC instant, never both. Gap: advance to the
    // first valid local minute on this day. An entirely skipped day is skipped.
    while local.date() == day {
        match zone.from_local_datetime(&local) {
            LocalResult::Single(at) => return Some(at.with_timezone(&Utc)),
            LocalResult::Ambiguous(a, b) => return Some(a.min(b).with_timezone(&Utc)),
            LocalResult::None => local = local.checked_add_signed(chrono::Duration::minutes(1))?,
        }
    }
    None
}

#[cfg(test)]
mod tests;
