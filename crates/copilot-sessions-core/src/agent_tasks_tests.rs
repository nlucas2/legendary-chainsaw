//! Isolated JSON-RPC regressions; these never attach to real user sessions.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use github_copilot_sdk::{Client, SessionConfig};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

use crate::*;

struct MockRuntime {
    service: Arc<SessionService>,
    calls: Arc<Mutex<Vec<Value>>>,
    replies: Arc<Mutex<Replies>>,
    server: tokio::task::JoinHandle<()>,
}

struct Replies {
    tasks: HashMap<String, Value>,
    send: Value,
    lifecycle: Vec<Value>,
    history: Value,
    fail_list: bool,
}

impl Drop for MockRuntime {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl MockRuntime {
    async fn new() -> Self {
        let (transport, server) = tokio::io::duplex(262_144);
        let (read, write) = tokio::io::split(transport);
        let client = Client::from_streams(read, write, PathBuf::from(".")).unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let replies = Arc::new(Mutex::new(Replies {
            tasks: HashMap::from([
                (
                    "a".into(),
                    json!({"tasks":[agent_task("child", "running")]}),
                ),
                ("b".into(), json!({"tasks":[]})),
            ]),
            send: json!({"sent":true}),
            lifecycle: vec![page(
                vec![event(
                    "start",
                    "subagent.started",
                    Some("event-agent"),
                    json!({
                        "toolCallId":"invocation-child","agentDisplayName":"same name"
                    }),
                )],
                "identity-end",
                false,
            )],
            history: page(vec![], "history-end", false),
            fail_list: false,
        }));
        let recorded = calls.clone();
        let responses = replies.clone();
        let server = tokio::spawn(async move {
            let (read, mut write) = tokio::io::split(server);
            let mut read = BufReader::new(read);
            loop {
                let mut header = String::new();
                if read.read_line(&mut header).await.unwrap_or(0) == 0 {
                    break;
                }
                let length: usize = header
                    .trim()
                    .strip_prefix("Content-Length: ")
                    .unwrap()
                    .parse()
                    .unwrap();
                let mut blank = String::new();
                read.read_line(&mut blank).await.unwrap();
                let mut bytes = vec![0; length];
                read.read_exact(&mut bytes).await.unwrap();
                let request: Value = serde_json::from_slice(&bytes).unwrap();
                recorded.lock().unwrap().push(request.clone());
                let Some(method) = request["method"].as_str() else {
                    continue;
                };
                let response = {
                    let replies = responses.lock().unwrap();
                    let params = &request["params"];
                    let result = match method {
                        "session.create" => Some(json!({"sessionId":params["sessionId"]})),
                        "session.tasks.list" if replies.fail_list => None,
                        "session.tasks.list" => replies
                            .tasks
                            .get(params["sessionId"].as_str().unwrap())
                            .cloned(),
                        "session.tasks.sendMessage" => Some(replies.send.clone()),
                        "session.eventLog.read" if params.get("agentIds").is_some() => {
                            Some(replies.history.clone())
                        }
                        "session.eventLog.read" => {
                            let index = params["cursor"]
                                .as_str()
                                .and_then(|cursor| {
                                    replies
                                        .lifecycle
                                        .iter()
                                        .position(|page| page["cursor"] == cursor)
                                })
                                .map_or(0, |i| i + 1);
                            replies.lifecycle.get(index).cloned()
                        }
                        _ => None,
                    };
                    match result {
                        Some(result) => json!({"jsonrpc":"2.0","id":request["id"],"result":result}),
                        None => {
                            json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32000,"message":"native runtime unavailable"}})
                        }
                    }
                };
                let bytes = serde_json::to_vec(&response).unwrap();
                if write
                    .write_all(format!("Content-Length: {}\r\n\r\n", bytes.len()).as_bytes())
                    .await
                    .is_err()
                {
                    break;
                }
                if write.write_all(&bytes).await.is_err() {
                    break;
                }
            }
        });
        let events = EventBus::new();
        let service = Arc::new(SessionService {
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
            session_cache: RwLock::new(vec![]),
            events: events.clone(),
            approvals: Arc::new(ApprovalBroker {
                events: events.clone(),
                pending: Mutex::new(HashMap::new()),
            }),
            interactions: Arc::new(interactions::InteractionBroker::new(events)),
            tool_state: RwLock::new(HashMap::new()),
            tool_catalog: tool_catalog::ToolCatalog::default(),
            metadata_path: PathBuf::from("target").join("agent-tests-unused.json"),
            metadata: RwLock::new(HashMap::new()),
            metadata_write_gate: AsyncMutex::new(()),
        });
        for id in ["a", "b"] {
            let session = service
                .client()
                .await
                .unwrap()
                .create_session(SessionConfig::default().with_session_id(id))
                .await
                .unwrap();
            service
                .active
                .write()
                .await
                .insert(id.into(), Arc::new(session));
        }
        calls.lock().unwrap().clear();
        Self {
            service,
            calls,
            replies,
            server,
        }
    }

    fn requests(&self, method: &str) -> Vec<Value> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| call["method"] == method)
            .cloned()
            .collect()
    }
}

