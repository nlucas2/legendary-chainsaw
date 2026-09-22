use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use github_copilot_sdk::session::Session;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use crate::{AppEvent, Result, ServiceError, SessionService, SessionSummary, StoredSessionMeta};

const INITIALIZATION_TIMEOUT: Duration = Duration::from_secs(90);
const REATTACH_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InitializationPhase {
    Initializing,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InitializationStage {
    Tools,
    Model,
    Ready,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializationSnapshot {
    pub phase: InitializationPhase,
    pub stage: InitializationStage,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl InitializationSnapshot {
    fn pending() -> Self {
        Self {
            phase: InitializationPhase::Initializing,
            stage: InitializationStage::Tools,
            error: None,
        }
    }

    fn ready() -> Self {
        Self {
            phase: InitializationPhase::Ready,
            stage: InitializationStage::Ready,
            error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInitialization {
    pub session_id: String,
    pub initialization: InitializationSnapshot,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<SessionSummary>,
}

pub(crate) struct InitializationRun {
    session: Weak<Session>,
    state: watch::Sender<InitializationSnapshot>,
}

impl InitializationRun {
    fn new(session: Arc<Session>) -> Arc<Self> {
        let (state, _) = watch::channel(InitializationSnapshot::pending());
        Arc::new(Self {
            session: Arc::downgrade(&session),
            state,
        })
    }
}

#[derive(Default)]
pub(crate) struct InitializationRegistry {
    pub(crate) runs: HashMap<String, Arc<InitializationRun>>,
    // A late session.list reply must not resurrect a deleted local session.
    pub(crate) deleted: HashSet<String>,
}

pub(crate) struct DeletedSessionState {
    run: Option<Arc<InitializationRun>>,
    active: Option<Arc<Session>>,
    warmed: bool,
    summary: Option<SessionSummary>,
}

impl InitializationRegistry {
    pub(crate) fn snapshot(&self, id: &str) -> Option<InitializationSnapshot> {
        self.runs.get(id).map(|run| run.state.borrow().clone())
    }
}

pub(crate) fn apply_metadata(summary: &mut SessionSummary, meta: &StoredSessionMeta) {
    summary.cwd = meta.cwd.clone();
    summary.model = meta.model.clone();
    if let Some(title) = &meta.title {
        summary.title = title.clone();
    }
    summary.pinned = meta.pinned;
    summary.archived = meta.archived;
    summary.folder = meta.folder.clone();
    summary.tags = meta.tags.clone();
}

impl SessionService {
    pub(crate) async fn require_initialized(&self, session_id: &str) -> Result<()> {
        let registry = self.initializations.read().await;
        if registry.deleted.contains(session_id) {
            return Err(ServiceError::SessionNotActive(session_id.into()));
        }
        if let Some(snapshot) = registry.snapshot(session_id)
            && snapshot.phase != InitializationPhase::Ready
        {
            return Err(not_ready(session_id, &snapshot));
        }
        Ok(())
    }

    pub async fn session_initialization(&self, session_id: &str) -> Result<SessionInitialization> {
        let registry = self.initializations.read().await;
        self.initialization_response(&registry, session_id).await
    }

    async fn initialization_response(
        &self,
        registry: &InitializationRegistry,
        session_id: &str,
    ) -> Result<SessionInitialization> {
        if registry.deleted.contains(session_id) {
            return Err(ServiceError::SessionNotActive(session_id.into()));
        }
        let active = self.active.read().await;
        let attached = active
            .get(session_id)
            .is_some_and(|session| !session.cancellation_token().is_cancelled());
        let mut initialization = if let Some(snapshot) = registry.snapshot(session_id) {
            snapshot
        } else if attached && self.warmed.read().await.contains(session_id) {
            InitializationSnapshot::ready()
        } else {
            return Err(ServiceError::SessionNotReady {
                session_id: session_id.into(),
                reason: "Readiness is unknown; resume the session before using it".into(),
            });
        };
        if initialization.phase == InitializationPhase::Ready && !attached {
            initialization.phase = InitializationPhase::Failed;
            initialization.error =
                Some("Session is disconnected; resume it before using it".into());
        }
        let metadata = self.metadata.read().await;
        let cache = self.session_cache.read().await;
        let session = if initialization.phase == InitializationPhase::Ready {
            let mut summary = cache
                .iter()
                .find(|item| item.session_id == session_id)
                .cloned()
                .unwrap_or_else(|| SessionSummary {
                    session_id: session_id.into(),
                    title: "Session".into(),
                    start_time: String::new(),
                    modified_time: String::new(),
                    cwd: None,
                    model: None,
                    is_active: attached,
                    is_remote: false,
                    pinned: false,
                    archived: false,
                    folder: None,
                    tags: vec![],
                    initialization: None,
                });
            if let Some(meta) = metadata.get(session_id) {
                apply_metadata(&mut summary, meta);
            }
            summary.is_active = attached;
            summary.initialization = Some(initialization.clone());
            Some(summary)
        } else {
            None
        };
        Ok(SessionInitialization {
            session_id: session_id.into(),
            initialization,
            session,
        })
    }

    pub(crate) async fn attach_deferred(
        self: &Arc<Self>,
        session: Arc<Session>,
    ) -> Result<SessionSummary> {
        let id = session.id().to_string();
        let gate = self.turn_gate(&id).await;
        let _session_guard = gate.lock().await;
        let run = InitializationRun::new(session.clone());
        {
            let mut registry = self.initializations.write().await;
            if registry.deleted.contains(&id) {
                return Err(ServiceError::SessionNotActive(id));
            }
            let metadata = self.metadata.read().await;
            let meta = metadata
                .get(&id)
                .ok_or_else(|| ServiceError::SessionNotActive(id.clone()))?;
            let summary = SessionSummary {
                session_id: id.clone(),
                title: meta.title.clone().unwrap_or_else(|| "New session".into()),
                start_time: String::new(),
                modified_time: String::new(),
                cwd: meta.cwd.clone(),
                model: meta.model.clone(),
                is_active: false,
                is_remote: false,
                pinned: meta.pinned,
                archived: meta.archived,
                folder: meta.folder.clone(),
                tags: meta.tags.clone(),
                initialization: Some(InitializationSnapshot::pending()),
            };
            registry.runs.insert(id.clone(), run.clone());
            self.session_cache.write().await.push(summary);
        }
        // Register readiness BEFORE attach publishes the usable handle/event.
        let started = Instant::now();
        if let Err(error) = self.attach(session).await {
            self.fail_initialization(&id, &run, error.to_string()).await;
            return Err(error);
        }
        tracing::info!(session_id = %id, stage = "attach", elapsed_ms = started.elapsed().as_millis(), "session startup");
        let summary = {
            let mut cache = self.session_cache.write().await;
            let summary = cache
                .iter_mut()
                .find(|item| item.session_id == id)
                .ok_or_else(|| ServiceError::SessionNotActive(id.clone()))?;
            summary.is_active = true;
            summary.clone()
        };
        self.events.emit(AppEvent::SessionInitializationChanged {
            session_id: id.clone(),
            initialization: InitializationSnapshot::pending(),
        });
        self.spawn_initialization(id, run);
        Ok(summary)
    }

    pub async fn retry_session_initialization(
        self: &Arc<Self>,
        session_id: &str,
    ) -> Result<SessionInitialization> {
        let service = Arc::clone(self);
        let session_id = session_id.to_owned();
        tokio::spawn(async move { service.retry_initialization(&session_id).await })
            .await
            .map_err(|error| {
                ServiceError::CommandFailed(format!("Initialization retry failed: {error}"))
            })?
    }

    async fn retry_initialization(
        self: &Arc<Self>,
        session_id: &str,
    ) -> Result<SessionInitialization> {
        let _lifecycle = self.lifecycle_gate.read().await;
        let gate = self.turn_gate(session_id).await;
        let _session_guard = gate.lock().await;
        self.require_accepting_work()?;
        let mut registry = self.initializations.write().await;
        if registry.deleted.contains(session_id) {
            return Err(ServiceError::SessionNotActive(session_id.into()));
        }
        let old = registry.runs.get(session_id).cloned().ok_or_else(|| {
            ServiceError::SessionNotReady {
                session_id: session_id.into(),
                reason: "No failed initialization to retry; resume the session".into(),
            }
        })?;
        let active = self
            .active
            .read()
            .await
            .get(session_id)
            .cloned()
            .filter(|session| {
                Weak::ptr_eq(&Arc::downgrade(session), &old.session)
                    && !session.cancellation_token().is_cancelled()
            });
        if old.state.borrow().phase != InitializationPhase::Failed && active.is_some() {
            return self.initialization_response(&registry, session_id).await;
        }
        // The per-session gate excludes delete and another retry throughout
        // reattachment. Polling remains a memory-only read while SDK resume runs.
        let needs_attach = active.is_none();
        let session = if let Some(session) = active {
            session
        } else {
            let mut snapshot = old.state.borrow().clone();
            snapshot.phase = InitializationPhase::Failed;
            snapshot.error =
                Some("Session is disconnected; reattaching the existing session".into());
            self.publish_initialization(session_id, &old, snapshot)
                .await;
            drop(registry);
            let started = Instant::now();
            let resumed =
                tokio::time::timeout(REATTACH_TIMEOUT, self.resume_handle(session_id, false))
                    .await
                    .unwrap_or_else(|_| {
                        Err(ServiceError::CommandFailed(
                            "Session reattachment timed out after 30 seconds; retry".into(),
                        ))
                    });
            tracing::info!(%session_id, stage = "resume", elapsed_ms = started.elapsed().as_millis(), "session startup");
            let session = match resumed {
                Ok(session) => session,
                Err(error) => {
                    self.fail_recovery(session_id, &old, error.to_string())
                        .await;
                    return Err(error);
                }
            };
            if session.id().to_string() != session_id {
                let error = ServiceError::CommandFailed(
                    "Session retry returned a different session ID; it was not attached".into(),
                );
                self.fail_recovery(session_id, &old, error.to_string())
                    .await;
                return Err(error);
            }
            registry = self.initializations.write().await;
            if registry.deleted.contains(session_id)
                || !registry
                    .runs
                    .get(session_id)
                    .is_some_and(|current| Arc::ptr_eq(current, &old))
            {
                return Err(ServiceError::SessionNotActive(session_id.into()));
            }
            session
        };
        let run = InitializationRun::new(session.clone());
        registry.runs.insert(session_id.into(), run.clone());
        self.publish_initialization(session_id, &run, InitializationSnapshot::pending())
            .await;
        drop(registry);
        if needs_attach {
            let started = Instant::now();
            let attached = tokio::time::timeout(REATTACH_TIMEOUT, self.attach(session))
                .await
                .unwrap_or_else(|_| {
                    Err(ServiceError::CommandFailed(
                        "Session event-log attachment timed out after 30 seconds; retry".into(),
                    ))
                });
            if let Err(error) = attached {
                self.fail_initialization(session_id, &run, error.to_string())
                    .await;
                return Err(error);
            }
            tracing::info!(%session_id, stage = "attach", elapsed_ms = started.elapsed().as_millis(), "session startup");
            if let Some(summary) = self
                .session_cache
                .write()
                .await
                .iter_mut()
                .find(|item| item.session_id == session_id)
            {
                summary.is_active = true;
            }
        }
        self.spawn_initialization(session_id.into(), run);
        let registry = self.initializations.read().await;
        self.initialization_response(&registry, session_id).await
    }

    // Resume joins only the daemon-owned job, without a lifecycle or turn lock.
    // A waiting resume must not keep drain/delete from cancelling that job.
    pub(crate) async fn join_initialization(
        self: &Arc<Self>,
        session_id: &str,
    ) -> Result<Option<SessionSummary>> {
        let registry = self.initializations.read().await;
        if registry.deleted.contains(session_id) {
            return Err(ServiceError::SessionNotActive(session_id.into()));
        }
        let run = registry.runs.get(session_id).cloned();
        drop(registry);
        let Some(mut run) = run else { return Ok(None) };
        if !self
            .active
            .read()
            .await
            .get(session_id)
            .is_some_and(|session| !session.cancellation_token().is_cancelled())
            && run.state.borrow().phase != InitializationPhase::Initializing
        {
            self.retry_session_initialization(session_id).await?;
            run = self
                .initializations
                .read()
                .await
                .runs
                .get(session_id)
                .cloned()
                .ok_or_else(|| ServiceError::SessionNotActive(session_id.into()))?;
        }
        let mut receiver = run.state.subscribe();
        let snapshot = receiver
            .wait_for(|state| state.phase != InitializationPhase::Initializing)
            .await
            .map_err(|_| ServiceError::SessionNotActive(session_id.into()))?
            .clone();
        if snapshot.phase == InitializationPhase::Failed {
            return Err(not_ready(session_id, &snapshot));
        }
        let response = self.session_initialization(session_id).await?;
        response
            .session
            .map(Some)
            .ok_or_else(|| not_ready(session_id, &response.initialization))
    }

    fn spawn_initialization(self: &Arc<Self>, id: String, run: Arc<InitializationRun>) {
        let service = Arc::clone(self);
        tokio::spawn(async move {
            let mut cancelled = run.state.subscribe();
            let Some(session) = run.session.upgrade() else {
                service
                    .fail_initialization(
                        &id,
                        &run,
                        "Session is disconnected; retry initialization".into(),
                    )
                    .await;
                return;
            };
            let cancellation = session.cancellation_token();
            let result = tokio::select! {
                _ = cancelled.wait_for(|state| state.phase == InitializationPhase::Failed) => return,
                _ = cancellation.cancelled() => Err(ServiceError::SessionNotActive(id.clone())),
                result = tokio::time::timeout(INITIALIZATION_TIMEOUT, service.initialize_deferred(&id, &run)) =>
                    result.unwrap_or_else(|_| Err(ServiceError::CommandFailed(
                        "Session initialization timed out after 90 seconds; retry initialization".into()
                    ))),
            };
            if let Err(error) = result {
                service
                    .fail_initialization(&id, &run, error.to_string())
                    .await;
            }
        });
    }

    async fn initialize_deferred(&self, id: &str, run: &Arc<InitializationRun>) -> Result<()> {
        self.require_accepting_work()?;
        self.sync_initial_session_name(id).await?;
        let client = self.client().await?;
        let params = Some(serde_json::json!({ "sessionId": id }));
        let started = Instant::now();
        client
            .call("session.tools.initializeAndValidate", params.clone())
            .await?;
        tracing::info!(session_id = %id, stage = "tools", elapsed_ms = started.elapsed().as_millis(), "session startup");
        {
            let registry = self.initializations.write().await;
            self.check_initialization(&registry, id, run).await?;
            self.publish_initialization(
                id,
                run,
                InitializationSnapshot {
                    phase: InitializationPhase::Initializing,
                    stage: InitializationStage::Model,
                    error: None,
                },
            )
            .await;
        }
        let started = Instant::now();
        let current = client.call("session.model.getCurrent", params).await?;
        tracing::info!(session_id = %id, stage = "model", elapsed_ms = started.elapsed().as_millis(), "session startup");
        let registry = self.initializations.write().await;
        self.check_initialization(&registry, id, run).await?;
        // Only the final short commit owns shared locks. Never hold lifecycle,
        // registry, or turn guards across native tools/model RPCs.
        let _write_guard = self.metadata_write_gate.lock().await;
        let mut metadata = self.metadata.write().await;
        let mut candidate = metadata.clone();
        let meta = candidate
            .get_mut(id)
            .ok_or_else(|| ServiceError::SessionNotActive(id.into()))?;
        if let Some(model) = crate::optional_value_string(&current, "modelId") {
            meta.model = Some(model);
        }
        self.write_metadata(&candidate)?;
        *metadata = candidate;
        self.warmed.write().await.insert(id.into());
        let mut cache = self.session_cache.write().await;
        if let Some(summary) = cache.iter_mut().find(|item| item.session_id == id) {
            apply_metadata(summary, &metadata[id]);
            summary.initialization = Some(InitializationSnapshot::ready());
        }
        run.state.send_replace(InitializationSnapshot::ready());
        self.events.emit(AppEvent::SessionInitializationChanged {
            session_id: id.into(),
            initialization: InitializationSnapshot::ready(),
        });
        Ok(())
    }

    async fn check_initialization(
        &self,
        registry: &InitializationRegistry,
        id: &str,
        run: &Arc<InitializationRun>,
    ) -> Result<()> {
        self.require_accepting_work()?;
        if registry
            .runs
            .get(id)
            .is_some_and(|current| Arc::ptr_eq(current, run))
            && run.state.borrow().phase == InitializationPhase::Initializing
            && run
                .session
                .upgrade()
                .is_some_and(|session| !session.cancellation_token().is_cancelled())
            && self
                .active
                .read()
                .await
                .get(id)
                .is_some_and(|session| Weak::ptr_eq(&Arc::downgrade(session), &run.session))
        {
            Ok(())
        } else {
            Err(ServiceError::SessionNotActive(id.into()))
        }
    }

    // Caller owns the registry lock, serializing status/cache/event publication
    // with retries, deletion, drain, and a final metadata commit.
    async fn publish_initialization(
        &self,
        id: &str,
        run: &InitializationRun,
        snapshot: InitializationSnapshot,
    ) {
        if let Some(summary) = self
            .session_cache
            .write()
            .await
            .iter_mut()
            .find(|item| item.session_id == id)
        {
            summary.initialization = Some(snapshot.clone());
        }
        run.state.send_replace(snapshot.clone());
        self.events.emit(AppEvent::SessionInitializationChanged {
            session_id: id.into(),
            initialization: snapshot,
        });
    }

    async fn fail_initialization(&self, id: &str, run: &Arc<InitializationRun>, error: String) {
        let registry = self.initializations.write().await;
        if registry
            .runs
            .get(id)
            .is_some_and(|current| Arc::ptr_eq(current, run))
        {
            let mut snapshot = run.state.borrow().clone();
            if snapshot.phase == InitializationPhase::Initializing {
                snapshot.phase = InitializationPhase::Failed;
                snapshot.error = Some(error);
                self.publish_initialization(id, run, snapshot).await;
            }
        }
    }

    async fn fail_recovery(&self, id: &str, run: &Arc<InitializationRun>, error: String) {
        let registry = self.initializations.write().await;
        if registry
            .runs
            .get(id)
            .is_some_and(|current| Arc::ptr_eq(current, run))
        {
            let mut snapshot = run.state.borrow().clone();
            snapshot.phase = InitializationPhase::Failed;
            snapshot.error = Some(error);
            self.publish_initialization(id, run, snapshot).await;
        }
    }

    pub(crate) async fn forget_initialization(&self, id: &str) -> Result<DeletedSessionState> {
        let mut registry = self.initializations.write().await;
        if registry.deleted.contains(id) {
            return Err(ServiceError::SessionNotActive(id.into()));
        }
        let run = registry.runs.remove(id);
        if let Some(run) = &run {
            let mut snapshot = run.state.borrow().clone();
            snapshot.phase = InitializationPhase::Failed;
            snapshot.error = Some("Session deletion requested".into());
            run.state.send_replace(snapshot);
        }
        registry.deleted.insert(id.into());
        let active = self.active.write().await.remove(id);
        let warmed = self.warmed.write().await.remove(id);
        let mut cache = self.session_cache.write().await;
        let summary = cache
            .iter()
            .position(|item| item.session_id == id)
            .map(|index| cache.remove(index));
        Ok(DeletedSessionState {
            run,
            active,
            warmed,
            summary,
        })
    }

    pub(crate) async fn restore_failed_deletion(
        &self,
        id: &str,
        previous: DeletedSessionState,
        error: &ServiceError,
    ) {
        let mut registry = self.initializations.write().await;
        registry.deleted.remove(id);
        let mut active = self.active.write().await;
        if let Some(session) = previous
            .active
            .filter(|session| !session.cancellation_token().is_cancelled())
        {
            active.insert(id.into(), session);
        }
        let attached = active.contains_key(id);
        drop(active);
        if let Some(run) = &previous.run {
            registry.runs.insert(id.into(), run.clone());
        } else if previous.warmed && attached {
            self.warmed.write().await.insert(id.into());
        }
        let metadata = self.metadata.read().await;
        if let Some(mut summary) = previous.summary {
            if let Some(meta) = metadata.get(id) {
                apply_metadata(&mut summary, meta);
            }
            summary.is_active = attached;
            summary.initialization = registry.snapshot(id);
            let mut cache = self.session_cache.write().await;
            if let Some(existing) = cache.iter_mut().find(|item| item.session_id == id) {
                *existing = summary;
            } else {
                cache.push(summary);
            }
        }
        drop(metadata);
        if let Some(run) = previous.run {
            let mut snapshot = run.state.borrow().clone();
            snapshot.phase = InitializationPhase::Failed;
            snapshot.error = Some(format!(
                "Deletion failed: {error}. Retry initialization to continue using this session."
            ));
            self.publish_initialization(id, &run, snapshot).await;
        }
    }

    pub(crate) async fn cancel_initializations(&self, reason: &str, include_ready: bool) {
        let registry = self.initializations.write().await;
        for (id, run) in &registry.runs {
            let mut snapshot = run.state.borrow().clone();
            if snapshot.phase == InitializationPhase::Initializing || include_ready {
                snapshot.phase = InitializationPhase::Failed;
                snapshot.error = Some(reason.into());
                self.publish_initialization(id, run, snapshot).await;
            }
        }
    }

    pub(crate) async fn disconnect_initialization(&self, id: &str, session: &Arc<Session>) {
        let registry = self.initializations.write().await;
        let Some(run) = registry
            .runs
            .get(id)
            .filter(|run| Weak::ptr_eq(&run.session, &Arc::downgrade(session)))
        else {
            return;
        };
        let mut active = self.active.write().await;
        if !active
            .get(id)
            .is_some_and(|current| Arc::ptr_eq(current, session))
        {
            return;
        }
        active.remove(id);
        drop(active);
        self.warmed.write().await.remove(id);
        let mut snapshot = run.state.borrow().clone();
        snapshot.phase = InitializationPhase::Failed;
        snapshot.error = Some("Session is disconnected; resume it after reconnecting".into());
        self.publish_initialization(id, run, snapshot).await;
        if let Some(summary) = self
            .session_cache
            .write()
            .await
            .iter_mut()
            .find(|item| item.session_id == id)
        {
            summary.is_active = false;
        }
    }
}

pub(crate) fn not_ready(session_id: &str, snapshot: &InitializationSnapshot) -> ServiceError {
    ServiceError::SessionNotReady {
        session_id: session_id.into(),
        reason: snapshot
            .error
            .clone()
            .unwrap_or_else(|| format!("initializing {:?}", snapshot.stage)),
    }
}
