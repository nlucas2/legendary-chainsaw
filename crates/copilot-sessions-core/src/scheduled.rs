//! Scheduler-only admission. Never resumes inherited work or changes approvals.
use std::sync::Arc;
use std::time::Duration;

use github_copilot_sdk::rpc::SendRequest;

use crate::{AppEvent, NewSession, Result, ServiceError, SessionService};

#[derive(Debug)]
pub enum ScheduledDelivery {
    Deferred(String),
    Completed { message_id: String },
    Failed { message_id: String, error: String },
    Uncertain(String),
}

impl SessionService {
    /// This read validates identity without opening or resuming a conversation.
    pub async fn validate_scheduled_target(&self, session_id: &str) -> Result<()> {
        if self
            .initializations
            .read()
            .await
            .deleted
            .contains(session_id)
        {
            return Err(ServiceError::InvalidArgument(
                "Scheduled target was deleted".into(),
            ));
        }
        if self
            .list_sessions()
            .await?
            .iter()
            .any(|s| s.session_id == session_id)
        {
            Ok(())
        } else {
            Err(ServiceError::InvalidArgument(
                "Unknown scheduled target session".into(),
            ))
        }
    }

    pub async fn create_scheduled_session(
        self: &Arc<Self>,
        name: &str,
        cwd: String,
        model: Option<String>,
    ) -> Result<String> {
        let session = self
            .create_session(NewSession {
                cwd,
                name: None,
                model,
                reasoning_effort: None,
                reasoning_summary: None,
                context_tier: None,
                defer_initialization: true,
                profile_id: None,
                profile_revision: None,
            })
            .await?;
        {
            let mut metadata = self.metadata.write().await;
            let meta = metadata
                .get_mut(&session.session_id)
                .ok_or_else(|| ServiceError::SessionNotActive(session.session_id.clone()))?;
            meta.title = Some(name.into());
            meta.pinned = true;
            meta.folder = Some("Scheduled".into());
            meta.tags = vec!["scheduled".into()];
        }
        self.persist_metadata().await?;
        Ok(session.session_id)
    }

    /// Returns a reason rather than claiming work when runtime admission is closed.
    pub async fn scheduled_availability(&self, session_id: Option<&str>) -> Result<Option<String>> {
        let status = self.runtime_status().await;
        if !status.accepting_work || !status.connected {
            return Ok(Some(
                "Copilot is disconnected or draining; due run remains pending".into(),
            ));
        }
        if let Some(id) = session_id
            && self.active.read().await.contains_key(id)
        {
            let _lifecycle = self.lifecycle_gate.read().await;
            self.require_accepting_work()?;
            let gate = self.turn_gate(id).await;
            let _turn = gate.lock().await;
            return self.scheduled_busy_reason(id).await;
        }
        Ok(None)
    }

    async fn scheduled_busy_reason(&self, id: &str) -> Result<Option<String>> {
        if self.require_profile_ready(id).await.is_err() {
            return Ok(Some("Target session profile configuration is being applied or needs recovery".into()));
        }
        self.session(id).await?;
        // Runtime processing may lag the immediately preceding acceptance.
        if self
            .last_submissions
            .read()
            .await
            .get(id)
            .is_some_and(|at| at.elapsed() < Duration::from_secs(2))
            || self.session_processing(id).await?
        {
            return Ok(Some("Target session is processing".into()));
        }
        let session = self.session(id).await?;
        // The queued item's agentMode alone does not override an autopilot
        // session's continuation loop or permission posture.
        if serde_json::json!(session.rpc().mode().get().await?) != serde_json::json!("interactive")
        {
            return Ok(Some(
                "Target session must be in interactive mode; change its mode before retrying"
                    .into(),
            ));
        }
        let queue = session.rpc().queue().pending_items().await?;
        if !queue.items.is_empty() || !queue.steering_messages.is_empty() {
            return Ok(Some("Target session has queued messages".into()));
        }
        if !self.pending_interactions_async(id).await?.is_empty()
            || self.pending_permissions().iter().any(|event|
                matches!(event, AppEvent::PermissionRequested { session_id, .. } if session_id == id))
        {
            return Ok(Some("Target session is waiting for user input or permission".into()));
        }
        // Query only at scheduled admission, not on the ordinary UI hot path.
        // Unknown states fail closed; detached descendants not reported by the
        // runtime cannot be inferred from root processing alone.
        if session
            .rpc()
            .tasks()
            .list()
            .await?
            .tasks
            .iter()
            .any(|task| {
                !matches!(
                    task.get("status").and_then(serde_json::Value::as_str),
                    Some("completed" | "failed" | "cancelled")
                )
            })
        {
            return Ok(Some(
                "Target session has outstanding background tasks".into(),
            ));
        }
        Ok(None)
    }

