use std::cmp::Reverse;
mod agent_tasks;
#[cfg(test)]
mod agent_tasks_tests;
mod attachments;
mod event_projection;
mod interactions;
mod initialization;
mod native_user_input;
mod runtime_api;
mod scheduled;
mod session_actions;
mod session_archive;
#[cfg(test)]
mod session_archive_tests;
pub mod git_workspace;
#[cfg(test)]
mod session_actions_tests;
#[cfg(test)]
mod runtime_tests;
mod tool_catalog;
mod tool_controls;

pub use agent_tasks::{
    AgentHistory, AgentHistoryRequest, AgentTask, AgentTasks, AgentTasksRequest,
    SendAgentMessageRequest, TasksSendMessageResult,
};
pub use event_projection::project_app_event;
pub use interactions::{InteractionKind, InteractionResponse, PendingInteraction};
pub use initialization::{InitializationPhase, InitializationSnapshot, InitializationStage, SessionInitialization};
pub use runtime_api::{
    QueueAction, SendMessageRequest, SessionState, SetSessionMode, SetSessionModeResult,
};
pub use scheduled::ScheduledDelivery;
pub use session_actions::{AskSessionRequest, AskSessionResult, ForkSessionRequest, RenameSessionRequest};
pub use session_archive::SetSessionArchived;
pub use tool_controls::{AdoptToolControls, SetMcpEnabled, SetToolEnabled, ToolControls};

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use futures_util::future::join_all;
use github_copilot_sdk::handler::{PermissionHandler, PermissionResult};
use github_copilot_sdk::session::Session;
use github_copilot_sdk::session_events::ReasoningSummary;
use github_copilot_sdk::types::{
    AgentMode, MessageOptions, PermissionRequestData, RequestId, ResumeSessionConfig,
    SessionConfig, SessionEvent, SessionId,
};
use github_copilot_sdk::{Client, ClientOptions};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex as AsyncMutex, RwLock, broadcast, oneshot};

const APPROVAL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const HISTORY_PAGE_SIZE: usize = 200;
const HISTORY_WINDOW_PAGE_SIZE: usize = 1000;
const HISTORY_WINDOW_MIN_HUMAN_MESSAGES: usize = 3;
const HISTORY_WINDOW_MAX_EVENTS: usize = 4000;
const HISTORY_ANCHOR_SCAN_SIZE: usize = 32;
const EVENT_REPLAY_CAPACITY: usize = 8192;
const CONVERSATION_EVENT_TYPES: &[&str] = &[
    "user.message",
    "assistant.message",
    "assistant.message_start",
    "assistant.message_delta",
    "assistant.streaming_delta",
    "assistant.tool_call_delta",
    "assistant.reasoning",
    "assistant.reasoning_delta",
    "assistant.turn_start",
    "assistant.turn_end",
    "tool.execution_start",
    "tool.execution_progress",
    "tool.execution_partial_result",
    "tool.execution_complete",
    "subagent.started",
    "subagent.completed",
    "subagent.failed",
    "session.model_change",
    "session.compaction_start",
];

#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    #[error("{0}")]
    Copilot(#[from] github_copilot_sdk::Error),
    #[error("session {0} is not active")]
    SessionNotActive(String),
    #[error("permission request {0} is no longer pending")]
    PermissionNotPending(String),
    #[error("interaction request {0} is no longer pending")]
    InteractionNotPending(String),
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    #[error("runtime capability unavailable: {0}")]
    CapabilityUnavailable(String),
    #[error("invalid working directory: {0}")]
    InvalidWorkingDirectory(String),
    #[error("could not persist session metadata: {0}")]
    Persistence(String),
    #[error("slash command failed: {0}")]
    CommandFailed(String),
    #[error("Copilot is disconnected")]
    CopilotDisconnected,
    #[error("Copilot is draining and not accepting new work")]
    Draining,
    #[error(
        "session {0} is currently processing; wait for its turn to finish before this operation"
    )]
    SessionProcessing(String),
    #[error("session {session_id} is not ready: {reason}")]
    SessionNotReady { session_id: String, reason: String },
}