fn agent_task(id: &str, status: &str) -> Value {
    json!({
        "type":"agent","id":id,"toolCallId":format!("invocation-{id}"),
        "agentType":"explore","displayName":"same name","status":status,
        "model":"requested-model","resolvedModel":"actual-model",
        "prompt":"LATEST ONLY: never invent transcript from this",
        "latestResponse":"LATEST RESPONSE ONLY"
    })
}

fn event(id: &str, kind: &str, agent: Option<&str>, data: Value) -> Value {
    json!({"id":id,"type":kind,"timestamp":"2026-09-14T20:00:00Z","agentId":agent,"data":data})
}

fn page(events: Vec<Value>, cursor: &str, has_more: bool) -> Value {
    json!({"events":events,"cursor":cursor,"hasMore":has_more})
}

fn send_request(session: &str, task: &str, message: &str) -> SendAgentMessageRequest {
    SendAgentMessageRequest {
        session_id: session.into(),
        task_id: task.into(),
        message: message.into(),
    }
}

fn history_request(session: &str, task: &str) -> AgentHistoryRequest {
    AgentHistoryRequest {
        session_id: session.into(),
        task_id: task.into(),
        cursor: None,
    }
}

#[tokio::test]
async fn agent_tasks_lists_only_parent_agents_with_explicit_lifecycle_availability() {
    let runtime = MockRuntime::new().await;
    let statuses = [
        "running",
        "idle",
        "completed",
        "failed",
        "cancelled",
        "future-status",
    ];
    let mut tasks: Vec<Value> = statuses
        .iter()
        .map(|status| agent_task(status, status))
        .collect();
    tasks.extend([
        json!({"type":"shell","id":"shell"}),
        json!({"type":"mcp","id":"one-shot"}),
    ]);
    runtime
        .replies
        .lock()
        .unwrap()
        .tasks
        .insert("a".into(), json!({"tasks":tasks}));
    let list = runtime
        .service
        .agent_tasks(AgentTasksRequest {
            session_id: "a".into(),
        })
        .await
        .unwrap();
    assert_eq!(list.session_id, "a");
    assert_eq!(list.tasks.len(), statuses.len());
    for task in list.tasks {
        assert_eq!(task.model.as_deref(), Some("actual-model"));
        assert_eq!(
            task.can_message,
            matches!(task.status.as_str(), "running" | "idle")
        );
        assert_eq!(task.unavailable_reason.is_some(), !task.can_message);
    }
    assert_eq!(
        runtime.requests("session.tasks.list")[0]["params"],
        json!({"sessionId":"a"})
    );
}