    pub async fn deliver_scheduled_prompt(
        self: &Arc<Self>,
        session_id: String,
        prompt: String,
        source: String,
    ) -> Result<ScheduledDelivery> {
        let message = scheduled_message(prompt, source)?;
        self.require_accepting_work()?;
        self.resume_session_with_pending_work(session_id.clone(), false)
            .await?;
        let lifecycle = self.lifecycle_gate.read().await;
        self.require_accepting_work()?;
        let gate = self.turn_gate(&session_id).await;
        let turn = gate.lock().await;
        if let Some(reason) = self.scheduled_busy_reason(&session_id).await? {
            return Ok(ScheduledDelivery::Deferred(reason));
        }
        let session = self.session(&session_id).await?;
        let mut events = session.subscribe();
        self.require_accepting_work()?;
        self.last_submissions
            .write()
            .await
            .insert(session_id.clone(), tokio::time::Instant::now());
        // MessageOptions omits provenance; use the schema-backed send RPC,
        // retaining the same attached session and normal approval callbacks.
        let accepted = session.rpc().send(message).await;
        drop(turn);
        drop(lifecycle);
        // Any send error might follow acceptance. Never blindly retry it.
        let message_id = match accepted {
            Ok(result) => result.message_id,
            Err(error) => {
                return Ok(ScheduledDelivery::Uncertain(format!(
                    "Dispatch acknowledgement was lost: {error}. Inspect the conversation before resuming."
                )));
            }
        };
        let cancellation = session.cancellation_token();
        let mut started = false;
        loop {
            let event = tokio::select! {
                _ = cancellation.cancelled() => return Ok(ScheduledDelivery::Uncertain(
                    "Session disconnected before completion; inspect the conversation before resuming".into())),
                event = events.recv() => match event {
                    Ok(event) => event,
                    Err(error) => return Ok(ScheduledDelivery::Uncertain(format!(
                        "Completion event stream was lost: {error}. Inspect the conversation before resuming."
                    ))),
                }
            };
            if event.agent_id.is_some() {
                continue;
            }
            match event.event_type.as_str() {
                "assistant.turn_start" => started = true,
                "session.idle" if started => {
                    return Ok(ScheduledDelivery::Completed { message_id });
                }
                "session.error" => {
                    return Ok(ScheduledDelivery::Failed {
                        message_id,
                        error: event
                            .data
                            .get("message")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("Scheduled turn failed")
                            .into(),
                    });
                }
                _ => {}
            }
        }
    }
}

fn scheduled_message(prompt: String, source: String) -> Result<SendRequest> {
    if source.len() > 128
        || !source
            .strip_prefix("schedule-")
            .is_some_and(|id| !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return Err(ServiceError::InvalidArgument(
            "Invalid scheduled message provenance".into(),
        ));
    }
    // The SDK's source field is crate-private but is part of its deserializable
    // native schema. Only the runtime-documented schedule-<numeric-id> form is
    // allowed; never fall back to an untagged/human message.
    serde_json::from_value(serde_json::json!({
        "prompt": prompt, "mode": "enqueue", "agentMode": "interactive", "source": source,
    }))
    .map_err(|error| ServiceError::InvalidArgument(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scheduled_message_requires_explicit_nonhuman_native_provenance() {
        for source in [
            "",
            "user",
            "system",
            "scheduled-task-123",
            "schedule-",
            "schedule-abc",
        ] {
            assert!(scheduled_message("test".into(), source.into()).is_err());
        }
        let message =
            serde_json::to_value(scheduled_message("test".into(), "schedule-123".into()).unwrap())
                .unwrap();
        assert_eq!(message["source"], "schedule-123");
        assert_eq!(message["agentMode"], "interactive");
        assert_eq!(message["mode"], "enqueue");
        assert!(message.get("billable").is_none());
    }
}
