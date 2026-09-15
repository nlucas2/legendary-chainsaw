mod terminal;

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use copilot_sessions_core::{
    AdoptToolControls, AgentHistoryRequest, AgentTasksRequest, InteractionResponse, NewSession,
    OrganizationUpdate, PermissionDecision, QueueAction, SendAgentMessageRequest,
    SendMessageRequest, ServiceError, SessionService, SetMcpEnabled, SetSessionMode,
    SetToolEnabled, project_app_event,
    AskSessionRequest, ForkSessionRequest, RenameSessionRequest,
};
use serde::Deserialize;
use serde_json::{Value, json};
use terminal::TerminalManager;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

// Twelve MiB of decoded attachments expands to sixteen MiB of base64.
// Leave space for the prompt, filenames, MIME types, and JSON framing.
const MAX_COMMAND_BODY_BYTES: usize = 18 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct DaemonConfig {
    pub bind: SocketAddr,
    pub ui_dir: PathBuf,
    pub access_token: Option<String>,
}

impl DaemonConfig {
    pub fn validate(&self) -> anyhow::Result<()> {
        if !self.bind.ip().is_loopback() && self.access_token.is_none() {
            anyhow::bail!(
                "refusing to bind {} without COPILOT_SESSIONS_TOKEN",
                self.bind
            );
        }
        Ok(())
    }
}

#[derive(Clone)]
struct DaemonState {
    service: Arc<SessionService>,
    terminals: TerminalManager,
    checkpoint_path: PathBuf,
    access_token: Option<String>,
}

pub async fn serve(
    service: Arc<SessionService>,
    config: DaemonConfig,
    listener: tokio::net::TcpListener,
) -> anyhow::Result<()> {
    config.validate()?;
    let checkpoint_path = service.data_dir().join("terminals.json");
    let terminals = TerminalManager::default();
    if let Err(error) = terminals.load_checkpoints(&checkpoint_path) {
        tracing::warn!(%error, "could not load terminal checkpoints");
    }
    let state = DaemonState {
        service,
        terminals,
        checkpoint_path,
        access_token: config.access_token,
    };
    let index = config.ui_dir.join("index.html");
    let static_files = ServeDir::new(config.ui_dir).fallback(ServeFile::new(index));
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin, _| {
            matches!(
                origin.as_bytes(),
                b"http://localhost:1420"
                    | b"http://127.0.0.1:1420"
                    | b"tauri://localhost"
                    | b"http://tauri.localhost"
                    | b"https://tauri.localhost"
            )
        }))
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION])
        .allow_credentials(true);
    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/login", post(login))
        .route("/api/events", get(events))
        .route("/api/terminal", get(terminal))
        .route(
            "/api/{command}",
            post(command).layer(DefaultBodyLimit::max(MAX_COMMAND_BODY_BYTES)),
        )
        .fallback_service(static_files)
        .layer(cors)
        .with_state(state);

    tracing::info!(address = %config.bind, "copilot-sessionsd listening");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "service": "copilot-sessionsd" }))
}

#[derive(Deserialize)]
struct LoginRequest {
    token: String,
}

async fn login(State(state): State<DaemonState>, Json(body): Json<LoginRequest>) -> Response {
    if state.access_token.as_deref() != Some(body.token.as_str()) {
        return (StatusCode::UNAUTHORIZED, "invalid access token").into_response();
    }
    let mut response = Json(json!({ "ok": true })).into_response();
    let cookie = format!(
        "copilot_sessions_token={}; HttpOnly; SameSite=Strict; Path=/",
        body.token
    );
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}

async fn events(
    State(state): State<DaemonState>,
    Query(query): Query<EventQuery>,
    headers: HeaderMap,
) -> Result<
    Sse<impl futures_util::Stream<Item = std::result::Result<Event, axum::Error>>>,
    StatusCode,