pub type Result<T> = std::result::Result<T, ServiceError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_id: String,
    pub title: String,
    pub start_time: String,
    pub modified_time: String,
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub is_active: bool,
    pub is_remote: bool,
    pub pinned: bool,
    #[serde(default)]
    pub archived: bool,
    pub folder: Option<String>,
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initialization: Option<InitializationSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSession {
    pub cwd: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub reasoning_summary: Option<String>,
    pub context_tier: Option<String>,
    #[serde(default)]
    pub defer_initialization: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDecision {
    pub request_id: String,
    pub approved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationUpdate {
    pub session_id: String,
    pub pinned: bool,
    pub folder: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub events: Vec<SessionEvent>,
    pub has_more: bool,
    pub cursor: String,
    pub loaded_pages: usize,
    pub human_messages: usize,
    pub window_start_event_id: Option<String>,
    pub truncated_before_anchor: bool,
}

fn is_human_message(event: &SessionEvent) -> bool {
    event.event_type == "user.message"
        && event.agent_id.is_none()
        && match event.data.get("source") {
            None | Some(serde_json::Value::Null) => true,
            Some(serde_json::Value::String(source)) => source.is_empty() || source == "user",
            _ => false,
        }
}

fn human_history_anchor(events: &[SessionEvent]) -> Option<String> {
    events
        .iter()
        .rev()
        .filter(|event| is_human_message(event))
        .take(HISTORY_WINDOW_MIN_HUMAN_MESSAGES)
        .last()
        .map(|event| event.id.clone())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRefresh {
    pub session: SessionSummary,
    pub history: HistoryPage,
    pub runtime_recycled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceSection {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReferences {
    pub commands: ReferenceSection,
    pub skills: ReferenceSection,
    pub mcp: ReferenceSection,
    pub mcp_tools: ReferenceSection,
    pub tools: ReferenceSection,
    pub instructions: ReferenceSection,
    pub context_attribution: ReferenceSection,
    pub tasks: ReferenceSection,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub connected: bool,
    pub accepting_work: bool,
    pub active_sessions: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainStatus {
    pub complete: bool,
    pub processing_sessions: Vec<String>,
    pub disconnected_sessions: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOperationResult {
    pub session_id: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AppEvent {
    SessionEvent {
        session_id: String,
        event: SessionEvent,
    },
    PermissionRequested {
        session_id: String,
        request_id: String,
        request: PermissionRequestData,
    },
    PermissionResolved {
        session_id: String,
        request_id: String,
        approved: bool,
    },
    InteractionRequested {
        interaction: PendingInteraction,
    },
    InteractionResolved {
        session_id: String,
        request_id: String,
    },
    ToolInventoryUpdated {
        session_id: String,
    },
    RuntimeStatus {
        status: RuntimeStatus,
    },
    SessionAttached {
        session_id: String,
    },
    SessionDeleted {
        session_id: String,
    },
    SessionArchiveChanged {
        session_id: String,
        archived: bool,
    },
    SessionInitializationChanged {
        session_id: String,
        initialization: InitializationSnapshot,
    },
    EventGap {
        session_id: Option<String>,
        skipped: u64,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SequencedAppEvent {
    pub sequence: u64,
    #[serde(flatten)]
    pub event: AppEvent,
}

struct EventBusState {
    next_sequence: u64,
    history: VecDeque<SequencedAppEvent>,
}

struct EventBus {
    sender: broadcast::Sender<SequencedAppEvent>,
    state: Mutex<EventBusState>,
}

impl EventBus {
    fn new() -> Arc<Self> {
        let (sender, _) = broadcast::channel(512);
        Arc::new(Self {
            sender,
            state: Mutex::new(EventBusState {
                next_sequence: 1,
                history: VecDeque::with_capacity(EVENT_REPLAY_CAPACITY),
            }),
        })
    }

    fn emit(&self, event: AppEvent) -> u64 {
        let mut state = self.state.lock().expect("event bus poisoned");
        let sequence = state.next_sequence;
        state.next_sequence += 1;
        let event = SequencedAppEvent { sequence, event };
        state.history.push_back(event.clone());
        while state.history.len() > EVENT_REPLAY_CAPACITY {
            state.history.pop_front();
        }
        let _ = self.sender.send(event);
        sequence
    }

    fn subscribe(self: &Arc<Self>, after: Option<u64>) -> EventSubscription {
        let state = self.state.lock().expect("event bus poisoned");
        let receiver = self.sender.subscribe();
        let latest = state
            .history
            .back()
            .map(|event| event.sequence)
            .unwrap_or_default();
        let last_sequence = after
            .filter(|sequence| *sequence <= latest)
            .unwrap_or(latest);
        let replay = replay_after(&state.history, last_sequence);
        EventSubscription {
            bus: Arc::clone(self),
            receiver,
            replay,
            last_sequence,
        }
    }
}

pub struct EventSubscription {
    bus: Arc<EventBus>,
    receiver: broadcast::Receiver<SequencedAppEvent>,
    replay: VecDeque<SequencedAppEvent>,
    last_sequence: u64,
}

impl EventSubscription {
    pub async fn recv(&mut self) -> Option<SequencedAppEvent> {
        loop {
            if let Some(event) = self.replay.pop_front() {
                self.last_sequence = event.sequence;
                return Some(event);
            }

            match self.receiver.recv().await {
                Ok(event) if event.sequence <= self.last_sequence => continue,
                Ok(event) if event.sequence == self.last_sequence + 1 => {
                    self.last_sequence = event.sequence;
                    return Some(event);
                }
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {
                    let state = self.bus.state.lock().expect("event bus poisoned");
                    self.replay = replay_after(&state.history, self.last_sequence);
                }
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    }
}

fn replay_after(
    history: &VecDeque<SequencedAppEvent>,
    last_sequence: u64,
) -> VecDeque<SequencedAppEvent> {
    let mut replay = VecDeque::new();
    let Some(first) = history
        .iter()
        .find(|event| event.sequence > last_sequence)
        .cloned()
    else {
        return replay;
    };

    if first.sequence > last_sequence + 1 {
        replay.push_back(SequencedAppEvent {
            sequence: first.sequence - 1,
            event: AppEvent::EventGap {
                session_id: None,
                skipped: first.sequence - last_sequence - 1,
            },
        });
    }
    replay.extend(
        history
            .iter()
            .filter(|event| event.sequence >= first.sequence)
            .cloned(),
    );
    replay
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
struct StoredSessionMeta {
    cwd: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    reasoning_summary: Option<String>,
    context_tier: Option<String>,
    title: Option<String>,
    pinned: bool,
    archived: bool,
    folder: Option<String>,
    tags: Vec<String>,
    tool_exclusions: Vec<String>,
    tool_controls_managed: bool,
    tool_controls_created: bool,
    tool_available_tools: Option<Vec<String>>,
    prevent_pending_work: bool,
}

struct ApprovalBroker {
    events: Arc<EventBus>,
    pending: Mutex<HashMap<String, PendingApproval>>,
}

struct PendingApproval {
    sender: oneshot::Sender<bool>,
    session_id: String,
    request: PermissionRequestData,
}

impl ApprovalBroker {
    fn resolve(&self, decision: PermissionDecision) -> Result<()> {
        let pending = self
            .pending
            .lock()
            .expect("approval map poisoned")
            .remove(&decision.request_id)
            .ok_or_else(|| ServiceError::PermissionNotPending(decision.request_id.clone()))?;
        let session_id = pending.session_id.clone();
        let _ = pending.sender.send(decision.approved);
        self.events.emit(AppEvent::PermissionResolved {
            session_id,
            request_id: decision.request_id,
            approved: decision.approved,
        });
        Ok(())
    }

    fn list(&self) -> Vec<AppEvent> {
        self.pending
            .lock()
            .expect("approval map poisoned")
            .iter()
            .map(|(request_id, pending)| AppEvent::PermissionRequested {
                session_id: pending.session_id.clone(),
                request_id: request_id.clone(),
                request: pending.request.clone(),
            })
            .collect()
    }

    fn clear_session(&self, session_id: &str) {
        self.pending
            .lock()
            .expect("approval map poisoned")
            .retain(|_, pending| pending.session_id != session_id);
    }

    fn clear(&self) {
        self.pending.lock().expect("approval map poisoned").clear();
    }
}

#[async_trait]
impl PermissionHandler for ApprovalBroker {
    async fn handle(
        &self,
        session_id: SessionId,
        request_id: RequestId,
        data: PermissionRequestData,
    ) -> PermissionResult {
        if data.managed_approval_required == Some(true) {
            return PermissionResult::user_not_available();
        }

        let request_id = request_id.to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().expect("approval map poisoned").insert(
            request_id.clone(),
            PendingApproval {
                sender: tx,
                session_id: session_id.to_string(),
                request: data.clone(),
            },
        );
        self.events.emit(AppEvent::PermissionRequested {
            session_id: session_id.to_string(),
            request_id: request_id.clone(),
            request: data,
        });

        let approved = tokio::time::timeout(APPROVAL_TIMEOUT, rx)
            .await
            .ok()
            .and_then(std::result::Result::ok)
            .unwrap_or(false);
        self.pending
            .lock()
            .expect("approval map poisoned")
            .remove(&request_id);

        if approved {
            PermissionResult::approve_once()
        } else {
            PermissionResult::reject(Some("Denied in Copilot Sessions".to_string()))
        }
    }
}

pub struct SessionService {
    client: RwLock<Option<Client>>,
    accepting_work: AtomicBool,
    active: RwLock<HashMap<String, Arc<Session>>>,
    warmed: RwLock<HashSet<String>>,
    initializations: RwLock<initialization::InitializationRegistry>,
    turn_gates: RwLock<HashMap<String, Arc<AsyncMutex<()>>>>,
    ask_gates: RwLock<HashMap<String, Arc<AsyncMutex<()>>>>,
    last_submissions: RwLock<HashMap<String, tokio::time::Instant>>,
    create_gate: AsyncMutex<()>,
    runtime_gate: AsyncMutex<()>,
    lifecycle_gate: RwLock<()>,
    session_cache: RwLock<Vec<SessionSummary>>,
    events: Arc<EventBus>,
    approvals: Arc<ApprovalBroker>,
    interactions: Arc<interactions::InteractionBroker>,
    tool_state: RwLock<HashMap<String, tool_controls::SessionToolState>>,
    tool_catalog: tool_catalog::ToolCatalog,
    metadata_path: PathBuf,
    metadata: RwLock<HashMap<String, StoredSessionMeta>>,
    metadata_write_gate: AsyncMutex<()>,
}

impl SessionService {
    pub async fn start(data_dir: impl Into<PathBuf>) -> Result<Arc<Self>> {
        let data_dir = data_dir.into();
        std::fs::create_dir_all(&data_dir).map_err(|e| ServiceError::Persistence(e.to_string()))?;
        let metadata_path = data_dir.join("sessions.json");
        let metadata = load_metadata(&metadata_path);
        let events = EventBus::new();
        let approvals = Arc::new(ApprovalBroker {
            events: events.clone(),
            pending: Mutex::new(HashMap::new()),
        });
        let interactions = Arc::new(interactions::InteractionBroker::new(events.clone()));
        let client = Client::start(ClientOptions::default()).await?;

        Ok(Arc::new(Self {
            client: RwLock::new(Some(client)),
            accepting_work: AtomicBool::new(true),
            active: RwLock::new(HashMap::new()),
            warmed: RwLock::new(HashSet::new()),
            initializations: RwLock::new(Default::default()),
            turn_gates: RwLock::new(HashMap::new()),
            ask_gates: RwLock::new(HashMap::new()),
            last_submissions: RwLock::new(HashMap::new()),
            create_gate: AsyncMutex::new(()),
            runtime_gate: AsyncMutex::new(()),
            lifecycle_gate: RwLock::new(()),
            session_cache: RwLock::new(Vec::new()),
            events,
            approvals,
            interactions,
            tool_state: RwLock::new(HashMap::new()),
            tool_catalog: tool_catalog::ToolCatalog::default(),
            metadata_path,
            metadata: RwLock::new(metadata),
            metadata_write_gate: AsyncMutex::new(()),
        }))
    }

    pub fn default_data_dir() -> PathBuf {
        dirs::data_local_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("copilot-sessions")
    }

    pub fn data_dir(&self) -> &Path {
        self.metadata_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
    }

    pub fn subscribe(&self, after: Option<u64>) -> EventSubscription {
        self.events.subscribe(after)
    }

    pub async fn list_sessions(&self) -> Result<Vec<SessionSummary>> {
        let Ok(client) = self.client().await else {
            return Ok(self.session_cache.read().await.clone());
        };
        let response = client
            .call("session.list", Some(serde_json::json!({})))
            .await?;
        let mut sessions = response
            .get("sessions")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();
        sessions.sort_by_key(|session| Reverse(value_string(session, "modifiedTime")));
        let initializations = self.initializations.read().await;
        let active = self.active.read().await;
        let metadata = self.metadata.read().await;
        let mut summaries = sessions
            .into_iter()
            .filter(|session| !initializations.deleted.contains(&value_string(session, "sessionId")))
            .map(|session| {
                let id = value_string(&session, "sessionId");
                let local = metadata.get(&id);
                let context = session.get("context");
                let cwd = local.and_then(|m| m.cwd.clone()).or_else(|| {
                    context
                        .and_then(|value| {
                            value.get("workingDirectory").or_else(|| value.get("cwd"))
                        })
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned)
                });
                let model = local.and_then(|m| m.model.clone()).or_else(|| {
                    session
                        .get("model")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned)
                });
                SessionSummary {
                    session_id: id.clone(),
                    title: local
                        .and_then(|m| m.title.clone())
                        .or_else(|| optional_value_string(&session, "summary"))
                        .unwrap_or_else(|| "Untitled session".to_string()),
                    start_time: value_string(&session, "startTime"),
                    modified_time: value_string(&session, "modifiedTime"),
                    cwd,
                    model,
                    is_active: active.contains_key(&id),
                    is_remote: session
                        .get("isRemote")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false),
                    pinned: local.is_some_and(|meta| meta.pinned),
                    archived: local.is_some_and(|meta| meta.archived),
                    folder: local.and_then(|meta| meta.folder.clone()),
                    tags: local.map(|meta| meta.tags.clone()).unwrap_or_default(),
                    initialization: initializations.snapshot(&id),
                }
            })
            .collect::<Vec<_>>();
        let mut cache = self.session_cache.write().await;
        // Native indexing can lag creation. Merge against the current cache,
        // not a snapshot taken before session.list's RPC.
        for cached in cache.iter().filter(|cached| {
            !initializations.deleted.contains(&cached.session_id)
                && (active.contains_key(&cached.session_id)
                    || initializations.runs.contains_key(&cached.session_id))
        }) {
            if !summaries.iter().any(|item| item.session_id == cached.session_id) {
                let mut summary = cached.clone();
                summary.is_active = active.contains_key(&summary.session_id);
                summary.initialization = initializations.snapshot(&summary.session_id);
                if let Some(meta) = metadata.get(&summary.session_id) {
                    initialization::apply_metadata(&mut summary, meta);
                }
                summaries.push(summary);
            }
        }
        summaries.sort_by_key(|session| (!session.pinned, Reverse(session.modified_time.clone())));
        *cache = summaries.clone();
        Ok(summaries)
    }

    pub async fn create_session(self: &Arc<Self>, request: NewSession) -> Result<SessionSummary> {
        if request.defer_initialization {
            let service = Arc::clone(self);
            // Once accepted, HTTP cancellation must not strand an SDK session
            // between creation, persistence, attachment, and warmup scheduling.
            return tokio::spawn(async move { service.create_session_inner(request).await })
                .await
                .map_err(|error| ServiceError::CommandFailed(format!("Session creation failed: {error}")))?;
        }
        self.create_session_inner(request).await
    }

    async fn create_session_inner(self: &Arc<Self>, request: NewSession) -> Result<SessionSummary> {
        let _create = self
            .create_gate
            .try_lock()
            .map_err(|_| ServiceError::SessionProcessing("creation".into()))?;
        let _lifecycle = self.lifecycle_gate.read().await;
        self.require_accepting_work()?;
        validate_cwd(&request.cwd)?;
        let mut config = SessionConfig::default()
            .with_working_directory(&request.cwd)
            .with_streaming(true)
            .with_excluded_tools(Vec::<String>::new())
            .with_permission_handler(self.approvals.clone())
            .with_user_input_handler(self.interactions.clone())
            .with_elicitation_handler(self.interactions.clone())
            .with_exit_plan_mode_handler(self.interactions.clone())
            .with_auto_mode_switch_handler(self.interactions.clone());
        if let Some(model) = request.model.as_deref().filter(|m| !m.is_empty()) {
            config = config.with_model(model);
        }
        if let Some(effort) = request
            .reasoning_effort
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            config = config.with_reasoning_effort(effort);
        }
        if let Some(summary) = request
            .reasoning_summary
            .as_deref()
            .and_then(parse_reasoning_summary)
        {
            config = config.with_reasoning_summary(summary);
        }
        if let Some(tier) = request
            .context_tier
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            config = config.with_context_tier(tier);
        }
        let started = std::time::Instant::now();
        let session = Arc::new(self.client().await?.create_session(config).await?);
        let id = session.id().to_string();
        tracing::info!(session_id = %id, stage = "create", elapsed_ms = started.elapsed().as_millis(), "session startup");
        self.metadata.write().await.insert(
            id.clone(),
            StoredSessionMeta {
                cwd: Some(request.cwd.clone()),
                model: request.model.clone(),
                reasoning_effort: request.reasoning_effort.clone(),
                reasoning_summary: request.reasoning_summary.clone(),
                context_tier: request.context_tier.clone(),
                title: None,
                pinned: false,
                archived: false,
                folder: None,
                tags: Vec::new(),
                tool_exclusions: Vec::new(),
                tool_controls_managed: true,
                tool_controls_created: true,
                tool_available_tools: None,
                prevent_pending_work: request.defer_initialization,
            },
        );
        self.persist_metadata().await?;
        if request.defer_initialization {
            return self.attach_deferred(session).await;
        }
        self.attach(session).await?;
        self.initialize_environment(&id).await?;
        self.refresh_model(&id).await?;
        let metadata = self.metadata.read().await;
        let local = metadata.get(&id);
        let model = local.and_then(|meta| meta.model.clone());
        let summary = SessionSummary {
            session_id: id,
            title: "New session".to_string(),
            start_time: String::new(),
            modified_time: String::new(),
            cwd: Some(request.cwd),
            model,
            is_active: true,
            is_remote: false,
            pinned: false,
            archived: local.is_some_and(|meta| meta.archived),
            folder: None,
            tags: Vec::new(),
            initialization: None,
        };
        self.session_cache.write().await.push(summary.clone());
        Ok(summary)
    }

    pub async fn resume_session(self: &Arc<Self>, session_id: String) -> Result<SessionSummary> {
        self.require_accepting_work()?;
        self.resume_session_with_pending_work(session_id, true)
            .await
    }

    async fn resume_session_with_pending_work(
        self: &Arc<Self>,
        session_id: String,
        continue_pending_work: bool,
    ) -> Result<SessionSummary> {
        if let Some(summary) = self.join_initialization(&session_id).await? {
            return Ok(summary);
        }
        let _lifecycle = self.lifecycle_gate.read().await;
        self.resume_session_with_pending_work_locked(session_id, continue_pending_work).await
    }

    async fn resume_session_with_pending_work_locked(
        self: &Arc<Self>,
        session_id: String,
        continue_pending_work: bool,
    ) -> Result<SessionSummary> {
        let gate = self.turn_gate(&session_id).await;
        let _guard = gate.lock().await;
        self.require_accepting_work()?;
        self.require_initialized(&session_id).await?;
        if !self.active.read().await.contains_key(&session_id) {
            let session = self.resume_handle(&session_id, continue_pending_work).await?;
            self.attach(session).await?;
            self.refresh_model(&session_id).await?;
        }
        self.initialize_environment(&session_id).await?;
        let metadata = self.metadata.read().await;
        let meta = metadata.get(&session_id);
        let mut cache = self.session_cache.write().await;
        if let Some(summary) = cache
            .iter_mut()
            .find(|summary| summary.session_id == session_id)
        {
            summary.is_active = true;
            summary.initialization = None;
            if let Some(meta) = meta {
                summary.cwd = meta.cwd.clone();
                summary.model = meta.model.clone();
                summary.pinned = meta.pinned;
                summary.archived = meta.archived;
                summary.folder = meta.folder.clone();
                summary.tags = meta.tags.clone();
            }
            return Ok(summary.clone());
        }
        drop(cache);
        drop(metadata);
        if let Some(summary) = self
            .list_sessions()
            .await?
            .into_iter()
            .find(|summary| summary.session_id == session_id)
        {
            return Ok(summary);
        }
        let local = self
            .metadata
            .read()
            .await
            .get(&session_id)
            .cloned()
            .unwrap_or_default();
        Ok(SessionSummary {
            session_id,
            title: local.title.unwrap_or_else(|| "Session".to_string()),
            start_time: String::new(),
            modified_time: String::new(),
            cwd: local.cwd,
            model: local.model,
            is_active: true,
            is_remote: false,
            pinned: local.pinned,
            archived: local.archived,
            folder: local.folder,
            tags: local.tags,
            initialization: None,
        })
    }

    async fn resume_handle(&self, session_id: &str, continue_pending_work: bool) -> Result<Arc<Session>> {
        let meta = self.metadata.read().await.get(session_id).cloned();
        let mut config = ResumeSessionConfig::new(SessionId::new(session_id))
            .with_streaming(true)
            .with_continue_pending_work(continue_pending_work && !meta.as_ref().is_some_and(|meta| meta.prevent_pending_work))
            .with_permission_handler(self.approvals.clone())
            .with_user_input_handler(self.interactions.clone())
            .with_elicitation_handler(self.interactions.clone())
            .with_exit_plan_mode_handler(self.interactions.clone())
            .with_auto_mode_switch_handler(self.interactions.clone());
        if let Some(meta) = meta
            .as_ref()
            .filter(|meta| meta.tool_controls_managed && meta.tool_controls_created)
        {
            config = config.with_excluded_tools(meta.tool_exclusions.clone());
            if let Some(available) = &meta.tool_available_tools {
                config = config.with_available_tools(available.clone());
            }
        }
        if let Some(cwd) = meta.as_ref().and_then(|m| m.cwd.as_deref()) {
            config = config.with_working_directory(cwd);
        }
        if let Some(model) = meta.as_ref().and_then(|m| m.model.as_deref()) {
            config = config.with_model(model);
        }
        if let Some(effort) = meta.as_ref().and_then(|m| m.reasoning_effort.as_deref()) {
            config = config.with_reasoning_effort(effort);
        }
        let summary = meta
            .as_ref()
            .and_then(|m| m.reasoning_summary.as_deref())
            .unwrap_or("detailed");
        if let Some(summary) = parse_reasoning_summary(summary) {
            config = config.with_reasoning_summary(summary);
        }
        if let Some(tier) = meta.as_ref().and_then(|m| m.context_tier.as_deref()) {
            config = config.with_context_tier(tier);
        }
        Ok(Arc::new(self.client().await?.resume_session(config).await?))
    }

    pub async fn refresh_session(self: &Arc<Self>, session_id: String) -> Result<SessionRefresh> {
        self.require_accepting_work()?;
        // Catch-up is a read/reattach operation, never runtime maintenance.
        // An active turn (including one in another session) must be left intact.
        let mut session = self
            .resume_session_with_pending_work(session_id.clone(), false)
            .await?;
        let snapshot = self
            .client()
            .await?
            .call(
                "session.metadata.snapshot",
                Some(serde_json::json!({ "sessionId": session_id })),
            )
            .await?;
        if let Some(model) = optional_value_string(&snapshot, "selectedModel") {
            session.model = Some(model);
        }
        if let Some(cwd) = optional_value_string(&snapshot, "workingDirectory") {
            session.cwd = Some(cwd);
        }
        if let Some(modified) = optional_value_string(&snapshot, "modifiedTime") {
            session.modified_time = modified;
        }
        let history = self.recent_history(&session_id).await?;
        Ok(SessionRefresh {
            session,
            history,
            runtime_recycled: false,
        })
    }

    pub async fn history(&self, session_id: &str, cursor: Option<String>) -> Result<HistoryPage> {
        self.read_history_page(
            session_id,
            cursor,
            HISTORY_PAGE_SIZE,
            serde_json::json!(CONVERSATION_EVENT_TYPES),
            None,
        )
        .await
    }

    pub async fn recent_history(&self, session_id: &str) -> Result<HistoryPage> {
        let anchor_id = self.recent_human_anchor(session_id).await?;
        let mut window = self
            .read_history_page(
                session_id,
                None,
                HISTORY_WINDOW_PAGE_SIZE,
                serde_json::json!(CONVERSATION_EVENT_TYPES),
                None,
            )
            .await?;

        while window.has_more
            && anchor_id
                .as_ref()
                .is_some_and(|anchor| !window.events.iter().any(|event| event.id == *anchor))
            && window.events.len() < HISTORY_WINDOW_MAX_EVENTS
        {
            let older = self
                .read_history_page(
                    session_id,
                    Some(window.cursor.clone()),
                    HISTORY_WINDOW_PAGE_SIZE,
                    serde_json::json!(CONVERSATION_EVENT_TYPES),
                    None,
                )
                .await?;
            let mut events = older.events;
            events.append(&mut window.events);
            window = HistoryPage {
                events,
                has_more: older.has_more,
                cursor: older.cursor,
                loaded_pages: window.loaded_pages + older.loaded_pages,
                human_messages: window.human_messages + older.human_messages,
                window_start_event_id: None,
                truncated_before_anchor: false,
            };
        }
        window.window_start_event_id = anchor_id
            .clone()
            .filter(|anchor| window.events.iter().any(|event| event.id == *anchor));
        if let Some(anchor) = window.window_start_event_id.as_deref()
            && let Some(index) = window.events.iter().position(|event| event.id == anchor)
        {
            window.human_messages = window.events[index..]
                .iter()
                .filter(|event| is_human_message(event))
                .count();
        }
        window.truncated_before_anchor =
            anchor_id.is_some() && window.window_start_event_id.is_none() && window.has_more;
        Ok(window)
    }

    async fn recent_human_anchor(&self, session_id: &str) -> Result<Option<String>> {
        let page = self
            .read_history_page(
                session_id,
                None,
                HISTORY_ANCHOR_SCAN_SIZE,
                serde_json::json!(["user.message"]),
                Some("primary"),
            )
            .await?;
        Ok(human_history_anchor(&page.events))
    }

    async fn read_history_page(
        &self,
        session_id: &str,
        cursor: Option<String>,
        max: usize,
        types: serde_json::Value,
        agent_scope: Option<&str>,
    ) -> Result<HistoryPage> {
        let client = self.client().await?;
        let read = || {
            client.call(
                "session.eventLog.read",
                Some(serde_json::json!({
                    "sessionId": session_id,
                    "cursor": &cursor,
                    "direction": "backward",
                    "includeEphemeral": false,
                    "max": max,
                    "types": types,
                    "agentScope": agent_scope,
                })),
            )
        };
        // Warm runtimes can often read persisted history without attaching the session. Try that
        // first; only wait for the concurrently-started resume when the runtime rejects the read.
        let result = match read().await {
            Ok(result) => result,
            Err(initial_error) if !self.active.read().await.contains_key(session_id) => {
                let attached = tokio::time::timeout(Duration::from_secs(30), async {
                    loop {
                        if self.active.read().await.contains_key(session_id) {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(25)).await;
                    }
                })
                .await
                .is_ok();
                if !attached {
                    return Err(ServiceError::Copilot(initial_error));
                }
                read().await?
            }
            Err(error) => return Err(ServiceError::Copilot(error)),
        };
        let events: Vec<SessionEvent> = serde_json::from_value(
            result
                .get("events")
                .cloned()
                .unwrap_or_else(|| serde_json::json!([])),
        )
        .map_err(|error| ServiceError::Persistence(error.to_string()))?;
        let human_messages = events
            .iter()
            .filter(|event| is_human_message(event))
            .count();
        Ok(HistoryPage {
            events,
            has_more: result
                .get("hasMore")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            cursor: value_string(&result, "cursor"),
            loaded_pages: 1,
            human_messages,
            window_start_event_id: None,
            truncated_before_anchor: false,
        })
    }

    pub async fn subagent_context(&self, session_id: &str) -> Result<Vec<SessionEvent>> {
        self.attached_session(session_id).await?;
        let result = self
            .client()
            .await?
            .call(
                "session.eventLog.read",
                Some(serde_json::json!({
                    "sessionId": session_id,
                    "direction": "backward",
                    "includeEphemeral": false,
                    "max": 1000,
                    "types": [
                        "subagent.started",
                        "subagent.completed",
                        "subagent.failed"
                    ],
                })),
            )
            .await?;
        serde_json::from_value(
            result
                .get("events")
                .cloned()
                .unwrap_or_else(|| serde_json::json!([])),
        )
        .map_err(|error| ServiceError::Persistence(error.to_string()))
    }

    pub async fn send_message(
        &self,
        session_id: &str,
        content: String,
        agent_mode: Option<String>,
    ) -> Result<String> {
        let agent_mode = agent_mode
            .map(|mode| {
                parse_agent_mode(&mode).ok_or_else(|| {
                    ServiceError::InvalidArgument(format!("unknown agentMode {mode}"))
                })
            })
            .transpose()?;
        self.submit_message(SendMessageRequest {
            session_id: session_id.into(),
            content,
            agent_mode,
            delivery_mode: None,
            attachments: Vec::new(),
        })
        .await
    }

    pub async fn queue_items(&self, session_id: &str) -> Result<serde_json::Value> {
        self.attached_session(session_id).await?;
        Ok(self
            .client()
            .await?
            .call(
                "session.queue.pendingItems",
                Some(serde_json::json!({ "sessionId": session_id })),
            )
            .await?)
    }

    async fn initialize_environment(&self, session_id: &str) -> Result<()> {
        if self.warmed.read().await.contains(session_id) {
            return Ok(());
        }
        self.session(session_id).await?;
        self.client()
            .await?
            .call(
                "session.tools.initializeAndValidate",
                Some(serde_json::json!({ "sessionId": session_id })),
            )
            .await?;
        self.warmed.write().await.insert(session_id.into());
        Ok(())
    }

    pub async fn remove_queue_item(
        &self,
        session_id: &str,
        item_id: String,
    ) -> Result<serde_json::Value> {
        self.session(session_id).await?;
        Ok(self
            .client()
            .await?
            .call(
                "session.queue.removeAt",
                Some(serde_json::json!({
                    "sessionId": session_id,
                    "id": item_id,
                })),
            )
            .await?)
    }

    pub async fn execute_command(
        &self,
        session_id: &str,
        command_name: String,
        args: String,
    ) -> Result<serde_json::Value> {
        self.require_accepting_work()?;
        let gate = self.turn_gate(session_id).await;
        let _guard = gate.lock().await;
        self.require_accepting_work()?;
        self.session(session_id).await?;
        let result = self
            .client()
            .await?
            .call(
                "session.commands.invoke",
                Some(serde_json::json!({
                    "sessionId": session_id,
                    "name": command_name,
                    "input": if args.is_empty() { None } else { Some(args) },
                })),
            )
            .await?;
        if result.get("kind").and_then(serde_json::Value::as_str) == Some("agent-prompt") {
            let prompt = result
                .get("prompt")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    ServiceError::CommandFailed(
                        "agent-prompt result did not contain a prompt".to_string(),
                    )
                })?;
            let display_prompt = result
                .get("displayPrompt")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(prompt);
            self.last_submissions
                .write()
                .await
                .insert(session_id.to_string(), tokio::time::Instant::now());
            self.session(session_id)
                .await?
                .send(MessageOptions::new(prompt).with_display_prompt(display_prompt))
                .await?;
            self.allow_new_work_recovery(session_id).await?;
        }
        Ok(result)
    }

    pub async fn references(&self, session_id: &str) -> Result<SessionReferences> {
        self.attached_session(session_id).await?;
        let client = self.client().await?;
        let session = serde_json::json!({ "sessionId": session_id });
        let (commands, mcp, tools, instructions, tasks) = tokio::join!(
            client.call("session.commands.list", Some(session.clone())),
            client.call("session.mcp.list", Some(session.clone())),
            client.call("tools.list", Some(serde_json::json!({}))),
            client.call("session.instructions.getSources", Some(session.clone())),
            client.call("session.tasks.list", Some(session.clone())),
        );

        Ok(SessionReferences {
            commands: reference_section(commands),
            skills: empty_reference_section(),
            mcp: reference_section(mcp),
            mcp_tools: empty_reference_section(),
            tools: reference_section(tools),
            instructions: reference_section(instructions),
            context_attribution: empty_reference_section(),
            tasks: reference_section(tasks),
        })
    }

    pub async fn context_attribution(&self, session_id: &str) -> Result<serde_json::Value> {
        self.attached_session(session_id).await?;
        Ok(self
            .client()
            .await?
            .call(
                "session.metadata.getContextAttribution",
                Some(serde_json::json!({ "sessionId": session_id })),
            )
            .await?)
    }

    pub async fn reference_section(
        &self,
        session_id: &str,
        section: &str,
    ) -> Result<serde_json::Value> {
        self.attached_session(session_id).await?;
        let client = self.client().await?;
        let session = Some(serde_json::json!({ "sessionId": session_id }));
        match section {
            "commands" => Ok(client.call("session.commands.list", session).await?),
            "mcp" => Ok(client.call("session.mcp.list", session).await?),
            "tools" => Ok(client
                .call("tools.list", Some(serde_json::json!({})))
                .await?),
            "instructions" => Ok(client
                .call("session.instructions.getSources", session)
                .await?),
            "tasks" => Ok(client.call("session.tasks.list", session).await?),
            _ => Err(ServiceError::CommandFailed(format!(
                "unknown reference section: {section}"
            ))),
        }
    }

    pub async fn discover_skills(&self, session_id: &str) -> Result<serde_json::Value> {
        self.attached_session(session_id).await?;
        let cwd = self.cwd_for(session_id).await;
        Ok(self
            .client()
            .await?
            .call(
                "skills.discover",
                Some(serde_json::json!({
                    "excludeHostSkills": false,
                    "projectPaths": cwd.into_iter().collect::<Vec<_>>(),
                })),
            )
            .await?)
    }

    pub async fn mcp_tools(&self, session_id: &str) -> Result<serde_json::Value> {
        self.attached_session(session_id).await?;
        let client = self.client().await?;
        let mcp = client
            .call(
                "session.mcp.list",
                Some(serde_json::json!({ "sessionId": session_id })),
            )
            .await?;
        let names = mcp
            .get("servers")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter(|server| {
                server.get("status").and_then(serde_json::Value::as_str) == Some("connected")
            })
            .filter_map(|server| {
                server
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
            .collect::<Vec<_>>();
        let calls = names.into_iter().map(|name| {
            let client = client.clone();
            async move {
                let result = client
                    .call(
                        "session.mcp.listTools",
                        Some(serde_json::json!({
                            "sessionId": session_id,
                            "serverName": name,
                        })),
                    )
                    .await;
                (name, result)
            }
        });
        Ok(serde_json::Value::Object(
            join_all(calls)
                .await
                .into_iter()
                .map(|(name, result)| {
                    (
                        name,
                        match result {
                            Ok(value) => serde_json::json!({ "value": value }),
                            Err(error) => serde_json::json!({ "error": error.to_string() }),
                        },
                    )
                })
                .collect(),
        ))
    }

    pub async fn abort(&self, session_id: &str) -> Result<()> {
        self.session(session_id).await?.abort().await?;
        self.interactions.clear_session(session_id);
        Ok(())
    }

    pub async fn cancel_task(
        &self,
        session_id: &str,
        task_id: String,
    ) -> Result<serde_json::Value> {
        self.require_accepting_work()?;
        self.session(session_id).await?;
        Ok(self
            .client()
            .await?
            .call(
                "session.tasks.cancel",
                Some(serde_json::json!({
                    "sessionId": session_id,
                    "id": task_id,
                })),
            )
            .await?)
    }

    pub async fn cancel_background_agents(&self, session_id: &str) -> Result<serde_json::Value> {
        self.require_accepting_work()?;
        self.session(session_id).await?;
        Ok(self
            .client()
            .await?
            .call(
                "session.cancelAllBackgroundAgents",
                Some(serde_json::json!({ "sessionId": session_id })),
            )
            .await?)
    }

    pub async fn decide_permission(&self, decision: PermissionDecision) -> Result<()> {
        self.approvals.resolve(decision)
    }

    pub fn pending_permissions(&self) -> Vec<AppEvent> {
        self.approvals.list()
    }

    pub fn pending_interactions(&self, session_id: &str) -> Vec<PendingInteraction> {
        self.interactions.list(session_id)
    }

    pub fn respond_interaction(&self, response: InteractionResponse) -> Result<()> {
        self.interactions.respond(response)
    }

    pub async fn pending_interactions_async(
        &self,
        session_id: &str,
    ) -> Result<Vec<PendingInteraction>> {
        self.attached_session(session_id).await?;
        self.interactions
            .recover_native(session_id, &self.client().await?)
            .await?;
        Ok(self.interactions.list(session_id))
    }

    pub async fn respond_interaction_async(&self, response: InteractionResponse) -> Result<()> {
        // Initialization may itself need an answer to a pending callback.
        self.attached_session(&response.session_id).await?;
        self.interactions
            .respond_native(response, &self.client().await?)
            .await
    }

    pub async fn delete_session(self: &Arc<Self>, session_id: &str) -> Result<()> {
        let service = Arc::clone(self);
        let session_id = session_id.to_owned();
        tokio::spawn(async move { service.delete_session_inner(&session_id).await })
            .await
            .map_err(|error| ServiceError::CommandFailed(format!("Session deletion failed: {error}")))?
    }

    async fn delete_session_inner(&self, session_id: &str) -> Result<()> {
        let _lifecycle = self.lifecycle_gate.read().await;
        let gate = self.turn_gate(session_id).await;
        let _guard = gate.lock().await;
        let previous = self.forget_initialization(session_id).await?;
        let deletion = async {
            self.client().await?.delete_session(&SessionId::new(session_id)).await?;
            Ok::<_, ServiceError>(())
        }.await;
        if let Err(error) = deletion {
            self.restore_failed_deletion(session_id, previous, &error).await;
            return Err(error);
        }
        self.metadata.write().await.remove(session_id);
        self.last_submissions.write().await.remove(session_id);
        self.warmed.write().await.remove(session_id);
        self.ask_gates.write().await.remove(session_id);
        self.tool_state.write().await.remove(session_id);
        self.tool_catalog.invalidate(session_id).await;
        self.approvals.clear_session(session_id);
        self.interactions.clear_session(session_id);
        self.persist_metadata().await?;
        self.events.emit(AppEvent::SessionDeleted {
            session_id: session_id.to_string(),
        });
        Ok(())
    }

    pub async fn cwd_for(&self, session_id: &str) -> Option<String> {
        self.metadata
            .read()
            .await
            .get(session_id)
            .and_then(|m| m.cwd.clone())
    }

    pub async fn set_working_directory(&self, session_id: &str, cwd: String) -> Result<String> {
        self.require_accepting_work()?;
        validate_cwd(&cwd)?;
        self.session(session_id).await?;
        let result = self
            .client()
            .await?
            .call(
                "session.metadata.setWorkingDirectory",
                Some(serde_json::json!({
                    "sessionId": session_id,
                    "workingDirectory": cwd,
                })),
            )
            .await?;
        let cwd = value_string(&result, "workingDirectory");
        self.metadata
            .write()
            .await
            .entry(session_id.to_string())
            .or_default()
            .cwd = Some(cwd.clone());
        self.persist_metadata().await?;
        Ok(cwd)
    }

    pub async fn organize_session(&self, update: OrganizationUpdate) -> Result<SessionSummary> {
        let folder = update
            .folder
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let mut tags = update
            .tags
            .into_iter()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        tags.sort_by_key(|value| value.to_lowercase());
        tags.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
        {
            let _write_guard = self.metadata_write_gate.lock().await;
            let mut metadata = self.metadata.write().await;
            let mut candidate = metadata.clone();
            let meta = candidate.entry(update.session_id.clone()).or_default();
            meta.pinned = update.pinned;
            meta.folder = folder.clone();
            meta.tags = tags.clone();
            let mut cache = self.session_cache.write().await;
            self.write_metadata(&candidate)?;
            *metadata = candidate;
            if let Some(summary) = cache
                .iter_mut()
                .find(|item| item.session_id == update.session_id)
            {
                summary.pinned = update.pinned;
                summary.folder = folder;
                summary.tags = tags;
            }
        }
        self.list_sessions()
            .await?
            .into_iter()
            .find(|session| session.session_id == update.session_id)
            .ok_or(ServiceError::SessionNotActive(update.session_id))
    }

    pub async fn model_info(&self, session_id: &str) -> Result<serde_json::Value> {
        self.attached_session(session_id).await?;
        let client = self.client().await?;
        let params = Some(serde_json::json!({ "sessionId": session_id }));
        let (current, available) = tokio::join!(
            client.call("session.model.getCurrent", params.clone()),
            client.call("session.model.list", params),
        );
        Ok(serde_json::json!({
            "current": current?,
            "available": available?,
        }))
    }

    pub async fn available_models(&self) -> Result<serde_json::Value> {
        Ok(self
            .client()
            .await?
            .call("models.list", Some(serde_json::json!({})))
            .await?)
    }

    pub async fn switch_model(
        &self,
        session_id: &str,
        model_id: String,
        reasoning_effort: Option<String>,
        reasoning_summary: Option<String>,
        context_tier: Option<String>,
    ) -> Result<serde_json::Value> {
        self.require_accepting_work()?;
        self.session(session_id).await?;
        let result = self
            .client()
            .await?
            .call(
                "session.model.switchTo",
                Some(serde_json::json!({
                    "sessionId": session_id,
                    "modelId": model_id,
                    "reasoningEffort": reasoning_effort,
                    "reasoningSummary": reasoning_summary,
                    "contextTier": context_tier,
                    "requireAvailable": true,
                    "runCompactionPreflight": false,
                    "source": "sdk",
                })),
            )
            .await?;
        let selected = optional_value_string(&result, "modelId").unwrap_or(model_id);
        let mut metadata = self.metadata.write().await;
        let local = metadata.entry(session_id.to_string()).or_default();
        local.model = Some(selected);
        local.reasoning_effort = reasoning_effort;
        local.reasoning_summary = reasoning_summary;
        local.context_tier = context_tier;
        drop(metadata);
        self.persist_metadata().await?;
        Ok(result)
    }

    pub async fn runtime_status(&self) -> RuntimeStatus {
        RuntimeStatus {
            connected: self.client.read().await.is_some(),
            accepting_work: self.accepting_work.load(Ordering::Relaxed),
            active_sessions: self.active.read().await.len(),
        }
    }

    pub async fn session_processing(&self, session_id: &str) -> Result<bool> {
        self.attached_session(session_id).await?;
        self.client()
            .await?
            .call(
                "session.metadata.isProcessing",
                Some(serde_json::json!({ "sessionId": session_id })),
            )
            .await?
            .get("processing")
            .and_then(serde_json::Value::as_bool)
            .ok_or_else(|| {
                ServiceError::CommandFailed(
                    "Copilot did not return session processing state".to_string(),
                )
            })
    }

    pub async fn connect_copilot(&self) -> Result<RuntimeStatus> {
        let _runtime_guard = self.runtime_gate.lock().await;
        let mut client = self.client.write().await;
        if client.is_none() {
            *client = Some(Client::start(ClientOptions::default()).await?);
        }
        self.accepting_work.store(true, Ordering::Relaxed);
        drop(client);
        let status = self.runtime_status().await;
        self.events.emit(AppEvent::RuntimeStatus {
            status: status.clone(),
        });
        Ok(status)
    }

    pub async fn cancel_drain(&self) -> Result<RuntimeStatus> {
        let _runtime_guard = self.runtime_gate.lock().await;
        if self.client.read().await.is_none() {
            return Err(ServiceError::CopilotDisconnected);
        }
        self.accepting_work.store(true, Ordering::Relaxed);
        let status = self.runtime_status().await;
        self.events.emit(AppEvent::RuntimeStatus {
            status: status.clone(),
        });
        Ok(status)
    }

    pub async fn drain(&self, timeout: Duration, force: bool) -> Result<DrainStatus> {
        let _runtime_guard = self.runtime_gate.lock().await;
        self.accepting_work.store(false, Ordering::Relaxed);
        self.cancel_initializations("Copilot is draining; retry after reconnecting", false).await;
        let _lifecycle = self.lifecycle_gate.write().await;
        let client = self.client().await?;
        let deadline = tokio::time::Instant::now() + timeout;
        let mut processing = Vec::new();
        loop {
            processing.clear();
            let session_ids = self.active.read().await.keys().cloned().collect::<Vec<_>>();
            for session_id in session_ids {
                match client
                    .call(
                        "session.metadata.isProcessing",
                        Some(serde_json::json!({ "sessionId": &session_id })),
                    )
                    .await
                {
                    Ok(value)
                        if value.get("processing").and_then(serde_json::Value::as_bool)
                            == Some(false) => {}
                    Ok(_) => processing.push(session_id),
                    Err(error) => processing.push(format!("{session_id}: {error}")),
                }
            }
            if processing.is_empty() || tokio::time::Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }

        if !processing.is_empty() && !force {
            let result = DrainStatus {
                complete: false,
                processing_sessions: processing,
                disconnected_sessions: 0,
            };
            let status = self.runtime_status().await;
            self.events.emit(AppEvent::RuntimeStatus { status });
            return Ok(result);
        }
        if force {
            let sessions = self
                .active
                .read()
                .await
                .values()
                .cloned()
                .collect::<Vec<_>>();
            for session in sessions {
                let _ = session.abort().await;
            }
        }

        self.cancel_initializations("Copilot is disconnected; resume the session after reconnecting", true).await;
        let sessions = self
            .active
            .write()
            .await
            .drain()
            .map(|(_, session)| session)
            .collect::<Vec<_>>();
        let disconnected_sessions = sessions.len();
        self.interactions.clear();
        self.approvals.clear();
        self.warmed.write().await.clear();
        self.ask_gates.write().await.clear();
        self.tool_state.write().await.clear();
        self.tool_catalog.clear().await;
        for summary in self.session_cache.write().await.iter_mut() {
            summary.is_active = false;
        }
        for session in sessions {
            session.disconnect().await?;
        }
        client
            .stop()
            .await
            .map_err(|error| ServiceError::Persistence(error.to_string()))?;
        *self.client.write().await = None;
        let status = self.runtime_status().await;
        self.events.emit(AppEvent::RuntimeStatus { status });
        Ok(DrainStatus {
            complete: true,
            processing_sessions: Vec::new(),
            disconnected_sessions,
        })
    }

    pub async fn reload_mcp(&self) -> Result<Vec<SessionOperationResult>> {
        self.require_accepting_work()?;
        let client = self.client().await?;
        let session_ids = self.active.read().await.keys().cloned().collect::<Vec<_>>();
        let mut results = Vec::with_capacity(session_ids.len());
        for session_id in session_ids {
            if let Err(error) = self.session(&session_id).await {
                results.push(SessionOperationResult {
                    session_id,
                    success: false,
                    error: Some(error.to_string()),
                });
                continue;
            }
            match client
                .call(
                    "session.mcp.reload",
                    Some(serde_json::json!({ "sessionId": &session_id })),
                )
                .await
            {
                Ok(_) => results.push(SessionOperationResult {
                    session_id,
                    success: true,
                    error: None,
                }),
                Err(error) => results.push(SessionOperationResult {
                    session_id,
                    success: false,
                    error: Some(error.to_string()),
                }),
            }
        }
        Ok(results)
    }

    async fn session(&self, session_id: &str) -> Result<Arc<Session>> {
        let initializations = self.initializations.read().await;
        if let Some(snapshot) = initializations.snapshot(session_id)
            && snapshot.phase != InitializationPhase::Ready
        {
            return Err(initialization::not_ready(session_id, &snapshot));
        }
        self.attached_session(session_id).await
    }

    async fn attached_session(&self, session_id: &str) -> Result<Arc<Session>> {
        self.active
            .read()
            .await
            .get(session_id)
            .filter(|session| !session.cancellation_token().is_cancelled())
            .cloned()
            .ok_or_else(|| ServiceError::SessionNotActive(session_id.to_string()))
    }

    async fn turn_gate(&self, session_id: &str) -> Arc<AsyncMutex<()>> {
        if let Some(gate) = self.turn_gates.read().await.get(session_id).cloned() {
            return gate;
        }
        self.turn_gates
            .write()
            .await
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }

    async fn client(&self) -> Result<Client> {
        self.client
            .read()
            .await
            .clone()
            .ok_or(ServiceError::CopilotDisconnected)
    }

    async fn refresh_model(&self, session_id: &str) -> Result<()> {
        let current = self
            .client()
            .await?
            .call(
                "session.model.getCurrent",
                Some(serde_json::json!({ "sessionId": session_id })),
            )
            .await?;
        if let Some(model) = optional_value_string(&current, "modelId") {
            self.metadata
                .write()
                .await
                .entry(session_id.to_string())
                .or_default()
                .model = Some(model);
            self.persist_metadata().await?;
        }
        Ok(())
    }

    fn require_accepting_work(&self) -> Result<()> {
        if self.accepting_work.load(Ordering::Relaxed) {
            Ok(())
        } else {
            Err(ServiceError::Draining)
        }
    }

    async fn attach(self: &Arc<Self>, session: Arc<Session>) -> Result<()> {
        let session_id = session.id().to_string();
        // Existing-session adoption is consent for one attachment, not a
        // perpetual permission to overwrite subsequently changed CLI filters.
        self.tool_state.write().await.remove(&session_id);
        self.tool_catalog.invalidate(&session_id).await;
        let client = self.client().await?;
        let tail = client
            .call(
                "session.eventLog.tail",
                Some(serde_json::json!({ "sessionId": &session_id })),
            )
            .await?;
        let mut cursor = tail
            .get("cursor")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                ServiceError::Persistence(format!(
                    "session {session_id} event-log tail did not return a cursor"
                ))
            })?
            .to_string();
        self.active
            .write()
            .await
            .insert(session_id.clone(), session.clone());
        self.events.emit(AppEvent::SessionAttached {
            session_id: session_id.clone(),
        });

        let cancellation = session.cancellation_token();
        let interactions = self.interactions.clone();
        let cancelled_id = session_id.clone();
        let cancelled_session = Arc::downgrade(&session);
        let cancelled_service = Arc::downgrade(self);
        tokio::spawn(async move {
            cancellation.cancelled().await;
            interactions.clear_callbacks(&cancelled_id);
            if let (Some(service), Some(session)) =
                (cancelled_service.upgrade(), cancelled_session.upgrade())
            {
                service.disconnect_initialization(&cancelled_id, &session).await;
            }
        });

        let events = self.events.clone();
        let weak_service = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                let Some(current_service) = weak_service.upgrade() else {
                    break;
                };
                let current = current_service.active.read().await;
                let still_attached = current
                    .get(&session_id)
                    .is_some_and(|active| Arc::ptr_eq(active, &session));
                drop(current);
                drop(current_service);
                if !still_attached {
                    break;
                }

                match client
                    .call(
                        "session.eventLog.read",
                        Some(serde_json::json!({
                            "sessionId": &session_id,
                            "cursor": &cursor,
                            "direction": "forward",
                            "includeEphemeral": true,
                            "max": 1000,
                            "types": "*",
                            "agentScope": "all",
                            "waitMs": 30000,
                        })),
                    )
                    .await
                {
                    Ok(result) => {
                        let Some(current_service) = weak_service.upgrade() else {
                            break;
                        };
                        if !current_service
                            .active
                            .read()
                            .await
                            .get(&session_id)
                            .is_some_and(|active| Arc::ptr_eq(active, &session))
                        {
                            break;
                        }
                        let Some(next_cursor) = result
                            .get("cursor")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_owned)
                        else {
                            tracing::error!(
                                %session_id,
                                "session event-log read did not return a cursor"
                            );
                            // A malformed polling response must not evict a live
                            // SDK handle and race a second registration.
                            tokio::time::sleep(Duration::from_millis(250)).await;
                            continue;
                        };
                        cursor = next_cursor;
                        if let Some(raw_events) = result
                            .get("events")
                            .and_then(serde_json::Value::as_array)
                        {
                            for event in raw_events {
                                current_service
                                    .interactions
                                    .observe_native_event(&session_id, event);
                            }
                        }
                        drop(current_service);
                        let session_events: Vec<SessionEvent> = match serde_json::from_value(
                            result
                                .get("events")
                                .cloned()
                                .unwrap_or_else(|| serde_json::json!([])),
                        ) {
                            Ok(session_events) => session_events,
                            Err(error) => {
                                tracing::warn!(
                                    %error,
                                    %session_id,
                                    "could not decode session event-log batch"
                                );
                                continue;
                            }
                        };
                        for event in session_events {
                            if event.event_type == "mcp.tools_list_changed"
                                && let Some(service) = weak_service.upgrade()
                            {
                                service.tool_catalog.invalidate(&session_id).await;
                                events.emit(AppEvent::ToolInventoryUpdated {
                                    session_id: session_id.clone(),
                                });
                            }
                            events.emit(AppEvent::SessionEvent {
                                session_id: session_id.clone(),
                                event,
                            });
                        }
                    }
                    Err(error) => {
                        if error.is_transport_failure()
                            && let Some(current_service) = weak_service.upgrade()
                        {
                            current_service.interactions.clear_callbacks(&session_id);
                            current_service.disconnect_initialization(&session_id, &session).await;
                        }
                        tracing::warn!(
                            %error,
                            %session_id,
                            "session event-log tail failed; retrying"
                        );
                        tokio::time::sleep(Duration::from_millis(250)).await;
                    }
                }
            }
        });
        Ok(())
    }

    async fn persist_metadata(&self) -> Result<()> {
        let _write_guard = self.metadata_write_gate.lock().await;
        self.write_metadata(&*self.metadata.read().await)
    }

    // Call only while holding metadata_write_gate. Stage and flush the complete
    // snapshot before atomically replacing the last successfully saved file.
    fn write_metadata(&self, metadata: &HashMap<String, StoredSessionMeta>) -> Result<()> {
        use std::io::Write;

        let json = serde_json::to_vec_pretty(metadata)
            .map_err(|e| ServiceError::Persistence(e.to_string()))?;
        let temp = self.metadata_path.with_extension("json.tmp");
        let mut file = std::fs::File::create(&temp)
            .map_err(|e| ServiceError::Persistence(e.to_string()))?;
        let result = (|| {
            file.write_all(&json)?;
            file.sync_all()?;
            drop(file);
            std::fs::rename(&temp, &self.metadata_path)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temp);
        }
        result.map_err(|e| ServiceError::Persistence(e.to_string()))
    }
}

fn load_metadata(path: &Path) -> HashMap<String, StoredSessionMeta> {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{AppEvent, EVENT_REPLAY_CAPACITY, EventBus, RuntimeStatus};

    #[test]
    fn history_attribution_excludes_injected_inputs_and_child_messages() {
        let event = |id: &str, source: serde_json::Value, agent: Option<&str>| {
            serde_json::from_value::<super::SessionEvent>(serde_json::json!({
                "id": id, "timestamp": "2026-09-15T00:00:00Z", "parentId": null,
                "type": "user.message", "agentId": agent,
                "data": { "content": "same text", "source": source }
            }))
            .unwrap()
        };
        let mut events = Vec::new();
        for id in ["first", "second", "third", "fourth"] {
            events.push(event(id, serde_json::Value::Null, None));
            for source in ["agent-primary", "skill-pdf", "custom-producer"] {
                events.push(event(source, source.into(), None));
            }
            events.push(event("child", "user".into(), Some("child")));
        }
        assert_eq!(
            events.iter().filter(|event| super::is_human_message(event)).count(),
            4
        );
        assert_eq!(super::human_history_anchor(&events).as_deref(), Some("second"));
        assert!(super::is_human_message(&event(
            "explicit-user", "user".into(), None
        )));
        assert!(!super::is_human_message(&event(
            "invalid", true.into(), None
        )));
        assert_eq!(
            super::human_history_anchor(&[event("only", "agent-root".into(), None)]),
            None
        );
        assert_eq!(super::human_history_anchor(&[]), None);
    }

    fn status_event(active_sessions: usize) -> AppEvent {
        AppEvent::RuntimeStatus {
            status: RuntimeStatus {
                connected: true,
                accepting_work: true,
                active_sessions,
            },
        }
    }

    #[test]
    fn app_event_envelope_uses_camel_case_fields() {
        let attached = serde_json::to_value(AppEvent::SessionAttached {
            session_id: "session-1".to_string(),
        })
        .expect("serialize session event");
        assert_eq!(attached["type"], "session_attached");
        assert_eq!(attached["sessionId"], "session-1");
        assert!(attached.get("session_id").is_none());

        let gap = serde_json::to_value(AppEvent::EventGap {
            session_id: Some("session-1".to_string()),
            skipped: 7,
        })
        .expect("serialize gap event");
        assert_eq!(gap["sessionId"], "session-1");
        assert_eq!(gap["skipped"], 7);

        let runtime = serde_json::to_value(AppEvent::RuntimeStatus {
            status: RuntimeStatus {
                connected: true,
                accepting_work: true,
                active_sessions: 1,
            },
        })
        .expect("serialize runtime event");
        assert_eq!(runtime["status"]["acceptingWork"], true);
        assert_eq!(runtime["status"]["activeSessions"], 1);
    }

    #[tokio::test]
    async fn every_subscriber_receives_the_same_event_sequence() {
        let bus = EventBus::new();
        let mut first = bus.subscribe(None);
        let mut second = bus.subscribe(None);

        bus.emit(status_event(1));

        let first_event = first.recv().await.expect("first subscriber event");
        let second_event = second.recv().await.expect("second subscriber event");
        assert_eq!(first_event.sequence, 1);
        assert_eq!(second_event.sequence, first_event.sequence);
        assert_eq!(
            serde_json::to_value(second_event).expect("serialize second event"),
            serde_json::to_value(first_event).expect("serialize first event"),
        );
    }

    #[tokio::test]
    async fn subscriber_replays_events_after_its_cursor() {
        let bus = EventBus::new();
        bus.emit(status_event(1));
        bus.emit(status_event(2));
        bus.emit(status_event(3));

        let mut subscriber = bus.subscribe(Some(1));
        assert_eq!(subscriber.recv().await.expect("second event").sequence, 2);
        assert_eq!(subscriber.recv().await.expect("third event").sequence, 3);
    }

    #[tokio::test]
    async fn replay_reports_events_that_fell_out_of_the_buffer() {
        let bus = EventBus::new();
        for active_sessions in 0..=EVENT_REPLAY_CAPACITY {
            bus.emit(status_event(active_sessions));
        }

        let mut subscriber = bus.subscribe(Some(0));
        let gap = subscriber.recv().await.expect("gap event");
        assert_eq!(gap.sequence, 1);
        match gap.event {
            AppEvent::EventGap { skipped, .. } => assert_eq!(skipped, 1),
            _ => panic!("expected event gap"),
        }
        assert_eq!(
            subscriber
                .recv()
                .await
                .expect("first retained event")
                .sequence,
            2
        );
    }
}

fn validate_cwd(cwd: &str) -> Result<()> {
    let path = Path::new(cwd);
    if path.is_dir() {
        Ok(())
    } else {
        Err(ServiceError::InvalidWorkingDirectory(cwd.to_string()))
    }
}

fn parse_agent_mode(value: &str) -> Option<AgentMode> {
    match value {
        "interactive" => Some(AgentMode::Interactive),
        "plan" => Some(AgentMode::Plan),
        "autopilot" => Some(AgentMode::Autopilot),
        "shell" => Some(AgentMode::Shell),
        _ => None,
    }
}

fn parse_reasoning_summary(value: &str) -> Option<ReasoningSummary> {
    match value {
        "none" => Some(ReasoningSummary::None),
        "concise" => Some(ReasoningSummary::Concise),
        "detailed" => Some(ReasoningSummary::Detailed),
        _ => None,
    }
}

fn value_string(value: &serde_json::Value, key: &str) -> String {
    optional_value_string(value, key).unwrap_or_default()
}

fn optional_value_string(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
}

fn reference_section(
    result: std::result::Result<serde_json::Value, github_copilot_sdk::Error>,
) -> ReferenceSection {
    match result {
        Ok(value) => ReferenceSection {
            value: Some(value),
            error: None,
        },
        Err(error) => ReferenceSection {
            value: None,
            error: Some(error.to_string()),
        },
    }
}

fn empty_reference_section() -> ReferenceSection {
    ReferenceSection {
        value: None,
        error: None,
    }
}
