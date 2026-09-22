use github_copilot_sdk::rpc::{ModeSetRequest, ModeSetResult};
use github_copilot_sdk::types::{AgentMode, Attachment, DeliveryMode, MessageOptions};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{Result, ServiceError, SessionService};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SendMessageRequest {
    pub session_id: String,
    pub content: String,
    pub agent_mode: Option<AgentMode>,
    pub delivery_mode: Option<DeliveryMode>,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
}

impl SendMessageRequest {
    pub fn validate_browser_attachments(&self) -> Result<()> {
        crate::attachments::validate_attachments(&self.attachments, true)
    }
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum QueueAction {
    SendNow {
        session_id: String,
        item_id: String,
    },
    Move {
        session_id: String,
        item_id: String,
        to_position: i64,
    },
    Update {
        session_id: String,
        item_id: String,
        prompt: String,
    },
}

impl QueueAction {
    pub fn session_id(&self) -> &str {
        match self {
            Self::SendNow { session_id, .. }
            | Self::Move { session_id, .. }
            | Self::Update { session_id, .. } => session_id,
        }
    }
    fn wire(&self) -> (&'static str, Value) {
        match self {
            Self::SendNow {
                session_id,
                item_id,
            } => (
                "session.queue.sendNow",
                json!({"sessionId":session_id,"id":item_id}),
            ),
            Self::Move {
                session_id,
                item_id,
                to_position,
            } => (
                "session.queue.moveItem",
                json!({"sessionId":session_id,"id":item_id,"toPosition":to_position}),
            ),
            Self::Update {
                session_id,
                item_id,
                prompt,
            } => (
                "session.queue.updateText",
                json!({"sessionId":session_id,"id":item_id,"prompt":prompt,"displayPrompt":prompt}),
            ),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetSessionMode {
    pub session_id: String,
    pub mode: AgentMode,
    pub compaction_decision: Option<String>,
    pub plan_exit_action: Option<String>,
    pub restore_plan_model: Option<bool>,
    pub plan_model: Option<String>,
    pub plan_model_configured: Option<bool>,
    pub plan_reasoning_effort: Option<String>,
    pub plan_context_tier: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub session_id: String,
    pub processing: bool,
    pub mode: AgentMode,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSessionModeResult {
    #[serde(flatten)]
    pub result: ModeSetResult,
    pub effective_mode: AgentMode,
    /// Explicit host follow-up requirements; never silently start a new turn.
    pub pending_post_actions: Vec<String>,
}

impl SessionService {
    pub async fn submit_message(&self, request: SendMessageRequest) -> Result<String> {
        crate::attachments::validate_attachments(&request.attachments, false)?;
        let _lifecycle = self.lifecycle_gate.read().await;
        self.require_accepting_work()?;
        self.require_profile_ready(&request.session_id).await?;
        let gate = self.turn_gate(&request.session_id).await;
        let _guard = gate.lock().await;
        self.require_accepting_work()?;
        self.require_profile_ready(&request.session_id).await?;
        let session = self.session(&request.session_id).await?;
        let mut options = MessageOptions::new(request.content)
            .with_mode(request.delivery_mode.unwrap_or(DeliveryMode::Enqueue))
            .with_attachments(request.attachments);
        if let Some(mode) = request.agent_mode {
            options = options.with_agent_mode(mode);
        }
        self.last_submissions
            .write()
            .await
            .insert(request.session_id.clone(), tokio::time::Instant::now());
        // send returns the runtime's acceptance id, not the model completion.
        let accepted = session.send(options).await?;
        // A fork must not replay inherited work. Once the user starts a new
        // turn, its own pending work should recover normally after reconnect.
        self.allow_new_work_recovery(&request.session_id).await?;
        Ok(accepted)
    }

    pub async fn session_state(&self, session_id: &str) -> Result<SessionState> {
        let session = self.attached_session(session_id).await?;
        let mode_rpc = session.rpc().mode();
        let (processing, mode) = tokio::join!(self.session_processing(session_id), mode_rpc.get());
        let mode = serde_json::from_value(json!(mode?)).map_err(invalid_argument)?;
        Ok(SessionState {
            session_id: session_id.into(),
            processing: processing?,
            mode,
        })
    }

    pub async fn set_session_mode(&self, request: SetSessionMode) -> Result<SetSessionModeResult> {
        if request.compaction_decision.is_some() {
            return Err(ServiceError::CapabilityUnavailable(
                "Compaction confirmation cannot be completed by this adapter: the pinned SDK does not document valid compactionDecision values. No mode change was submitted. Dismiss the confirmation to keep the current mode, or resolve it in a supported runtime client and refresh.".into(),
            ));
        }
        let _lifecycle = self.lifecycle_gate.read().await;
        self.require_accepting_work()?;
        let gate = self.turn_gate(&request.session_id).await;
        let _guard = gate.lock().await;
        self.require_accepting_work()?;
        self.require_profile_ready(&request.session_id).await?;
        let session = self.session(&request.session_id).await?;
        let mut result = session
            .rpc()
            .mode()
            .set(ModeSetRequest {
                mode: serde_json::from_value(json!(request.mode)).map_err(invalid_argument)?,
                compaction_decision: request.compaction_decision,
                plan_exit_action: request.plan_exit_action,
                restore_plan_model: request.restore_plan_model,
                plan_model: request.plan_model,
                plan_model_configured: request.plan_model_configured,
                plan_reasoning_effort: request.plan_reasoning_effort,
                plan_context_tier: request.plan_context_tier,
                // Never mutate user/global model preferences from this endpoint.
                persist_plan_selection: Some(false),
                ..Default::default()
            })
            .await?;
        let effective_mode = serde_json::from_value(json!(session.rpc().mode().get().await?))
            .map_err(invalid_argument)?;
        if result.confirmation.is_some() || result.status == "confirmation_required" {
            let guidance = "Compaction confirmation is required. No decision was submitted. This adapter cannot safely complete that confirmation with the pinned SDK; dismiss to keep the current mode, or resolve it in a supported runtime client and refresh.";
            result.message = Some(match result.message {
                Some(message) => format!("{message} {guidance}"),
                None => guidance.into(),
            });
            result.warning = Some(match result.warning {
                Some(warning) => format!("{warning} {guidance}"),
                None => guidance.into(),
            });
        }
        let mut pending_post_actions = Vec::new();
        if result.defer_implementation == Some(true) {
            pending_post_actions.push("defer_implementation".into());
        }
        if result.arm_interactive_continuation == Some(true) {
            pending_post_actions.push("arm_interactive_continuation".into());
        }
        if !pending_post_actions.is_empty() {
            let message = "The runtime requested host follow-up; no continuation or implementation turn was automatically started. Review the pending post-actions before sending.";
            result.message = Some(match result.message {
                Some(native_message) => format!("{native_message} {message}"),
                None => message.into(),
            });
            result.warning = Some(match result.warning {
                Some(warning) => format!("{warning} {message}"),
                None => message.into(),
            });
        }
        Ok(SetSessionModeResult {
            result,
            effective_mode,
            pending_post_actions,
        })
    }

    pub async fn queue_action(&self, action: QueueAction) -> Result<Value> {
        let _lifecycle = self.lifecycle_gate.read().await;
        self.require_accepting_work()?;
        let gate = self.turn_gate(action.session_id()).await;
        let _guard = gate.lock().await;
        self.require_accepting_work()?;
        self.session(action.session_id()).await?;
        if matches!(&action, QueueAction::SendNow { .. }) {
            self.require_profile_ready(action.session_id()).await?;
            self.last_submissions.write().await.insert(action.session_id().into(), tokio::time::Instant::now());
        }
        let (method, params) = action.wire();
        Ok(self.client().await?.call(method, Some(params)).await?)
    }

    pub async fn runtime_info(&self) -> Result<Value> {
        let status = self.runtime_status().await;
        let client = self.client.read().await.clone();
        let Some(client) = client else {
            return Ok(json!({ "status": status, "connected": false }));
        };
        let runtime = client.get_status().await?;
        let timings = client.startup_timings().map(|t| {
            json!({
                "programResolveMs":t.program_resolve_ms, "processSpawnMs":t.process_spawn_ms,
                "portWaitMs":t.port_wait_ms, "transportSetupMs":t.transport_setup_ms,
                "handshakeMs":t.handshake_ms, "sessionFsMs":t.session_fs_ms,
                "llmHandlerMs":t.llm_handler_ms, "totalMs":t.total_ms
            })
        });
        Ok(json!({
            "status":status, "connected":true,
            "version":runtime.version, "protocolVersion":runtime.protocol_version,
            "startupTimings":timings,
            "runtimePath":null,
            "runtimePathUnavailableReason":"The SDK does not expose the launched runtime path."
        }))
    }
}

pub(crate) fn invalid_argument(error: impl std::fmt::Display) -> ServiceError {
    ServiceError::InvalidArgument(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn submit_defaults_and_enums_are_strict() {
        let request: SendMessageRequest =
            serde_json::from_value(json!({"sessionId":"s","content":"hi"})).unwrap();
        assert!(request.delivery_mode.is_none());
        assert!(request.attachments.is_empty());
        for invalid in [
            json!({"agentMode":"invented"}),
            json!({"deliveryMode":"later"}),
            json!({"attachments":[{"type":"invented"}]}),
        ] {
            let mut body = json!({"sessionId":"s","content":"hi"});
            body.as_object_mut()
                .unwrap()
                .extend(invalid.as_object().unwrap().clone());
            assert!(serde_json::from_value::<SendMessageRequest>(body).is_err());
        }
        assert!(serde_json::from_value::<SendMessageRequest>(json!({"sessionId":"s","content":"","deliveryMode":"immediate","attachments":[{"type":"blob","data":"aGk=","mimeType":"text/plain"}]})).is_ok());
    }

    #[test]
    fn queue_actions_validate_fields_and_use_native_ids() {
        let action: QueueAction = serde_json::from_value(
            json!({"sessionId":"s","action":"move","itemId":"i","toPosition":2}),
        )
        .unwrap();
        assert_eq!(
            action.wire(),
            (
                "session.queue.moveItem",
                json!({"sessionId":"s","id":"i","toPosition":2})
            )
        );
        assert!(
            serde_json::from_value::<QueueAction>(
                json!({"sessionId":"s","action":"move","itemId":"i"})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<QueueAction>(
                json!({"sessionId":"s","action":"unknown","itemId":"i"})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<SetSessionMode>(json!({"sessionId":"s","mode":"unknown"}))
                .is_err()
        );
    }
}