> {
    authorize(&state, &headers, None)?;
    let after = headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
        .or(query.after);
    let stream = futures_util::stream::unfold(
        state.service.subscribe(after),
        move |mut subscription| async move {
            loop {
                let raw = subscription.recv().await?;
                let Some(event) = project_app_event(raw, query.diagnostics) else {
                    continue;
                };
                let data = serde_json::to_string(&event).ok()?;
                return Some((
                    Ok(Event::default()
                        .event("session-event")
                        .id(event.sequence.to_string())
                        .data(data)),
                    subscription,
                ));
            }
        },
    );
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

#[derive(Default, Deserialize)]
struct EventQuery {
    after: Option<u64>,
    #[serde(default)]
    diagnostics: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalQuery {
    session_id: String,
    client_id: String,
    cwd: String,
    token: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
}

async fn terminal(
    State(state): State<DaemonState>,
    headers: HeaderMap,
    Query(query): Query<TerminalQuery>,
    upgrade: WebSocketUpgrade,
) -> Result<Response, StatusCode> {
    authorize(&state, &headers, query.token.as_deref())?;
    Ok(upgrade
        .on_upgrade(move |socket| async move {
            state
                .terminals
                .attach(
                    socket,
                    query.session_id,
                    query.client_id,
                    PathBuf::from(query.cwd),
                    query.cols,
                    query.rows,
                )
                .await
        })
        .into_response())
}

async fn command(
    State(state): State<DaemonState>,
    headers: HeaderMap,
    Path(command): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    if let Err(status) = authorize(&state, &headers, None) {
        return status.into_response();
    }
    match dispatch(&state, &command, body).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => {
            let status = match error {
                ServiceError::SessionNotActive(_)
                | ServiceError::SessionProcessing(_)
                | ServiceError::PermissionNotPending(_)
                | ServiceError::InteractionNotPending(_) => StatusCode::CONFLICT,
                ServiceError::InvalidArgument(_) => StatusCode::BAD_REQUEST,
                ServiceError::CapabilityUnavailable(_) => StatusCode::NOT_IMPLEMENTED,
                ServiceError::InvalidWorkingDirectory(_) => StatusCode::BAD_REQUEST,
                ServiceError::CommandFailed(_) => StatusCode::BAD_REQUEST,
                ServiceError::CopilotDisconnected | ServiceError::Draining => {
                    StatusCode::SERVICE_UNAVAILABLE
                }
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            };
            (status, error.to_string()).into_response()
        }
    }
}

async fn dispatch(state: &DaemonState, command: &str, body: Value) -> Result<Value, ServiceError> {
    let service = &state.service;
    match command {
        "list_sessions" => json_result(service.list_sessions().await?),
        "create_session" => {
            let request: NewSession = decode(body)?;
            json_result(service.create_session(request).await?)
        }
        "ask_session" => json_result(service.ask_session(decode::<AskSessionRequest>(body)?).await?),
        "fork_session" => json_result(service.fork_session(decode::<ForkSessionRequest>(body)?).await?),
        "rename_session" => json_result(service.rename_session(decode::<RenameSessionRequest>(body)?).await?),
        "git_repository" | "git_workspace" => {
            let request = decode::<GitWorkspaceArgs>(body)?;
            let cwd = service.cwd_for(&request.session_id).await.ok_or_else(|| ServiceError::InvalidArgument(
                "This session has no working directory.".into(),
            ))?;
            if command == "git_repository" {
                json_result(copilot_sessions_core::git_workspace::repository(&cwd).await.map_err(ServiceError::CommandFailed)?)
            } else {
                json_result(copilot_sessions_core::git_workspace::workspace(&cwd, request.base.as_deref()).await.map_err(ServiceError::CommandFailed)?)
            }
        }
        "git_diff" => {
            let request = decode::<GitDiffArgs>(body)?;
            let cwd = service.cwd_for(&request.session_id).await.ok_or_else(|| ServiceError::InvalidArgument(
                "This session has no working directory.".into(),
            ))?;
            json_result(copilot_sessions_core::git_workspace::diff(&cwd,
                copilot_sessions_core::git_workspace::GitDiffRequest {
                    view: request.view, path: request.path, base: request.base,
                }).await.map_err(ServiceError::CommandFailed)?)
        }
        "resume_session" => {
            let session_id = string_arg(&body, "sessionId")?;
            json_result(service.resume_session(session_id).await?)
        }
        "refresh_session" => {
            let session_id = string_arg(&body, "sessionId")?;
            json_result(service.refresh_session(session_id).await?)
        }
        "session_history" => {
            let session_id = string_arg(&body, "sessionId")?;
            let cursor = body
                .get("cursor")
                .and_then(Value::as_str)
                .map(str::to_owned);
            json_result(service.history(&session_id, cursor).await?)
        }
        "session_history_window" => {
            let session_id = string_arg(&body, "sessionId")?;
            json_result(service.recent_history(&session_id).await?)
        }
        "subagent_context" => {
            let session_id = string_arg(&body, "sessionId")?;
            json_result(service.subagent_context(&session_id).await?)
        }
        "agent_tasks" => json_result(
            service
                .agent_tasks(decode::<AgentTasksRequest>(body)?)
                .await?,
        ),
        "agent_history" => json_result(
            service
                .agent_history(decode::<AgentHistoryRequest>(body)?)
                .await?,
        ),
        "send_agent_message" => json_result(
            service
                .send_agent_message(decode::<SendAgentMessageRequest>(body)?)
                .await?,
        ),
        "send_message" => {
            let request = decode::<SendMessageRequest>(body)?;
            request.validate_browser_attachments()?;
            json_result(service.submit_message(request).await?)
        }
        "session_state" => {
            let session_id = string_arg(&body, "sessionId")?;
            json_result(service.session_state(&session_id).await?)
        }
        "set_session_mode" => json_result(
            service
                .set_session_mode(decode::<SetSessionMode>(body)?)
                .await?,
        ),
        "queue_action" => json_result(service.queue_action(decode::<QueueAction>(body)?).await?),
        "tool_controls" => {
            let session_id = string_arg(&body, "sessionId")?;
            if let Some(refresh) = body.get("refreshInventory") {
                let refresh = refresh.as_bool().ok_or_else(|| {
                    ServiceError::InvalidArgument("refreshInventory must be a boolean".into())
                })?;
                if refresh {
                    return json_result(service.refresh_tool_inventory(&session_id).await?);
                }
            }
            json_result(service.tool_controls(&session_id).await?)
        }
        "adopt_tool_controls" => json_result(
            service
                .adopt_tool_controls(decode::<AdoptToolControls>(body)?)
                .await?,
        ),
        "set_tool_enabled" => json_result(
            service
                .set_tool_enabled(decode::<SetToolEnabled>(body)?)
                .await?,
        ),
        "set_mcp_enabled" => json_result(
            service
                .set_mcp_enabled(decode::<SetMcpEnabled>(body)?)
                .await?,
        ),
        "pending_interactions" => {
            let session_id = string_arg(&body, "sessionId")?;
            json_result(service.pending_interactions_async(&session_id).await?)
        }
        "respond_interaction" => {
            service
                .respond_interaction_async(decode::<InteractionResponse>(body)?)
                .await?;
            Ok(json!({"success": true}))
        }
        "runtime_info" => service.runtime_info().await,
        "queue_items" => {
            let session_id = string_arg(&body, "sessionId")?;
            json_result(service.queue_items(&session_id).await?)
        }
        "remove_queue_item" => {
            let session_id = string_arg(&body, "sessionId")?;
            let item_id = string_arg(&body, "itemId")?;
            json_result(service.remove_queue_item(&session_id, item_id).await?)
        }
        "execute_command" => {
            let session_id = string_arg(&body, "sessionId")?;
            let command_name = string_arg(&body, "commandName")?;
            let args = body
                .get("args")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            json_result(
                service
                    .execute_command(&session_id, command_name, args)
                    .await?,
            )
        }
        "session_references" => {
            let session_id = string_arg(&body, "sessionId")?;
            json_result(service.references(&session_id).await?)
        }
        "context_attribution" => {
            let session_id = string_arg(&body, "sessionId")?;
            json_result(service.context_attribution(&session_id).await?)
        }
        "reference_section" => {
            let session_id = string_arg(&body, "sessionId")?;
            let section = string_arg(&body, "section")?;
            json_result(service.reference_section(&session_id, &section).await?)
        }
        "discover_skills" => {
            let session_id = string_arg(&body, "sessionId")?;
            json_result(service.discover_skills(&session_id).await?)
        }
        "mcp_tools" => {
            let session_id = string_arg(&body, "sessionId")?;
            json_result(service.mcp_tools(&session_id).await?)
        }
        "set_session_cwd" => {
            let session_id = string_arg(&body, "sessionId")?;
            let cwd = string_arg(&body, "cwd")?;
            json_result(service.set_working_directory(&session_id, cwd).await?)
        }
        "model_info" => {
            let session_id = string_arg(&body, "sessionId")?;
            json_result(service.model_info(&session_id).await?)
        }
        "available_models" => json_result(service.available_models().await?),
        "switch_model" => {
            let session_id = string_arg(&body, "sessionId")?;
            let model_id = string_arg(&body, "modelId")?;
            let reasoning_effort = body
                .get("reasoningEffort")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let reasoning_summary = body
                .get("reasoningSummary")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let context_tier = body
                .get("contextTier")
                .and_then(Value::as_str)
                .map(str::to_owned);
            json_result(
                service
                    .switch_model(
                        &session_id,
                        model_id,
                        reasoning_effort,
                        reasoning_summary,
                        context_tier,
                    )
                    .await?,
            )
        }
        "organize_session" => {
            let update = decode::<OrganizationUpdate>(body)?;
            json_result(service.organize_session(update).await?)
        }
        "runtime_status" => json_result(service.runtime_status().await),
        "session_processing" => {
            let session_id = string_arg(&body, "sessionId")?;
            json_result(service.session_processing(&session_id).await?)
        }
        "connect_copilot" => json_result(service.connect_copilot().await?),
        "cancel_drain" => json_result(service.cancel_drain().await?),
        "drain_copilot" => {
            let timeout = body
                .get("timeoutSeconds")
                .and_then(Value::as_u64)
                .unwrap_or(30);
            let force = body.get("force").and_then(Value::as_bool).unwrap_or(false);
            json_result(
                service
                    .drain(std::time::Duration::from_secs(timeout), force)
                    .await?,
            )
        }
        "reload_mcp" => json_result(service.reload_mcp().await?),
        "prepare_restart" => {
            let timeout = body
                .get("timeoutSeconds")
                .and_then(Value::as_u64)
                .unwrap_or(30);
            let force = body.get("force").and_then(Value::as_bool).unwrap_or(false);
            let drain = service
                .drain(std::time::Duration::from_secs(timeout), force)
                .await?;
            if !drain.complete {
                return json_result(json!({
                    "drain": drain,
                    "checkpointedTerminals": 0,
                }));
            }
            let checkpoints = state
                .terminals
                .checkpoint(&state.checkpoint_path)
                .map_err(ServiceError::Persistence)?;
            state.terminals.terminate_all();
            json_result(json!({
                "drain": drain,
                "checkpointedTerminals": checkpoints.len(),
            }))
        }
        "abort_session" => {
            let session_id = string_arg(&body, "sessionId")?;
            service.abort(&session_id).await?;
            Ok(Value::Null)
        }
        "cancel_task" => {
            let session_id = string_arg(&body, "sessionId")?;
            let task_id = string_arg(&body, "taskId")?;
            json_result(service.cancel_task(&session_id, task_id).await?)
        }
        "cancel_background_agents" => {
            let session_id = string_arg(&body, "sessionId")?;
            json_result(service.cancel_background_agents(&session_id).await?)
        }
        "delete_session" => {
            let session_id = string_arg(&body, "sessionId")?;
            service.delete_session(&session_id).await?;
            Ok(Value::Null)
        }
        "decide_permission" => {
            service
                .decide_permission(decode::<PermissionDecision>(body)?)
                .await?;
            Ok(Value::Null)
        }
        "pending_permissions" => json_result(service.pending_permissions()),
        _ => Err(ServiceError::Persistence(format!(
            "unknown command {command}"
        ))),
    }
}

fn authorize(
    state: &DaemonState,
    headers: &HeaderMap,
    query_token: Option<&str>,
) -> Result<(), StatusCode> {
    let Some(expected) = state.access_token.as_deref() else {
        return Ok(());
    };
    let cookie_ok = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|value| {
            value.split(';').find_map(|pair| {
                let (name, value) = pair.trim().split_once('=')?;
                (name == "copilot_sessions_token").then_some(value)
            })
        })
        == Some(expected);
    let bearer_ok = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        == Some(expected);
    if cookie_ok || bearer_ok || query_token == Some(expected) {
        Ok(())
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, ServiceError> {
    serde_json::from_value(value).map_err(|e| ServiceError::InvalidArgument(e.to_string()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GitWorkspaceArgs {
    session_id: String,
    base: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GitDiffArgs {
    session_id: String,
    view: copilot_sessions_core::git_workspace::GitView,
    path: String,
    base: Option<String>,
}

fn string_arg(value: &Value, name: &str) -> Result<String, ServiceError> {
    value
        .get(name)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| ServiceError::InvalidArgument(format!("missing argument {name}")))
}

fn json_result<T: serde::Serialize>(value: T) -> Result<Value, ServiceError> {
    serde_json::to_value(value).map_err(|e| ServiceError::Persistence(e.to_string()))
}

pub fn default_bind() -> SocketAddr {
    SocketAddr::new(IpAddr::from([127, 0, 0, 1]), 3847)
}

#[cfg(test)]
mod api_contract_tests {
    use super::*;

    #[test]
    fn diagnostics_query_is_opt_in_and_preserves_cursor() {
        let Query(default) =
            Query::<EventQuery>::try_from_uri(&"/api/events?after=7".parse().unwrap()).unwrap();
        assert!(!default.diagnostics);
        assert_eq!(default.after, Some(7));
        let Query(enabled) = Query::<EventQuery>::try_from_uri(
            &"/api/events?diagnostics=true&after=7".parse().unwrap(),
        )
        .unwrap();
        assert!(enabled.diagnostics);
        assert_eq!(enabled.after, Some(7));
        assert!(
            Query::<EventQuery>::try_from_uri(&"/api/events?diagnostics=invalid".parse().unwrap())
                .is_err()
        );
    }

    #[test]
    fn invalid_delivery_and_missing_queue_arguments_are_bad_requests() {
        assert!(decode::<AdoptToolControls>(json!({"sessionId":"s"})).is_ok());
        assert!(
            decode::<AdoptToolControls>(json!({"sessionId":"s","availableTools":["*"]})).is_err()
        );
        assert!(matches!(
            decode::<SendMessageRequest>(
                json!({"sessionId":"s","content":"x","deliveryMode":"bad"})
            ),
            Err(ServiceError::InvalidArgument(_))
        ));
        assert!(matches!(
            decode::<QueueAction>(json!({"sessionId":"s","itemId":"i","action":"update"})),
            Err(ServiceError::InvalidArgument(_))
        ));
        assert!(matches!(
            decode::<SetSessionMode>(json!({"sessionId":"s","mode":"unknown"})),
            Err(ServiceError::InvalidArgument(_))
        ));
        assert!(
            decode::<SetMcpEnabled>(json!({"sessionId":"s","serverName":"server","enabled":false}))
                .is_ok()
        );
    }
}
