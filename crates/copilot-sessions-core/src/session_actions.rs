use std::sync::Arc;

use github_copilot_sdk::rpc::{NameSetRequest, SessionsForkRequest, UIEphemeralQueryRequest};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as AsyncMutex;

use crate::{Result, ServiceError, SessionService, SessionSummary, StoredSessionMeta};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AskSessionRequest {
    pub session_id: String,
    pub question: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskSessionResult {
    pub session_id: String,
    pub answer: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForkSessionRequest {
    pub session_id: String,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenameSessionRequest {
    pub session_id: String,
    pub name: String,
}

fn validate_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() || name.encode_utf16().count() > 100 || name.chars().any(char::is_control) {
        return Err(ServiceError::InvalidArgument(
            "session name must contain 1–100 characters and no control characters".into(),
        ));
    }
    Ok(name.to_owned())
}

impl SessionService {
    pub(crate) async fn allow_new_work_recovery(&self, session_id: &str) -> Result<()> {
        let changed = {
            let mut metadata = self.metadata.write().await;
            if let Some(meta) = metadata.get_mut(session_id) {
                std::mem::take(&mut meta.prevent_pending_work)
            } else {
                false
            }
        };
        if changed {
            self.persist_metadata().await.map_err(|error| ServiceError::Persistence(format!(
                "The message was accepted, but recovery settings for this fork could not be saved: {error}"
            )))?;
        }
        Ok(())
    }

    async fn ask_gate(&self, session_id: &str) -> Arc<AsyncMutex<()>> {
        if let Some(gate) = self.ask_gates.read().await.get(session_id).cloned() {
            return gate;
        }
        self.ask_gates
            .write()
            .await
            .entry(session_id.to_owned())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }

    pub async fn ask_session(
        self: &Arc<Self>,
        request: AskSessionRequest,
    ) -> Result<AskSessionResult> {
        let question = request.question.trim().to_owned();
        if question.is_empty() {
            return Err(ServiceError::InvalidArgument(
                "question must not be empty".into(),
            ));
        }
        self.require_accepting_work()?;
        self.session(&request.session_id).await?;
        let gate = self
            .ask_gate(&request.session_id)
            .await
            .try_lock_owned()
            .map_err(|_| {
                ServiceError::CommandFailed(
                    "An /ask query is already running for this session.".into(),
                )
            })?;
        let service = Arc::clone(self);
        // Dropping the HTTP caller must not release the gate while the native
        // query is still running. In particular, drain must wait for that query.
        tokio::spawn(async move {
            let _query = gate;
            let _lifecycle = service.lifecycle_gate.read().await;
            service.require_accepting_work()?;
            let session = service.session(&request.session_id).await?;
            let mut params = UIEphemeralQueryRequest::default();
            params.question = question;
            let result = session.rpc().ui().ephemeral_query(params).await?;
            // Native events have a runtime-minted requestId, but neither request
            // nor result expose its correlation. Never claim a shared event by
            // timing, question text, or "the next query" from another client.
            Ok(AskSessionResult {
                session_id: request.session_id,
                answer: result.answer,
            })
        })
        .await
        .map_err(|error| ServiceError::CommandFailed(format!("/ask task failed: {error}")))?
    }

    pub async fn fork_session(
        self: &Arc<Self>,
        request: ForkSessionRequest,
    ) -> Result<SessionSummary> {
        let name = request.name.as_deref().map(validate_name).transpose()?;
        self.require_accepting_work()?;
        let service = Arc::clone(self);
        tokio::spawn(async move {
            let _lifecycle = service.lifecycle_gate.read().await;
            let gate = service.turn_gate(&request.session_id).await;
            let _parent = gate
                .try_lock()
                .map_err(|_| ServiceError::SessionProcessing(request.session_id.clone()))?;
            service.require_accepting_work()?;
            service.session(&request.session_id).await?;
            if service.session_processing(&request.session_id).await? {
                return Err(ServiceError::SessionProcessing(request.session_id));
            }
            let source = service.action_summary(&request.session_id).await?;
            let result = service
                .client()
                .await?
                .rpc()
                .sessions()
                .fork(SessionsForkRequest {
                    session_id: request.session_id.clone().into(),
                    name: name.clone(),
                    to_event_id: None,
                })
                .await?;
            let child_id = result.session_id.to_string();
            if child_id.trim().is_empty() || child_id == request.session_id {
                return Err(ServiceError::CommandFailed(
                    "Native fork did not return a separate session.".into(),
                ));
            }
            if service.active.read().await.contains_key(&child_id)
                || service.metadata.read().await.contains_key(&child_id)
                || service
                    .session_cache
                    .read()
                    .await
                    .iter()
                    .any(|item| item.session_id == child_id)
            {
                return Err(ServiceError::CommandFailed(
                    "Native fork returned an existing session; it was not modified.".into(),
                ));
            }
            let source_meta = service
                .metadata
                .read()
                .await
                .get(&request.session_id)
                .cloned()
                .unwrap_or_default();
            let title = name.or(result.name).unwrap_or_else(|| source.title.clone());
            // Native fork owns the history and tool filters. Copy preferences,
            // not app-created/adopted authority to overwrite those filters.
            let meta = StoredSessionMeta {
                cwd: source_meta.cwd.or(source.cwd.clone()),
                model: source_meta.model.or(source.model.clone()),
                reasoning_effort: source_meta.reasoning_effort,
                reasoning_summary: source_meta.reasoning_summary,
                context_tier: source_meta.context_tier,
                title: Some(title.clone()),
                prevent_pending_work: true,
                ..StoredSessionMeta::default()
            };
            let summary = SessionSummary {
                session_id: child_id.clone(),
                title,
                start_time: String::new(),
                modified_time: String::new(),
                cwd: meta.cwd.clone(),
                model: meta.model.clone(),
                is_active: false,
                is_remote: source.is_remote,
                pinned: false,
                folder: None,
                tags: Vec::new(),
            };
            service
                .metadata
                .write()
                .await
                .insert(child_id.clone(), meta);
            service.session_cache.write().await.push(summary);
            service.persist_metadata().await?;
            // This helper assumes the lifecycle guard is already held, avoiding
            // a recursive RwLock read deadlock when drain is waiting for a write.
            service
                .resume_session_with_pending_work_locked(child_id.clone(), false)
                .await
                .map_err(|error| {
                    ServiceError::CommandFailed(format!(
                        "Fork {child_id} was created, but could not be safely attached: {error}"
                    ))
                })
        })
        .await
        .map_err(|error| ServiceError::CommandFailed(format!("Fork task failed: {error}")))?
    }

    pub async fn rename_session(
        self: &Arc<Self>,
        request: RenameSessionRequest,
    ) -> Result<SessionSummary> {
        let name = validate_name(&request.name)?;
        self.require_accepting_work()?;
        let service = Arc::clone(self);
        tokio::spawn(async move {
            let _lifecycle = service.lifecycle_gate.read().await;
            let gate = service.turn_gate(&request.session_id).await;
            let _session_guard = gate.lock().await;
            service.require_accepting_work()?;
            let session = service.session(&request.session_id).await?;
            let mut summary = service.action_summary(&request.session_id).await?;
            session
                .rpc()
                .name()
                .set(NameSetRequest { name: name.clone() })
                .await?;
            if session.rpc().name().get().await?.name.as_deref() != Some(&name) {
                return Err(ServiceError::CommandFailed(
                    "Native rename did not persist the requested name.".into(),
                ));
            }
            service
                .metadata
                .write()
                .await
                .entry(request.session_id.clone())
                .or_default()
                .title = Some(name.clone());
            summary.title = name;
            let mut cache = service.session_cache.write().await;
            if let Some(existing) = cache
                .iter_mut()
                .find(|entry| entry.session_id == request.session_id)
            {
                existing.title = summary.title.clone();
                summary = existing.clone();
            } else {
                cache.push(summary.clone());
            }
            drop(cache);
            service.persist_metadata().await?;
            Ok(summary)
        })
        .await
        .map_err(|error| ServiceError::CommandFailed(format!("Rename task failed: {error}")))?
    }

    async fn action_summary(&self, session_id: &str) -> Result<SessionSummary> {
        if let Some(summary) = self
            .session_cache
            .read()
            .await
            .iter()
            .find(|item| item.session_id == session_id)
        {
            return Ok(summary.clone());
        }
        self.list_sessions()
            .await?
            .into_iter()
            .find(|item| item.session_id == session_id)
            .ok_or_else(|| {
                ServiceError::CommandFailed(format!(
                    "No summary is available for session {session_id}."
                ))
            })
    }
}
