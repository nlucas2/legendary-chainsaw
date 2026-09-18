use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tokio::sync::Semaphore;

struct TestClock(Mutex<DateTime<Utc>>);
impl Clock for TestClock {
    fn now(&self) -> DateTime<Utc> {
        *self.0.lock().unwrap()
    }
}
impl TestClock {
    fn set(&self, at: &str) {
        *self.0.lock().unwrap() = dt(at);
    }
}

struct FakeRuntime {
    creates: AtomicUsize,
    deliveries: AtomicUsize,
    validations: AtomicUsize,
    blocked: AtomicBool,
    hold: AtomicBool,
    hold_creation: AtomicBool,
    always_deferred: AtomicBool,
    permit: Semaphore,
    outcome: Mutex<Option<ScheduledDelivery>>,
    targets: Mutex<Vec<String>>,
    path: PathBuf,
}
#[async_trait]
impl Runtime for FakeRuntime {
    async fn validate_target(&self, id: &str) -> Result<()> {
        self.validations.fetch_add(1, Ordering::SeqCst);
        if id == "missing" {
            Err(invalid("Unknown session"))
        } else {
            Ok(())
        }
    }
    async fn availability(&self, _: Option<&str>) -> Result<Option<String>> {
        Ok(self
            .blocked
            .load(Ordering::SeqCst)
            .then(|| "busy or draining".into()))
    }
    async fn create(&self, _: &ScheduledTask) -> Result<String> {
        assert_claim_saved(&self.path);
        self.creates.fetch_add(1, Ordering::SeqCst);
        if self.hold_creation.load(Ordering::SeqCst) {
            self.permit.acquire().await.unwrap().forget();
        }
        Ok("dedicated".into())
    }
    async fn deliver(&self, id: String, _: String, source: String) -> Result<ScheduledDelivery> {
        assert_claim_saved(&self.path);
        let persisted: Store = serde_json::from_slice(&std::fs::read(&self.path).unwrap()).unwrap();
        assert!(persisted.tasks.iter().any(|record| {
            source
                == format!(
                    "schedule-{}",
                    Uuid::parse_str(&record.task.id).unwrap().as_u128()
                )
        }));
        assert!(
            persisted
                .tasks
                .iter()
                .any(|r| r.task.session_id.as_deref() == Some(&id))
        );
        self.targets.lock().unwrap().push(id);
        self.deliveries.fetch_add(1, Ordering::SeqCst);
        if self.hold.load(Ordering::SeqCst) {
            self.permit.acquire().await.unwrap().forget();
        }
        if self.always_deferred.load(Ordering::SeqCst) {
            return Ok(ScheduledDelivery::Deferred("always deferred".into()));
        }
        Ok(self
            .outcome
            .lock()
            .unwrap()
            .take()
            .unwrap_or_else(|| ScheduledDelivery::Completed {
                message_id: "accepted".into(),
            }))
    }
}
fn assert_claim_saved(path: &Path) {
    let persisted: Store = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert!(
        persisted.tasks.iter().any(running),
        "side effect before durable claim"
    );
}

