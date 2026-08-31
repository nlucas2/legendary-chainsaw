use std::cmp::Reverse;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use futures_util::future::join_all;
use github_copilot_sdk::handler::{PermissionHandler, PermissionResult};
use github_copilot_sdk::session::Session;
use github_copilot_sdk::types::{
    PermissionRequestData, RequestId, ResumeSessionConfig, SessionConfig, SessionEvent, SessionId,
};
use github_copilot_sdk::{Client, ClientOptions, MessageOptions};
use serde::{Deserialize, Serialize};
use tokio::sync::{RwLock, broadcast, oneshot};

const APPROVAL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const HISTORY_PAGE_SIZE: usize = 200;

#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    #[error("{0}")]
    Copilot(#[from] github_copilot_sdk::Error),
    #[error("session {0} is not active")]
    SessionNotActive(String),
    #[error("permission request {0} is no longer pending")]
    PermissionNotPending(String),
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
    pub folder: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSession {
    pub cwd: String,
    pub model: Option<String>,
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
#[serde(tag = "type", rename_all = "snake_case")]
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
    RuntimeStatus {
        status: RuntimeStatus,
    },
    SessionAttached {
        session_id: String,
    },
    SessionDeleted {
        session_id: String,
    },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
struct StoredSessionMeta {
    cwd: Option<String>,
    model: Option<String>,
    title: Option<String>,
    pinned: bool,
    folder: Option<String>,
    tags: Vec<String>,
}

struct ApprovalBroker {
    events: broadcast::Sender<AppEvent>,
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
        let _ = self.events.send(AppEvent::PermissionResolved {
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
        let _ = self.events.send(AppEvent::PermissionRequested {
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
    session_cache: RwLock<Vec<SessionSummary>>,
    events: broadcast::Sender<AppEvent>,
    approvals: Arc<ApprovalBroker>,
    metadata_path: PathBuf,
    metadata: RwLock<HashMap<String, StoredSessionMeta>>,
}

impl SessionService {
    pub async fn start(data_dir: impl Into<PathBuf>) -> Result<Arc<Self>> {
        let data_dir = data_dir.into();
        std::fs::create_dir_all(&data_dir).map_err(|e| ServiceError::Persistence(e.to_string()))?;
        let metadata_path = data_dir.join("sessions.json");
        let metadata = load_metadata(&metadata_path);
        let (events, _) = broadcast::channel(512);
        let approvals = Arc::new(ApprovalBroker {
            events: events.clone(),
            pending: Mutex::new(HashMap::new()),
        });
        let client = Client::start(ClientOptions::default()).await?;

        Ok(Arc::new(Self {
            client: RwLock::new(Some(client)),
            accepting_work: AtomicBool::new(true),
            active: RwLock::new(HashMap::new()),
            session_cache: RwLock::new(Vec::new()),
            events,
            approvals,
            metadata_path,
            metadata: RwLock::new(metadata),
        }))
    }

    pub fn default_data_dir() -> PathBuf {
        dirs::data_local_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("copilot-sessions")
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AppEvent> {
        self.events.subscribe()
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
        let active = self.active.read().await;
        let metadata = self.metadata.read().await;
        let mut summaries = sessions
            .into_iter()
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
                    folder: local.and_then(|meta| meta.folder.clone()),
                    tags: local.map(|meta| meta.tags.clone()).unwrap_or_default(),
                }
            })
            .collect::<Vec<_>>();
        summaries.sort_by_key(|session| (!session.pinned, Reverse(session.modified_time.clone())));
        *self.session_cache.write().await = summaries.clone();
        Ok(summaries)
    }

    pub async fn create_session(self: &Arc<Self>, request: NewSession) -> Result<SessionSummary> {
        self.require_accepting_work()?;
        validate_cwd(&request.cwd)?;
        let mut config = SessionConfig::default()
            .with_working_directory(&request.cwd)
            .with_streaming(true)
            .with_permission_handler(self.approvals.clone());
        if let Some(model) = request.model.as_deref().filter(|m| !m.is_empty()) {
            config = config.with_model(model);
        }
        let session = Arc::new(self.client().await?.create_session(config).await?);
        let id = session.id().to_string();
        self.metadata.write().await.insert(
            id.clone(),
            StoredSessionMeta {
                cwd: Some(request.cwd.clone()),
                model: request.model.clone(),
                title: None,
                pinned: false,
                folder: None,
                tags: Vec::new(),
            },
        );
        self.persist_metadata().await?;
        self.attach(session).await;
        self.refresh_model(&id).await?;
        let model = self
            .metadata
            .read()
            .await
            .get(&id)
            .and_then(|meta| meta.model.clone());
        Ok(SessionSummary {
            session_id: id,
            title: "New session".to_string(),
            start_time: String::new(),
            modified_time: String::new(),
            cwd: Some(request.cwd),
            model,
            is_active: true,
            is_remote: false,
            pinned: false,
            folder: None,
            tags: Vec::new(),
        })
    }

    pub async fn resume_session(self: &Arc<Self>, session_id: String) -> Result<SessionSummary> {
        self.require_accepting_work()?;
        if !self.active.read().await.contains_key(&session_id) {
            let meta = self.metadata.read().await.get(&session_id).cloned();
            let mut config = ResumeSessionConfig::new(SessionId::new(session_id.clone()))
                .with_streaming(true)
                .with_continue_pending_work(true)
                .with_permission_handler(self.approvals.clone());
            if let Some(cwd) = meta.as_ref().and_then(|m| m.cwd.as_deref()) {
                config = config.with_working_directory(cwd);
            }
            if let Some(model) = meta.as_ref().and_then(|m| m.model.as_deref()) {
                config = config.with_model(model);
            }
            let session = Arc::new(self.client().await?.resume_session(config).await?);
            self.attach(session).await;
        }
        self.refresh_model(&session_id).await?;
        let meta = self.metadata.read().await.get(&session_id).cloned();
        let mut cache = self.session_cache.write().await;
        if let Some(summary) = cache
            .iter_mut()
            .find(|summary| summary.session_id == session_id)
        {
            summary.is_active = true;
            if let Some(meta) = meta {
                summary.cwd = meta.cwd;
                summary.model = meta.model;
                summary.pinned = meta.pinned;
                summary.folder = meta.folder;
                summary.tags = meta.tags;
            }
            return Ok(summary.clone());
        }
        drop(cache);
        Ok(self
            .list_sessions()
            .await?
            .into_iter()
            .find(|summary| summary.session_id == session_id)
            .unwrap_or(SessionSummary {
                session_id,
                title: "Session".to_string(),
                start_time: String::new(),
                modified_time: String::new(),
                cwd: None,
                model: None,
                is_active: true,
                is_remote: false,
                pinned: false,
                folder: None,
                tags: Vec::new(),
            }))
    }

    pub async fn history(&self, session_id: &str, cursor: Option<String>) -> Result<HistoryPage> {
        let client = self.client().await?;
        let read = || {
            client.call(
                "session.eventLog.read",
                Some(serde_json::json!({
                    "sessionId": session_id,
                    "cursor": &cursor,
                    "direction": "backward",
                    "includeEphemeral": false,
                    "max": HISTORY_PAGE_SIZE,
                    "types": "*",
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
        Ok(HistoryPage {
            events,
            has_more: result
                .get("hasMore")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            cursor: value_string(&result, "cursor"),
        })
    }

    pub async fn subagent_context(&self, session_id: &str) -> Result<Vec<SessionEvent>> {
        self.session(session_id).await?;
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

    pub async fn send_message(&self, session_id: &str, content: String) -> Result<String> {
        self.require_accepting_work()?;
        let session = self.session(session_id).await?;
        Ok(session.send(content).await?)
    }

    pub async fn execute_command(
        &self,
        session_id: &str,
        command_name: String,
        args: String,
    ) -> Result<serde_json::Value> {
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
            self.session(session_id)
                .await?
                .send(MessageOptions::new(prompt).with_display_prompt(display_prompt))
                .await?;
        }
        Ok(result)
    }

    pub async fn references(&self, session_id: &str) -> Result<SessionReferences> {
        self.session(session_id).await?;
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
        self.session(session_id).await?;
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
        self.session(session_id).await?;
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
        self.session(session_id).await?;
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
        self.session(session_id).await?;
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

    pub async fn delete_session(&self, session_id: &str) -> Result<()> {
        self.active.write().await.remove(session_id);
        self.client()
            .await?
            .delete_session(&SessionId::new(session_id))
            .await?;
        self.metadata.write().await.remove(session_id);
        self.persist_metadata().await?;
        let _ = self.events.send(AppEvent::SessionDeleted {
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
            let mut metadata = self.metadata.write().await;
            let meta = metadata.entry(update.session_id.clone()).or_default();
            meta.pinned = update.pinned;
            meta.folder = folder;
            meta.tags = tags;
        }
        self.persist_metadata().await?;
        self.list_sessions()
            .await?
            .into_iter()
            .find(|session| session.session_id == update.session_id)
            .ok_or(ServiceError::SessionNotActive(update.session_id))
    }

    pub async fn model_info(&self, session_id: &str) -> Result<serde_json::Value> {
        self.session(session_id).await?;
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
                    "contextTier": context_tier,
                    "requireAvailable": true,
                    "runCompactionPreflight": false,
                    "source": "sdk",
                })),
            )
            .await?;
        let selected = optional_value_string(&result, "modelId").unwrap_or(model_id);
        self.metadata
            .write()
            .await
            .entry(session_id.to_string())
            .or_default()
            .model = Some(selected);
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

    pub async fn connect_copilot(&self) -> Result<RuntimeStatus> {
        let mut client = self.client.write().await;
        if client.is_none() {
            *client = Some(Client::start(ClientOptions::default()).await?);
        }
        self.accepting_work.store(true, Ordering::Relaxed);
        drop(client);
        let status = self.runtime_status().await;
        let _ = self.events.send(AppEvent::RuntimeStatus {
            status: status.clone(),
        });
        Ok(status)
    }

    pub async fn cancel_drain(&self) -> Result<RuntimeStatus> {
        if self.client.read().await.is_none() {
            return Err(ServiceError::CopilotDisconnected);
        }
        self.accepting_work.store(true, Ordering::Relaxed);
        let status = self.runtime_status().await;
        let _ = self.events.send(AppEvent::RuntimeStatus {
            status: status.clone(),
        });
        Ok(status)
    }

    pub async fn drain(&self, timeout: Duration, force: bool) -> Result<DrainStatus> {
        self.accepting_work.store(false, Ordering::Relaxed);
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
            let _ = self.events.send(AppEvent::RuntimeStatus { status });
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

        let sessions = self
            .active
            .write()
            .await
            .drain()
            .map(|(_, session)| session)
            .collect::<Vec<_>>();
        let disconnected_sessions = sessions.len();
        for session in sessions {
            session.disconnect().await?;
        }
        client
            .stop()
            .await
            .map_err(|error| ServiceError::Persistence(error.to_string()))?;
        *self.client.write().await = None;
        let status = self.runtime_status().await;
        let _ = self.events.send(AppEvent::RuntimeStatus { status });
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
        self.active
            .read()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| ServiceError::SessionNotActive(session_id.to_string()))
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

    async fn attach(self: &Arc<Self>, session: Arc<Session>) {
        let session_id = session.id().to_string();
        self.active
            .write()
            .await
            .insert(session_id.clone(), session.clone());
        let _ = self.events.send(AppEvent::SessionAttached {
            session_id: session_id.clone(),
        });

        let mut receiver = session.subscribe();
        let events = self.events.clone();
        tokio::spawn(async move {
            while let Ok(event) = receiver.recv().await {
                let _ = events.send(AppEvent::SessionEvent {
                    session_id: session_id.clone(),
                    event,
                });
            }
        });
    }

    async fn persist_metadata(&self) -> Result<()> {
        let json = serde_json::to_vec_pretty(&*self.metadata.read().await)
            .map_err(|e| ServiceError::Persistence(e.to_string()))?;
        let temp = self.metadata_path.with_extension("json.tmp");
        std::fs::write(&temp, json).map_err(|e| ServiceError::Persistence(e.to_string()))?;
        std::fs::rename(temp, &self.metadata_path)
            .map_err(|e| ServiceError::Persistence(e.to_string()))
    }
}

fn load_metadata(path: &Path) -> HashMap<String, StoredSessionMeta> {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn validate_cwd(cwd: &str) -> Result<()> {
    let path = Path::new(cwd);
    if path.is_dir() {
        Ok(())
    } else {
        Err(ServiceError::InvalidWorkingDirectory(cwd.to_string()))
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
