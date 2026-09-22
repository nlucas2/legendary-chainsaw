use std::collections::HashSet;

use github_copilot_sdk::rpc::TasksSendMessageRequest;
pub use github_copilot_sdk::rpc::TasksSendMessageResult;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{Result, ServiceError, SessionEvent, SessionService};

const AGENT_HISTORY_PAGE_SIZE: usize = 200;
const IDENTITY_PAGE_SIZE: usize = 1000;
const IDENTITY_MAX_PAGES: usize = 8;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTasksRequest {
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentHistoryRequest {
    pub session_id: String,
    pub task_id: String,
    pub cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SendAgentMessageRequest {
    pub session_id: String,
    pub task_id: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTask {
    pub id: String,
    pub name: String,
    pub agent_type: String,
    pub status: String,
    pub tool_call_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub can_message: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTasks {
    pub session_id: String,
    pub tasks: Vec<AgentTask>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHistory {
    pub session_id: String,
    pub task_id: String,
    pub agent_id: String,
    pub events: Vec<SessionEvent>,
    pub cursor: String,
    pub has_more: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeAgentTask {
    id: String,
    agent_type: String,
    status: String,
    tool_call_id: String,
    display_name: Option<String>,
    model: Option<String>,
    resolved_model: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventPage {
    events: Vec<SessionEvent>,
    cursor: String,
    has_more: bool,
}

impl RuntimeAgentTask {
    fn normalized(self) -> Result<AgentTask> {
        for (name, value) in [
            ("task id", &self.id),
            ("agentType", &self.agent_type),
            ("status", &self.status),
            ("toolCallId", &self.tool_call_id),
        ] {
            if value.trim().is_empty() {
                return Err(protocol_error(format!("agent task has an empty {name}")));
            }
        }
        let can_message = matches!(self.status.as_str(), "running" | "idle");
        let unavailable_reason = (!can_message).then(|| {
            format!(
                "This agent is {} and is read-only. Only running or idle agents accept messages.",
                self.status
            )
        });
        Ok(AgentTask {
            name: self
                .display_name
                .filter(|name| !name.trim().is_empty())
                .unwrap_or_else(|| self.agent_type.clone()),
            id: self.id,
            agent_type: self.agent_type,
            status: self.status,
            tool_call_id: self.tool_call_id,
            model: self.resolved_model.or(self.model),
            can_message,
            unavailable_reason,
        })
    }
}

impl SessionService {
    pub async fn agent_tasks(&self, request: AgentTasksRequest) -> Result<AgentTasks> {
        validate_id("sessionId", &request.session_id)?;
        let _lifecycle = self.lifecycle_gate.read().await;
        // A sidebar read must never create/resume a runtime session.
        self.attached_session(&request.session_id).await?;
        Ok(AgentTasks {
            tasks: self.parent_agent_tasks(&request.session_id).await?,
            session_id: request.session_id,
        })
    }

    pub async fn send_agent_message(
        &self,
        request: SendAgentMessageRequest,
    ) -> Result<TasksSendMessageResult> {
        validate_id("sessionId", &request.session_id)?;
        validate_id("taskId", &request.task_id)?;
        if request.message.trim().is_empty() {
            return Err(ServiceError::InvalidArgument(
                "message must not be empty".into(),
            ));
        }
        let _lifecycle = self.lifecycle_gate.read().await;
        self.require_accepting_work()?;
        let gate = self.turn_gate(&request.session_id).await;
        let _guard = gate.lock().await;
        self.require_accepting_work()?;
        self.require_profile_ready(&request.session_id).await?;
        let session = self.session(&request.session_id).await?;
        let task = self
            .parent_agent_task(&request.session_id, &request.task_id)
            .await?;
        if !task.can_message {
            return Err(ServiceError::CapabilityUnavailable(
                task.unavailable_reason
                    .unwrap_or_else(|| "Agent is read-only".into()),
            ));
        }
        // Task IDs route messages; event agent IDs are a separate identity namespace.
        // Keep sent:false intact, including when an agent finishes during this RPC.
        self.last_submissions.write().await.insert(request.session_id.clone(), tokio::time::Instant::now());
        Ok(session
            .rpc()
            .tasks()
            .send_message(TasksSendMessageRequest {
                id: task.id,
                message: request.message,
                from_agent_id: None,
            })
            .await?)
    }

    pub async fn agent_history(&self, request: AgentHistoryRequest) -> Result<AgentHistory> {
        validate_id("sessionId", &request.session_id)?;
        validate_id("taskId", &request.task_id)?;
        if let Some(cursor) = &request.cursor
            && (cursor.trim().is_empty() || cursor.len() > 16_384)
        {
            return Err(ServiceError::InvalidArgument(
                "invalid history cursor".into(),
            ));
        }
        let _lifecycle = self.lifecycle_gate.read().await;
        self.attached_session(&request.session_id).await?;
        let task = self
            .parent_agent_task(&request.session_id, &request.task_id)
            .await?;
        let agent_id = self.task_event_agent_id(&request.session_id, &task).await?;
        let page = self
            .agent_event_page(
                &request.session_id,
                request.cursor.as_deref(),
                AGENT_HISTORY_PAGE_SIZE,
                json!("*"),
                Some(&agent_id),
            )
            .await?;
        // Defend against older runtimes ignoring agentIds. Never leak the parent's
        // or another child's transcript, and normalize documented legacy ownership.
        let events = page
            .events
            .into_iter()
            .filter_map(|mut event| {
                if event_owner(&event) != Some(agent_id.as_str()) {
                    return None;
                }
                event.agent_id = Some(agent_id.clone());
                Some(event)
            })
            .collect();
        Ok(AgentHistory {
            session_id: request.session_id,
            task_id: task.id,
            agent_id,
            events,
            cursor: page.cursor,
            has_more: page.has_more,
        })
    }

    async fn parent_agent_tasks(&self, session_id: &str) -> Result<Vec<AgentTask>> {
        let session = self.attached_session(session_id).await?;
        let result = session.rpc().tasks().list().await?;
        let mut ids = HashSet::new();
        let mut agents = Vec::new();
        for task in result.tasks {
            let kind = task
                .get("type")
                .and_then(Value::as_str)
                .ok_or_else(|| protocol_error("task is missing its type"))?;
            let id = task
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| protocol_error("task is missing its identifier"))?;
            if !ids.insert(id.to_owned()) {
                return Err(protocol_error("duplicate parent task identifier"));
            }
            // Shell and MCP one-shot tasks are not interactive agent conversations.
            if kind == "agent" {
                let task: RuntimeAgentTask =
                    serde_json::from_value(task).map_err(protocol_error)?;
                agents.push(task.normalized()?);
            }
        }
        Ok(agents)
    }

    async fn parent_agent_task(&self, session_id: &str, task_id: &str) -> Result<AgentTask> {
        self.parent_agent_tasks(session_id)
            .await?
            .into_iter()
            .find(|task| task.id == task_id)
            .ok_or_else(|| {
                ServiceError::InvalidArgument(format!(
                    "task {task_id} is not an agent task owned by session {session_id}"
                ))
            })
    }

    async fn task_event_agent_id(&self, session_id: &str, task: &AgentTask) -> Result<String> {
        let mut cursor = None;
        for _ in 0..IDENTITY_MAX_PAGES {
            let page = self
                .agent_event_page(
                    session_id,
                    cursor.as_deref(),
                    IDENTITY_PAGE_SIZE,
                    json!(["subagent.started", "subagent.completed", "subagent.failed"]),
                    None,
                )
                .await?;
            let mut identity = None;
            for event in &page.events {
                if !matches!(
                    event.event_type.as_str(),
                    "subagent.started" | "subagent.completed" | "subagent.failed"
                ) || event.data.get("toolCallId").and_then(Value::as_str)
                    != Some(task.tool_call_id.as_str())
                {
                    continue;
                }
                let Some(agent_id) = event
                    .agent_id
                    .as_deref()
                    .or_else(|| event.data.get("agentId").and_then(Value::as_str))
                    .filter(|id| !id.is_empty())
                else {
                    continue;
                };
                if identity.as_deref().is_some_and(|id| id != agent_id) {
                    return Err(protocol_error("ambiguous task-to-agent event identity"));
                }
                identity = Some(agent_id.to_owned());
            }
            if let Some(identity) = identity {
                return Ok(identity);
            }
            if !page.has_more {
                break;
            }
            cursor = Some(page.cursor);
        }
        Err(ServiceError::CapabilityUnavailable(format!(
            "No authoritative event identity is available for agent task {} within the bounded lifecycle history. The runtime may not have persisted its start event yet; retry shortly.",
            task.id
        )))
    }

    async fn agent_event_page(
        &self,
        session_id: &str,
        cursor: Option<&str>,
        max: usize,
        types: Value,
        agent_id: Option<&str>,
    ) -> Result<EventPage> {
        let mut params = json!({
            "sessionId":session_id, "direction":"backward", "includeEphemeral":false,
            "max":max, "types":types, "agentScope":"all",
        });
        if let Some(cursor) = cursor {
            params["cursor"] = json!(cursor);
        }
        if let Some(agent_id) = agent_id {
            params["agentIds"] = json!([agent_id]);
        }
        let result = self
            .client()
            .await?
            .call("session.eventLog.read", Some(params))
            .await?;
        let page: EventPage = serde_json::from_value(result).map_err(protocol_error)?;
        if page.cursor.is_empty()
            || (page.has_more && cursor == Some(page.cursor.as_str()))
            || page.events.len() > max
        {
            return Err(protocol_error(
                "invalid or non-advancing agent history page",
            ));
        }
        Ok(page)
    }
}

fn event_owner(event: &SessionEvent) -> Option<&str> {
    event
        .agent_id
        .as_deref()
        .or_else(|| event.data.get("agentId").and_then(Value::as_str))
        .or_else(|| event.data.get("parentToolCallId").and_then(Value::as_str))
}

fn validate_id(name: &str, value: &str) -> Result<()> {
    if value.trim().is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err(ServiceError::InvalidArgument(format!("invalid {name}")));
    }
    Ok(())
}

fn protocol_error(error: impl std::fmt::Display) -> ServiceError {
    ServiceError::Persistence(format!("invalid agent runtime response: {error}"))
}