#[tokio::test]
async fn agent_tasks_inactive_or_unknown_parent_does_not_rpc_or_resume() {
    let runtime = MockRuntime::new().await;
    for id in ["inactive", "unknown"] {
        assert!(matches!(
            runtime
                .service
                .agent_tasks(AgentTasksRequest {
                    session_id: id.into()
                })
                .await,
            Err(ServiceError::SessionNotActive(_))
        ));
        assert!(matches!(
            runtime
                .service
                .agent_history(history_request(id, "child"))
                .await,
            Err(ServiceError::SessionNotActive(_))
        ));
        assert!(matches!(
            runtime
                .service
                .send_agent_message(send_request(id, "child", "hello"))
                .await,
            Err(ServiceError::SessionNotActive(_))
        ));
    }
    assert!(runtime.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn agent_tasks_invalid_inputs_are_rejected_before_any_rpc() {
    let runtime = MockRuntime::new().await;
    for (session, task, message) in [
        ("", "child", "hello"),
        ("a", "", "hello"),
        ("a", "child", " \n\t "),
        ("a\n", "child", "hello"),
    ] {
        assert!(matches!(
            runtime
                .service
                .send_agent_message(send_request(session, task, message))
                .await,
            Err(ServiceError::InvalidArgument(_))
        ));
    }
    let mut request = history_request("a", "child");
    request.cursor = Some(" ".into());
    assert!(matches!(
        runtime.service.agent_history(request).await,
        Err(ServiceError::InvalidArgument(_))
    ));
    assert!(
        serde_json::from_value::<SendAgentMessageRequest>(json!({
            "sessionId":"a","taskId":"child","message":"hello","fromAgentId":"impersonation"
        }))
        .is_err()
    );
    assert!(runtime.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn agent_tasks_wrong_parent_type_and_missing_task_are_not_routed() {
    let runtime = MockRuntime::new().await;
    runtime.replies.lock().unwrap().tasks.insert(
        "b".into(),
        json!({"tasks":[
            {"type":"shell","id":"shell"}, {"type":"mcp","id":"one-shot"}
        ]}),
    );
    for task in ["child", "shell", "one-shot", "missing"] {
        assert!(matches!(
            runtime
                .service
                .send_agent_message(send_request("b", task, "hello"))
                .await,
            Err(ServiceError::InvalidArgument(_))
        ));
        assert!(matches!(
            runtime
                .service
                .agent_history(history_request("b", task))
                .await,
            Err(ServiceError::InvalidArgument(_))
        ));
    }
    assert!(runtime.requests("session.tasks.sendMessage").is_empty());
    assert!(runtime.requests("session.eventLog.read").is_empty());
}

#[tokio::test]
async fn agent_tasks_running_and_idle_use_canonical_task_routing_and_native_delivery_status() {
    let runtime = MockRuntime::new().await;
    for status in ["running", "idle"] {
        runtime
            .replies
            .lock()
            .unwrap()
            .tasks
            .insert("a".into(), json!({"tasks":[agent_task("child",status)]}));
        assert!(
            runtime
                .service
                .send_agent_message(send_request("a", "child", "  exact message\n"))
                .await
                .unwrap()
                .sent
        );
    }
    runtime.replies.lock().unwrap().send =
        json!({"sent":false,"error":"agent exited before delivery"});
    let result = runtime
        .service
        .send_agent_message(send_request("a", "child", "hello"))
        .await
        .unwrap();
    assert!(!result.sent);
    assert_eq!(
        result.error.as_deref(),
        Some("agent exited before delivery")
    );
    let calls = runtime.requests("session.tasks.sendMessage");
    assert_eq!(
        calls[0]["params"],
        json!({"sessionId":"a","id":"child","message":"  exact message\n"})
    );
    assert!(
        calls
            .iter()
            .all(|call| call["params"].get("fromAgentId").is_none())
    );
    assert!(runtime.requests("session.send").is_empty());
    assert!(runtime.requests("session.abort").is_empty());
}

#[tokio::test]
async fn agent_tasks_finished_and_unknown_status_are_read_only() {
    let runtime = MockRuntime::new().await;
    for status in ["completed", "failed", "cancelled", "future-status"] {
        runtime
            .replies
            .lock()
            .unwrap()
            .tasks
            .insert("a".into(), json!({"tasks":[agent_task("child",status)]}));
        assert!(matches!(
            runtime
                .service
                .send_agent_message(send_request("a", "child", "hello"))
                .await,
            Err(ServiceError::CapabilityUnavailable(_))
        ));
        assert!(
            runtime
                .service
                .agent_history(history_request("a", "child"))
                .await
                .is_ok()
        );
    }
    assert!(runtime.requests("session.tasks.sendMessage").is_empty());
}

#[tokio::test]
async fn agent_tasks_drain_gate_blocks_new_delivery_without_stopping_parent() {
    let runtime = MockRuntime::new().await;
    let guard = runtime.service.lifecycle_gate.write().await;
    let service = runtime.service.clone();
    let send = tokio::spawn(async move {
        service
            .send_agent_message(send_request("a", "child", "hello"))
            .await
    });
    tokio::task::yield_now().await;
    assert!(!send.is_finished());
    runtime
        .service
        .accepting_work
        .store(false, Ordering::SeqCst);
    drop(guard);
    assert!(matches!(send.await.unwrap(), Err(ServiceError::Draining)));
    assert!(runtime.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn agent_history_uses_exact_provenance_child_only_scoping_and_authoritative_order() {
    let runtime = MockRuntime::new().await;
    let mut first = event(
        "first",
        "user.message",
        Some("event-agent"),
        json!({"content":"original prompt"}),
    );
    let mut last = event(
        "last",
        "assistant.message",
        Some("event-agent"),
        json!({"content":"real response"}),
    );
    first["timestamp"] = json!("2026-09-14T23:00:00Z");
    last["timestamp"] = json!("2026-09-14T19:00:00Z");
    {
        let mut replies = runtime.replies.lock().unwrap();
        replies.lifecycle[0]["events"]
            .as_array_mut()
            .unwrap()
            .insert(
                0,
                event(
                    "other-start",
                    "subagent.started",
                    Some("other-agent"),
                    json!({
                        "toolCallId":"other-invocation","agentDisplayName":"same name"
                    }),
                ),
            );
        replies.history = page(
            vec![
                event(
                    "parent",
                    "user.message",
                    None,
                    json!({"content":"parent must not leak"}),
                ),
                first,
                event(
                    "other",
                    "assistant.message",
                    Some("other-agent"),
                    json!({"parentToolCallId":"event-agent","content":"child must not leak"}),
                ),
                last,
                event(
                    "legacy",
                    "user.message",
                    None,
                    json!({"agentId":"event-agent","content":"legacy follow-up"}),
                ),
            ],
            "older-child-cursor",
            true,
        );
    }
    let result = runtime
        .service
        .agent_history(history_request("a", "child"))
        .await
        .unwrap();
    assert_eq!(result.agent_id, "event-agent");
    assert_eq!(result.task_id, "child");
    assert_eq!(
        result
            .events
            .iter()
            .map(|e| e.id.as_str())
            .collect::<Vec<_>>(),
        ["first", "last", "legacy"]
    );
    assert!(
        result
            .events
            .iter()
            .all(|e| e.agent_id.as_deref() == Some("event-agent"))
    );
    assert_eq!(result.cursor, "older-child-cursor");
    assert!(result.has_more);
    let mut next = history_request("a", "child");
    next.cursor = Some(result.cursor);
    runtime.replies.lock().unwrap().history = page(vec![], "oldest-child-cursor", false);
    assert!(!runtime.service.agent_history(next).await.unwrap().has_more);
    let reads = runtime.requests("session.eventLog.read");
    assert_eq!(reads[1]["params"]["agentIds"], json!(["event-agent"]));
    assert_eq!(reads[1]["params"]["direction"], "backward");
    assert_eq!(reads[1]["params"]["includeEphemeral"], false);
    assert_eq!(reads[1]["params"]["max"], 200);
    assert_eq!(reads[3]["params"]["cursor"], "older-child-cursor");
}

#[tokio::test]
async fn agent_history_pages_lifecycle_provenance_without_content_or_name_guessing() {
    let runtime = MockRuntime::new().await;
    {
        let mut replies = runtime.replies.lock().unwrap();
        replies.lifecycle.insert(
            0,
            page(
                vec![event(
                    "unrelated",
                    "subagent.started",
                    Some("child"),
                    json!({
                        "toolCallId":"wrong","agentDisplayName":"same name"
                    }),
                )],
                "lifecycle-older",
                true,
            ),
        );
    }
    assert_eq!(
        runtime
            .service
            .agent_history(history_request("a", "child"))
            .await
            .unwrap()
            .agent_id,
        "event-agent"
    );
    assert_eq!(
        runtime.requests("session.eventLog.read")[1]["params"]["cursor"],
        "lifecycle-older"
    );
    runtime.replies.lock().unwrap().lifecycle = vec![page(vec![], "no-identity", false)];
    assert!(matches!(
        runtime
            .service
            .agent_history(history_request("a", "child"))
            .await,
        Err(ServiceError::CapabilityUnavailable(_))
    ));
}

#[tokio::test]
async fn agent_tasks_native_errors_and_malformed_responses_are_not_empty_successes() {
    let runtime = MockRuntime::new().await;
    runtime.replies.lock().unwrap().fail_list = true;
    assert!(matches!(
        runtime
            .service
            .agent_tasks(AgentTasksRequest {
                session_id: "a".into()
            })
            .await,
        Err(ServiceError::Copilot(_))
    ));
    assert!(matches!(
        runtime
            .service
            .send_agent_message(send_request("a", "child", "hello"))
            .await,
        Err(ServiceError::Copilot(_))
    ));
    runtime.replies.lock().unwrap().fail_list = false;
    runtime.replies.lock().unwrap().tasks.insert(
        "a".into(),
        json!({"tasks":[agent_task("child","running"),agent_task("child","idle")]}),
    );
    assert!(matches!(
        runtime
            .service
            .agent_tasks(AgentTasksRequest {
                session_id: "a".into()
            })
            .await,
        Err(ServiceError::Persistence(_))
    ));
    runtime
        .replies
        .lock()
        .unwrap()
        .tasks
        .insert("a".into(), json!({"tasks":[{"type":"agent","id":"child"}]}));
    assert!(matches!(
        runtime
            .service
            .agent_tasks(AgentTasksRequest {
                session_id: "a".into()
            })
            .await,
        Err(ServiceError::Persistence(_))
    ));
    for malformed in [
        json!({"tasks":[null]}),
        json!({"tasks":[{"id":"child"}]}),
        json!({"tasks":[{"type":"shell"}]}),
        json!({"tasks":[agent_task("child","running"),{"type":"shell","id":"child"}]}),
    ] {
        runtime
            .replies
            .lock()
            .unwrap()
            .tasks
            .insert("a".into(), malformed);
        assert!(matches!(
            runtime
                .service
                .agent_tasks(AgentTasksRequest {
                    session_id: "a".into()
                })
                .await,
            Err(ServiceError::Persistence(_))
        ));
    }
    assert!(runtime.requests("session.tasks.sendMessage").is_empty());
}

#[tokio::test]
async fn agent_history_rejects_ambiguous_identity_and_bad_pagination() {
    let runtime = MockRuntime::new().await;
    runtime.replies.lock().unwrap().lifecycle[0]["events"]
        .as_array_mut()
        .unwrap()
        .push(event(
            "conflict",
            "subagent.started",
            Some("conflicting-agent"),
            json!({"toolCallId":"invocation-child"}),
        ));
    assert!(matches!(
        runtime
            .service
            .agent_history(history_request("a", "child"))
            .await,
        Err(ServiceError::Persistence(_))
    ));
    runtime.replies.lock().unwrap().lifecycle[0]["events"]
        .as_array_mut()
        .unwrap()
        .pop();
    runtime.replies.lock().unwrap().history = page(vec![], "same-cursor", true);
    let mut request = history_request("a", "child");
    request.cursor = Some("same-cursor".into());
    assert!(matches!(
        runtime.service.agent_history(request).await,
        Err(ServiceError::Persistence(_))
    ));
    runtime.replies.lock().unwrap().history = json!({"cursor":"missing-fields"});
    assert!(matches!(
        runtime
            .service
            .agent_history(history_request("a", "child"))
            .await,
        Err(ServiceError::Persistence(_))
    ));
}

#[tokio::test]
async fn agent_history_identity_search_is_bounded() {
    let runtime = MockRuntime::new().await;
    runtime.replies.lock().unwrap().lifecycle = (0..20)
        .map(|n| page(vec![], &format!("page-{n}"), true))
        .collect();
    assert!(matches!(
        runtime
            .service
            .agent_history(history_request("a", "child"))
            .await,
        Err(ServiceError::CapabilityUnavailable(_))
    ));
    assert_eq!(runtime.requests("session.eventLog.read").len(), 8);
}