struct Fixture {
    scheduler: Arc<Scheduler>,
    runtime: Arc<FakeRuntime>,
    clock: Arc<TestClock>,
    dir: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("scheduler-tests")
            .join(Uuid::new_v4().to_string());
        std::fs::create_dir_all(&dir).unwrap();
        let clock = Arc::new(TestClock(Mutex::new(dt("2026-09-17T12:00:00Z"))));
        let runtime = Arc::new(FakeRuntime {
            creates: AtomicUsize::new(0),
            deliveries: AtomicUsize::new(0),
            validations: AtomicUsize::new(0),
            blocked: AtomicBool::new(false),
            hold: AtomicBool::new(false),
            hold_creation: AtomicBool::new(false),
            always_deferred: AtomicBool::new(false),
            permit: Semaphore::new(0),
            outcome: Mutex::new(None),
            targets: Mutex::new(vec![]),
            path: dir.join("schedules.json"),
        });
        let scheduler = Scheduler::load(runtime.path.clone(), runtime.clone(), clock.clone());
        Self {
            scheduler,
            runtime,
            clock,
            dir,
        }
    }
    async fn once(&self) -> ScheduledTask {
        self.scheduler
            .save(input(json!({"kind":"once","at":"2026-09-18T12:00:00Z"})))
            .await
            .unwrap()
    }
    async fn daily(&self) -> ScheduledTask {
        self.scheduler
            .save(input(
                json!({"kind":"daily","time":"08:00","timeZone":"America/Los_Angeles"}),
            ))
            .await
            .unwrap()
    }
    async fn wait(&self, predicate: impl Fn(&[ScheduledTask]) -> bool) {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if predicate(&self.scheduler.list().unwrap()) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .expect("scheduler did not reach expected state");
    }
    async fn idle(&self) {
        tokio::time::timeout(Duration::from_secs(3), async {
            while !self.scheduler.state.lock().unwrap().workers.is_empty() {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
fn dt(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .unwrap()
        .with_timezone(&Utc)
}
fn input(schedule: serde_json::Value) -> SaveScheduledTask {
    serde_json::from_value(json!({
        "name":"Test schedule", "prompt":"Use skill example, then report changes",
        "cwd": env!("CARGO_MANIFEST_DIR"), "schedule": schedule, "enabled":true
    }))
    .unwrap()
}

#[test]
fn schedule_due_calculation_calendar_days_and_dst_rules() {
    let daily = |time: &str| Schedule::Daily {
        time: time.into(),
        time_zone: "America/New_York".into(),
    };
    assert_eq!(
        daily("02:30")
            .next_after(dt("2026-03-08T05:00:00Z"))
            .unwrap(),
        Some(dt("2026-03-08T07:00:00Z"))
    );
    assert_eq!(
        daily("02:30")
            .next_after(dt("2026-03-08T07:00:00Z"))
            .unwrap(),
        Some(dt("2026-03-09T06:30:00Z"))
    );
    assert_eq!(
        daily("01:30")
            .next_after(dt("2026-11-01T04:00:00Z"))
            .unwrap(),
        Some(dt("2026-11-01T05:30:00Z"))
    );
    // During the second instance of the folded hour, today's occurrence is spent.
    assert_eq!(
        daily("01:30")
            .next_after(dt("2026-11-01T06:00:00Z"))
            .unwrap(),
        Some(dt("2026-11-02T06:30:00Z"))
    );
    let once = Schedule::Once {
        at: "2026-09-18T12:00:00Z".into(),
    };
    assert_eq!(once.next_after(dt("2026-09-18T12:00:00Z")).unwrap(), None);
}

#[test]
fn entirely_skipped_local_day_moves_to_following_calendar_day() {
    let schedule = Schedule::Daily {
        time: "08:00".into(),
        time_zone: "Pacific/Apia".into(),
    };
    assert_eq!(
        schedule.next_after(dt("2011-12-29T20:00:00Z")).unwrap(),
        Some(dt("2011-12-30T18:00:00Z"))
    );
}

#[tokio::test]
async fn empty_store_has_no_defaults_and_creation_never_opens_session() {
    let f = Fixture::new();
    assert!(f.scheduler.list().unwrap().is_empty());
    assert!(!f.runtime.path.exists());
    let task = f.once().await;
    assert!(task.session_id.is_none());
    assert!(task.runs.is_empty());
    assert_eq!(f.runtime.creates.load(Ordering::SeqCst), 0);
    assert_eq!(f.runtime.deliveries.load(Ordering::SeqCst), 0);
    let serialized = serde_json::to_value(task).unwrap();
    assert_eq!(serialized["sessionId"], serde_json::Value::Null);
    assert!(serialized.get("model").unwrap().is_null());
    assert!(serialized.get("lastError").unwrap().is_null());
    assert!(serialized.get("runs").unwrap().is_array());
    assert_eq!(serialized["nextRunAt"], "2026-09-18T12:00:00Z");
}

#[tokio::test]
async fn daily_sleep_catchup_once_reuses_session_and_skips_elapsed_days() {
    let f = Fixture::new();
    let task = f.daily().await;
    f.clock.set("2026-09-23T20:00:00Z");
    f.scheduler.tick();
    f.wait(|tasks| {
        tasks[0]
            .runs
            .first()
            .is_some_and(|r| r.status == RunStatus::Completed)
    })
    .await;
    f.idle().await;
    assert_eq!(
        f.scheduler.list().unwrap()[0].next_run_at,
        Some(dt("2026-09-24T15:00:00Z"))
    );
    for _ in 0..5 {
        f.scheduler.tick();
    }
    assert_eq!(f.runtime.deliveries.load(Ordering::SeqCst), 1);
    f.clock.set("2026-09-24T15:00:01Z");
    f.scheduler.tick();
    f.wait(|tasks| tasks[0].runs.len() == 2 && tasks[0].runs[0].status == RunStatus::Completed)
        .await;
    f.idle().await;
    assert_eq!(f.runtime.creates.load(Ordering::SeqCst), 1);
    assert_eq!(
        *f.runtime.targets.lock().unwrap(),
        ["dedicated", "dedicated"]
    );
    assert_eq!(f.scheduler.list().unwrap()[0].id, task.id);
}

#[tokio::test]
async fn overdue_once_pause_resume_and_run_now_after_completion() {
    let f = Fixture::new();
    let task = f.once().await;
    f.scheduler.set_enabled(&task.id, false).unwrap();
    f.clock.set("2026-09-20T12:00:00Z");
    f.scheduler.tick();
    assert_eq!(f.runtime.deliveries.load(Ordering::SeqCst), 0);
    f.scheduler.set_enabled(&task.id, true).unwrap();
    f.scheduler.tick();
    f.wait(|tasks| {
        tasks[0]
            .runs
            .first()
            .is_some_and(|r| r.status == RunStatus::Completed)
    })
    .await;
    f.idle().await;
    assert!(f.scheduler.list().unwrap()[0].next_run_at.is_none());
    f.scheduler.tick();
    assert_eq!(f.runtime.deliveries.load(Ordering::SeqCst), 1);
    f.scheduler.set_enabled(&task.id, false).unwrap();
    f.scheduler.run_now(&task.id).unwrap();
    assert!(f.scheduler.run_now(&task.id).is_err());
    f.scheduler.tick();
    f.wait(|tasks| tasks[0].runs.len() == 2 && tasks[0].runs[0].status == RunStatus::Completed)
        .await;
    f.idle().await;
    assert!(!f.scheduler.list().unwrap()[0].enabled);
}

#[tokio::test]
async fn running_claim_precedes_creation_no_overlap_and_delete_never_cancels() {
    let f = Fixture::new();
    let task = f.once().await;
    f.runtime.hold.store(true, Ordering::SeqCst);
    f.scheduler.run_now(&task.id).unwrap();
    f.scheduler.tick();
    f.wait(|tasks| {
        tasks[0]
            .runs
            .first()
            .is_some_and(|r| r.status == RunStatus::Running)
            && tasks[0].session_id.is_some()
    })
    .await;
    while f.runtime.deliveries.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }
    for _ in 0..5 {
        f.scheduler.tick();
    }
    assert!(f.scheduler.run_now(&task.id).is_err());
    assert_eq!(f.runtime.deliveries.load(Ordering::SeqCst), 1);
    f.scheduler.delete(&task.id).unwrap();
    assert!(f.scheduler.list().unwrap().is_empty());
    assert!(!f.scheduler.state.lock().unwrap().workers.is_empty());
    f.runtime.permit.add_permits(1);
    f.idle().await;
    assert!(f.scheduler.list().unwrap().is_empty());
}

#[tokio::test]
async fn busy_runtime_leaves_due_pending_and_dispatch_race_defers_without_failed_runs() {
    let f = Fixture::new();
    f.daily().await;
    f.clock.set("2026-09-20T19:00:00Z");
    f.runtime.blocked.store(true, Ordering::SeqCst);
    f.scheduler.tick();
    f.idle().await;
    let task = f.scheduler.list().unwrap().remove(0);
    assert!(task.runs.is_empty() && task.last_error.is_some());
    assert_eq!(f.runtime.creates.load(Ordering::SeqCst), 0);
    f.runtime.blocked.store(false, Ordering::SeqCst);
    *f.runtime.outcome.lock().unwrap() = Some(ScheduledDelivery::Deferred("draining".into()));
    f.scheduler.tick();
    f.idle().await;
    assert!(f.scheduler.list().unwrap()[0].runs.is_empty());
    assert_eq!(f.scheduler.list().unwrap()[0].next_run_at, task.next_run_at);
    f.scheduler.tick();
    f.wait(|tasks| {
        tasks[0]
            .runs
            .first()
            .is_some_and(|r| r.status == RunStatus::Completed)
    })
    .await;
    f.idle().await;
    assert_eq!(f.runtime.creates.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn saved_claim_restarts_uncertain_disabled_without_replaying() {
    let mut f = Fixture::new();
    let task = f.once().await;
    f.clock.set("2026-09-21T12:00:00Z");
    f.scheduler.claim(&task.id).unwrap().unwrap();
    let old = std::mem::replace(
        &mut f.scheduler,
        Scheduler::load(
            f.dir.join("unused.json"),
            f.runtime.clone(),
            f.clock.clone(),
        ),
    );
    drop(old);
    f.scheduler = Scheduler::load(f.runtime.path.clone(), f.runtime.clone(), f.clock.clone());
    let task = f.scheduler.list().unwrap().remove(0);
    assert!(!task.enabled);
    assert_eq!(task.runs[0].status, RunStatus::Uncertain);
    assert!(task.last_error.as_deref().unwrap().contains("Inspect"));
    assert!(f.scheduler.run_now(&task.id).is_err());
    f.scheduler.tick();
    assert_eq!(f.runtime.deliveries.load(Ordering::SeqCst), 0);
    f.scheduler.set_enabled(&task.id, true).unwrap();
    f.scheduler.tick();
    f.wait(|tasks| tasks[0].runs[0].status == RunStatus::Completed)
        .await;
    f.idle().await;
}

#[tokio::test]
async fn uncertain_send_requires_explicit_resume_and_failure_is_not_completion() {
    let f = Fixture::new();
    let task = f.once().await;
    *f.runtime.outcome.lock().unwrap() =
        Some(ScheduledDelivery::Uncertain("lost acknowledgement".into()));
    f.scheduler.run_now(&task.id).unwrap();
    f.scheduler.tick();
    f.wait(|tasks| {
        tasks[0]
            .runs
            .first()
            .is_some_and(|r| r.status == RunStatus::Uncertain)
    })
    .await;
    f.idle().await;
    assert!(!f.scheduler.list().unwrap()[0].enabled);
    assert!(f.scheduler.run_now(&task.id).is_err());
    f.scheduler.set_enabled(&task.id, false).unwrap();
    assert!(
        f.scheduler.run_now(&task.id).is_err(),
        "pausing is not review acknowledgement"
    );
    f.scheduler.set_enabled(&task.id, true).unwrap();
    *f.runtime.outcome.lock().unwrap() = Some(ScheduledDelivery::Failed {
        message_id: "m".into(),
        error: "model failure".into(),
    });
    f.scheduler.run_now(&task.id).unwrap();
    f.scheduler.tick();
    f.wait(|tasks| tasks[0].runs[0].status == RunStatus::Failed)
        .await;
    f.idle().await;
}

#[tokio::test]
async fn chosen_target_validation_edit_preserves_binding_and_history_is_bounded() {
    let f = Fixture::new();
    let mut request = input(json!({"kind":"once","at":"2026-09-18T12:00:00Z"}));
    request.session_id = TargetUpdate::Set(Some("missing".into()));
    assert!(f.scheduler.save(request.clone()).await.is_err());
    request.session_id = TargetUpdate::Set(Some("chosen".into()));
    let mut task = f.scheduler.save(request.clone()).await.unwrap();
    assert_eq!(f.runtime.creates.load(Ordering::SeqCst), 0);
    request.id = Some(task.id.clone());
    request.session_id = TargetUpdate::Unchanged;
    task = f.scheduler.save(request).await.unwrap();
    assert_eq!(task.session_id.as_deref(), Some("chosen"));
    for _ in 0..25 {
        f.scheduler.run_now(&task.id).unwrap();
        f.scheduler.claim(&task.id).unwrap().unwrap();
        f.scheduler
            .finish(
                &task.id,
                ScheduledDelivery::Completed {
                    message_id: "m".into(),
                },
            )
            .unwrap();
    }

    assert_eq!(f.scheduler.list().unwrap()[0].runs.len(), 20);
    assert_eq!(f.runtime.creates.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn stale_editor_null_target_preserves_first_run_binding_and_never_creates_a_second_session() {
    let f = Fixture::new();
    let mut stale = input(json!({"kind":"once","at":"2026-09-18T12:00:00Z"}));
    stale.session_id = TargetUpdate::Set(None);
    let task = f.scheduler.save(stale.clone()).await.unwrap();
    stale.id = Some(task.id.clone());
    f.scheduler.run_now(&task.id).unwrap();
    f.scheduler.tick();
    f.wait(|tasks| {
        tasks[0]
            .runs
            .first()
            .is_some_and(|r| r.status == RunStatus::Completed)
    })
    .await;
    f.idle().await;
    let saved = f.scheduler.save(stale.clone()).await.unwrap();
    assert_eq!(saved.session_id.as_deref(), Some("dedicated"));
    assert_eq!(saved.runs.len(), 1);
    f.scheduler.run_now(&task.id).unwrap();
    f.scheduler.tick();
    f.wait(|tasks| tasks[0].runs.len() == 2 && tasks[0].runs[0].status == RunStatus::Completed)
        .await;
    f.idle().await;
    assert_eq!(f.runtime.creates.load(Ordering::SeqCst), 1);
    stale.session_id = TargetUpdate::Set(Some("different".into()));
    assert!(f.scheduler.save(stale).await.is_err());
    assert_eq!(
        f.scheduler.list().unwrap()[0].session_id.as_deref(),
        Some("dedicated")
    );
}

#[tokio::test]
async fn corrupt_store_persistence_failure_and_single_owner_are_visible_without_reset() {
    let f = Fixture::new();
    f.once().await;
    let second = Scheduler::load(f.runtime.path.clone(), f.runtime.clone(), f.clock.clone());
    assert!(second.list().is_err());
    let before = std::fs::read(&f.runtime.path).unwrap();
    std::fs::create_dir(f.runtime.path.with_extension("json.tmp")).unwrap();
    let id = f.scheduler.list().unwrap()[0].id.clone();
    assert!(f.scheduler.run_now(&id).is_err());
    assert!(f.scheduler.list().is_err());
    assert_eq!(before, std::fs::read(&f.runtime.path).unwrap());
    f.scheduler.tick();
    assert_eq!(f.runtime.deliveries.load(Ordering::SeqCst), 0);
    let corrupt = f.dir.join("corrupt.json");
    std::fs::write(&corrupt, b"{broken").unwrap();
    let scheduler = Scheduler::load(corrupt.clone(), f.runtime.clone(), f.clock.clone());
    assert!(scheduler.list().is_err());
    assert!(matches!(
        crate::dispatch_scheduled_command(&scheduler, "list_scheduled_tasks", &json!({})).await,
        Err(ServiceError::Persistence(_))
    ));
    assert!(
        crate::dispatch_scheduled_command(&scheduler, "list_sessions", &json!({}))
            .await
            .unwrap()
            .is_none(),
        "a corrupt schedule store must not intercept ordinary chat commands"
    );
    assert!(
        scheduler
            .save(input(json!({"kind":"once","at":"2026-09-18T12:00:00Z"})))
            .await
            .is_err()
    );
    assert_eq!(std::fs::read(corrupt).unwrap(), b"{broken");
}

#[tokio::test]
async fn validates_dates_times_zones_text_and_task_limits() {
    let f = Fixture::new();
    for schedule in [
        json!({"kind":"once","at":"2026-09-17T11:00:00Z"}),
        json!({"kind":"once","at":"2101-01-01T00:00:00Z"}),
        json!({"kind":"once","at":"2026-09-18T12:00:00+01:00"}),
        json!({"kind":"daily","time":"8:00","timeZone":"UTC"}),
        json!({"kind":"daily","time":"24:00","timeZone":"UTC"}),
        json!({"kind":"daily","time":"08:00","timeZone":"Not/AZone"}),
    ] {
        assert!(f.scheduler.save(input(schedule)).await.is_err());
    }
    let mut request = input(json!({"kind":"daily","time":"08:00","timeZone":"UTC"}));
    request.prompt = "x".repeat(32769);
    assert!(f.scheduler.save(request.clone()).await.is_err());
    request.prompt = "valid".into();
    for _ in 0..MAX_TASKS {
        f.scheduler.save(request.clone()).await.unwrap();
    }
    assert!(f.scheduler.save(request).await.is_err());
}

#[tokio::test]
async fn daemon_loop_runs_without_gui_and_slow_target_does_not_block_another_task() {
    let f = Fixture::new();
    let mut request = input(json!({"kind":"once","at":"2026-09-18T12:00:00Z"}));
    request.session_id = TargetUpdate::Set(Some("one".into()));
    let one = f.scheduler.save(request.clone()).await.unwrap();
    request.session_id = TargetUpdate::Set(Some("two".into()));
    let two = f.scheduler.save(request).await.unwrap();
    f.runtime.hold.store(true, Ordering::SeqCst);
    let _daemon_loop = f.scheduler.start();
    f.scheduler.run_now(&one.id).unwrap();
    f.scheduler.run_now(&two.id).unwrap();
    f.wait(|tasks| {
        tasks.iter().all(|t| {
            t.runs
                .first()
                .is_some_and(|r| r.status == RunStatus::Running)
        })
    })
    .await;
    tokio::time::timeout(Duration::from_secs(3), async {
        while f.runtime.deliveries.load(Ordering::SeqCst) != 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    f.runtime.permit.add_permits(2);
    f.wait(|tasks| {
        tasks
            .iter()
            .all(|t| t.runs[0].status == RunStatus::Completed)
    })
    .await;
    f.idle().await;
}

#[tokio::test]
async fn pending_manual_request_survives_restart_and_long_running_turn_coalesces_days() {
    let mut f = Fixture::new();
    let task = f.daily().await;
    f.scheduler.run_now(&task.id).unwrap();
    let old = std::mem::replace(
        &mut f.scheduler,
        Scheduler::load(
            f.dir.join("unused.json"),
            f.runtime.clone(),
            f.clock.clone(),
        ),
    );
    drop(old);
    f.scheduler = Scheduler::load(f.runtime.path.clone(), f.runtime.clone(), f.clock.clone());
    assert!(f.scheduler.list().unwrap()[0].enabled);
    assert!(f.scheduler.list().unwrap()[0].runs.is_empty());
    f.scheduler.claim(&task.id).unwrap().unwrap();
    f.clock.set("2026-10-02T20:00:00Z");
    f.scheduler
        .finish(
            &task.id,
            ScheduledDelivery::Completed {
                message_id: "m".into(),
            },
        )
        .unwrap();
    assert_eq!(
        f.scheduler.list().unwrap()[0].next_run_at,
        Some(dt("2026-10-03T15:00:00Z"))
    );
    f.scheduler.tick();
    assert_eq!(f.runtime.deliveries.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn live_loop_deferred_delivery_never_self_wakes_but_user_actions_still_wake() {
    let f = Fixture::new();
    let task = f.once().await;
    f.runtime.always_deferred.store(true, Ordering::SeqCst);
    let _daemon_loop = f.scheduler.start();
    // Drain the loop's initial tick and the save notification before Run now.
    tokio::time::sleep(Duration::from_millis(25)).await;
    f.scheduler.run_now(&task.id).unwrap();
    f.wait(|tasks| tasks[0].last_error.as_deref() == Some("always deferred"))
        .await;
    f.idle().await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        f.runtime.deliveries.load(Ordering::SeqCst),
        1,
        "worker writes must not cause immediate retry loops"
    );
    assert!(f.scheduler.list().unwrap()[0].runs.is_empty());
    f.scheduler.set_enabled(&task.id, true).unwrap();
    f.wait(|tasks| tasks[0].last_error.as_deref() == Some("always deferred"))
        .await;
    f.idle().await;
    assert_eq!(
        f.runtime.deliveries.load(Ordering::SeqCst),
        2,
        "explicit user actions should wake the scheduler without waiting five seconds"
    );
}

#[tokio::test]
async fn store_fault_during_creation_suppresses_delivery_and_preserves_restart_claim() {
    let f = Fixture::new();
    let task = f.once().await;
    let other = f.once().await;
    f.runtime.hold_creation.store(true, Ordering::SeqCst);
    f.scheduler.run_now(&task.id).unwrap();
    f.scheduler.tick();
    tokio::time::timeout(Duration::from_secs(3), async {
        while f.runtime.creates.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    std::fs::create_dir(f.runtime.path.with_extension("json.tmp")).unwrap();
    assert!(f.scheduler.set_enabled(&other.id, false).is_err());
    assert!(f.scheduler.exists(&task.id));
    assert!(
        !f.scheduler.can_dispatch(&task.id),
        "existence alone must not admit dispatch"
    );
    f.runtime.permit.add_permits(1);
    f.idle().await;
    assert_eq!(f.runtime.deliveries.load(Ordering::SeqCst), 0);
    assert!(f.scheduler.list().is_err());
    let saved: Store = serde_json::from_slice(&std::fs::read(&f.runtime.path).unwrap()).unwrap();
    assert!(running(
        saved
            .tasks
            .iter()
            .find(|record| record.task.id == task.id)
            .unwrap()
    ));
}

#[tokio::test]
async fn scheduled_command_dispatch_contract_covers_all_five_endpoints_without_sdk() {
    let f = Fixture::new();
    let command = |name: &'static str, body: serde_json::Value| {
        let scheduler = f.scheduler.clone();
        async move { crate::dispatch_scheduled_command(&scheduler, name, &body).await }
    };
    assert_eq!(
        command("list_scheduled_tasks", json!({}))
            .await
            .unwrap()
            .unwrap(),
        json!({"tasks":[]})
    );
    let mut request = json!({
        "name":"Contract test", "prompt":"Mock-only test prompt", "sessionId":null,
        "cwd":env!("CARGO_MANIFEST_DIR"), "model":null,
        "schedule":{"kind":"once","at":"2026-09-18T12:00:00Z"}, "enabled":false
    });
    let saved = command("save_scheduled_task", request.clone())
        .await
        .unwrap()
        .unwrap();
    let task: ScheduledTask = serde_json::from_value(saved.clone()).unwrap();
    assert_eq!(saved["runs"], json!([]));
    for field in ["sessionId", "model", "lastError"] {
        assert!(saved.get(field).unwrap().is_null());
    }
    assert!(!saved["enabled"].as_bool().unwrap());
    assert_eq!(saved["nextRunAt"], "2026-09-18T12:00:00Z");
    assert!(saved["createdAt"].is_string() && saved["updatedAt"].is_string());
    let listed = command("list_scheduled_tasks", json!({}))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(listed["tasks"], json!([saved]));
    let enabled = command(
        "set_scheduled_task_enabled",
        json!({"id":task.id, "enabled":true}),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(enabled["enabled"], true);
    let queued = command("run_scheduled_task", json!({"id":task.id}))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        queued["runs"],
        json!([]),
        "Run now must not pretend it already completed"
    );
    assert!(
        queued["lastError"]
            .as_str()
            .unwrap()
            .contains("Run now requested")
    );
    assert!(
        command("run_scheduled_task", json!({"id":task.id}))
            .await
            .is_err()
    );
    assert!(
        command(
            "set_scheduled_task_enabled",
            json!({"id":task.id, "enabled":"yes"})
        )
        .await
        .is_err()
    );
    command(
        "set_scheduled_task_enabled",
        json!({"id":task.id, "enabled":false}),
    )
    .await
    .unwrap();
    // An unchanged original one-off timestamp remains editable after becoming overdue.
    f.clock.set("2026-09-19T12:00:00Z");
    request["id"] = json!(task.id);
    let updated = command("save_scheduled_task", request)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(updated["nextRunAt"], "2026-09-18T12:00:00Z");
    assert_eq!(
        command("delete_scheduled_task", json!({"id":task.id}))
            .await
            .unwrap()
            .unwrap(),
        json!({"ok":true})
    );
    assert_eq!(
        command("list_scheduled_tasks", json!({}))
            .await
            .unwrap()
            .unwrap(),
        json!({"tasks":[]})
    );
    assert_eq!(f.runtime.creates.load(Ordering::SeqCst), 0);
    assert_eq!(f.runtime.deliveries.load(Ordering::SeqCst), 0);
    assert!(
        command("list_sessions", json!({})).await.unwrap().is_none(),
        "ordinary commands must fall through to the ordinary dispatcher"
    );
}
