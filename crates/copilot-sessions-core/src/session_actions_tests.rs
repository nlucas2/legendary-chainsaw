//! JSON-RPC fixtures use only duplex streams and project-local metadata.
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;

use github_copilot_sdk::SessionConfig;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

use crate::*;

struct Replies {
    processing: bool,
    hold_ask: bool,
    hold_fork: bool,
    ask: Value,
    fork: Value,
    fail_name_set: bool,
    mismatch_name: bool,
    names: HashMap<String, String>,
}

struct MockRuntime {
    service: Arc<SessionService>,
    calls: Arc<Mutex<Vec<Value>>>,
    replies: Arc<Mutex<Replies>>,
    writer: Arc<AsyncMutex<tokio::io::WriteHalf<tokio::io::DuplexStream>>>,
    server: tokio::task::JoinHandle<()>,
    directory: PathBuf,
}

impl Drop for MockRuntime {
    fn drop(&mut self) {
        self.server.abort();
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

impl MockRuntime {
    async fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let directory = PathBuf::from("target")
            .join("session-action-tests")
            .join(format!(
                "{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        std::fs::create_dir_all(&directory).unwrap();
        let (transport, server) = tokio::io::duplex(262_144);
        let (read, write) = tokio::io::split(transport);
        let client = Client::from_streams(read, write, PathBuf::from(".")).unwrap();
        let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
        let replies = Arc::new(Mutex::new(Replies {
            processing: false,
            hold_ask: false,
            hold_fork: false,
            ask: json!({"answer":"this request's answer"}),
            fork: json!({"sessionId":"fork-child","name":"Native fork"}),
            fail_name_set: false,
            mismatch_name: false,
            names: HashMap::new(),
        }));
        let (read, write) = tokio::io::split(server);
        let writer = Arc::new(AsyncMutex::new(write));
        let recorded = calls.clone();
        let responses = replies.clone();
        let server_writer = writer.clone();
        let server = tokio::spawn(async move {
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
                    let mut replies = responses.lock().unwrap();
                    let params = &request["params"];
                    let id = params["sessionId"].as_str().unwrap_or("");
                    let result = match method {
                        "session.create" | "session.resume" => Some(json!({"sessionId":id})),
                        "session.metadata.isProcessing" => {
                            Some(json!({"processing":replies.processing}))
                        }
                        "session.ui.ephemeralQuery" if replies.hold_ask && id == "a" => {
                            continue;
                        }
                        "session.ui.ephemeralQuery" => Some(replies.ask.clone()),
                        "sessions.fork" if replies.hold_fork => {
                            continue;
                        }
                        "sessions.fork" => Some(replies.fork.clone()),
                        "session.name.set" if replies.fail_name_set => None,
                        "session.name.set" => {
                            replies
                                .names
                                .insert(id.into(), params["name"].as_str().unwrap().into());
                            Some(json!({}))
                        }
                        "session.name.get" if replies.mismatch_name => {
                            Some(json!({"name":"wrong"}))
                        }
                        "session.name.get" => Some(json!({"name":replies.names.get(id)})),
                        "session.eventLog.tail" => Some(json!({"cursor":"tail"})),
                        "session.eventLog.read" => {
                            continue;
                        }
                        "session.model.getCurrent"
                        | "session.skills.reload"
                        | "session.tools.initializeAndValidate" => Some(json!({})),
                        _ => None,
                    };
                    match result {
                        Some(result) => json!({"jsonrpc":"2.0","id":request["id"],"result":result}),
                        None => {
                            json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32000,"message":format!("native failure: {method}")}})
                        }
                    }
                };
                let bytes = serde_json::to_vec(&response).unwrap();
                let mut writer = server_writer.lock().await;
                if writer
                    .write_all(format!("Content-Length: {}\r\n\r\n", bytes.len()).as_bytes())
                    .await
                    .is_err()
                {
                    break;
                }
                if writer.write_all(&bytes).await.is_err() {
                    break;
                }
            }
        });
        let events = EventBus::new();
        let metadata = ["a", "b"]
            .into_iter()
            .map(|id| {
                (
                    id.into(),
                    StoredSessionMeta {
                        title: Some(format!("Original {id}")),
                        cwd: Some(".".into()),
                        model: Some("model".into()),
                        reasoning_effort: Some("low".into()),
                        context_tier: Some("long_context".into()),
                        pinned: true,
                        folder: Some("Folder".into()),
                        tags: vec!["tag".into()],
                        tool_controls_created: true,
                        tool_controls_managed: true,
                        tool_exclusions: vec!["builtin:blocked".into()],
                        tool_available_tools: Some(vec!["builtin:allowed".into()]),
                        ..StoredSessionMeta::default()
                    },
                )
            })
            .collect();
        let service = Arc::new(SessionService {
            client: RwLock::new(Some(client)),
            accepting_work: AtomicBool::new(true),
            active: RwLock::new(HashMap::new()),
            warmed: RwLock::new(HashSet::new()),
            turn_gates: RwLock::new(HashMap::new()),
            ask_gates: RwLock::new(HashMap::new()),
            last_submissions: RwLock::new(HashMap::new()),
            create_gate: AsyncMutex::new(()),
            runtime_gate: AsyncMutex::new(()),
            lifecycle_gate: RwLock::new(()),
            session_cache: RwLock::new(
                ["a", "b"]
                    .map(|id| SessionSummary {
                        session_id: id.into(),
                        title: format!("Original {id}"),
                        start_time: "start".into(),
                        modified_time: "modified".into(),
                        cwd: Some(".".into()),
                        model: Some("model".into()),
                        is_active: true,
                        is_remote: false,
                        pinned: true,
                        folder: Some("Folder".into()),
                        tags: vec!["tag".into()],
                    })
                    .into(),
            ),
            events: events.clone(),
            approvals: Arc::new(ApprovalBroker {
                events: events.clone(),
                pending: Mutex::new(HashMap::new()),
            }),
            interactions: Arc::new(interactions::InteractionBroker::new(events)),
            tool_state: RwLock::new(HashMap::new()),
            tool_catalog: tool_catalog::ToolCatalog::default(),
            metadata_path: directory.join("metadata.json"),
            metadata: RwLock::new(metadata),
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
        service.persist_metadata().await.unwrap();
        calls.lock().unwrap().clear();
        Self {
            service,
            calls,
            replies,
            writer,
            server,
            directory,
        }
    }

    fn calls(&self, method: &str) -> Vec<Value> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| call["method"] == method)
            .cloned()
            .collect()
    }

    async fn wait_for(&self, method: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if let Some(call) = self.calls(method).first() {
                    return call.clone();
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap()
    }

    async fn respond(&self, id: Value, result: Value) {
        let bytes = serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"result":result})).unwrap();
        let mut writer = self.writer.lock().await;
        writer
            .write_all(format!("Content-Length: {}\r\n\r\n", bytes.len()).as_bytes())
            .await
            .unwrap();
        writer.write_all(&bytes).await.unwrap();
    }
}

fn ask(session: &str, question: &str) -> AskSessionRequest {
    AskSessionRequest {
        session_id: session.into(),
        question: question.into(),
    }
}

#[tokio::test]
async fn session_actions_ask_uses_only_native_query_without_turn_gate_or_history_mutation() {
    let runtime = MockRuntime::new().await;
    let before = std::fs::read(&runtime.service.metadata_path).unwrap();
    runtime.replies.lock().unwrap().processing = true;
    let gate = runtime.service.turn_gate("a").await;
    let _parent_work = gate.lock().await;
    let answer = tokio::time::timeout(
        Duration::from_secs(2),
        runtime.service.ask_session(ask("a", "  why?  ")),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(answer.session_id, "a");
    assert_eq!(answer.answer, "this request's answer");
    let calls = runtime.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["method"], "session.ui.ephemeralQuery");
    assert_eq!(
        calls[0]["params"],
        json!({"sessionId":"a","question":"why?"})
    );
    assert_eq!(
        std::fs::read(&runtime.service.metadata_path).unwrap(),
        before
    );
    assert!(runtime.service.last_submissions.read().await.is_empty());
}

#[tokio::test]
async fn session_actions_ask_rejects_empty_inactive_and_overlapping_but_not_other_session() {
    let runtime = MockRuntime::new().await;
    assert!(runtime.service.ask_session(ask("a", " \n")).await.is_err());
    assert!(
        runtime
            .service
            .ask_session(ask("unknown", "question"))
            .await
            .is_err()
    );
    assert!(runtime.calls.lock().unwrap().is_empty());
    runtime.replies.lock().unwrap().hold_ask = true;
    let service = runtime.service.clone();
    let first = tokio::spawn(async move { service.ask_session(ask("a", "first")).await });
    let call = runtime.wait_for("session.ui.ephemeralQuery").await;
    assert!(
        runtime
            .service
            .ask_session(ask("a", "second"))
            .await
            .is_err()
    );
    assert!(
        runtime
            .service
            .ask_session(ask("b", "different session"))
            .await
            .is_ok()
    );
    assert_eq!(runtime.calls("session.ui.ephemeralQuery").len(), 2);
    runtime
        .respond(call["id"].clone(), json!({"answer":"exact RPC answer"}))
        .await;
    assert_eq!(first.await.unwrap().unwrap().answer, "exact RPC answer");
}

#[tokio::test]
async fn session_actions_caller_cancellation_keeps_query_locked_and_blocks_lifecycle_drain() {
    let runtime = MockRuntime::new().await;
    runtime.replies.lock().unwrap().hold_ask = true;
    let service = runtime.service.clone();
    let caller = tokio::spawn(async move { service.ask_session(ask("a", "wait")).await });
    let call = runtime.wait_for("session.ui.ephemeralQuery").await;
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    assert!(
        runtime
            .service
            .ask_session(ask("a", "steal query"))
            .await
            .is_err()
    );
    assert!(
        tokio::time::timeout(
            Duration::from_millis(30),
            runtime.service.lifecycle_gate.write()
        )
        .await
        .is_err()
    );
    runtime
        .respond(call["id"].clone(), json!({"answer":"finished after close"}))
        .await;
    let _drain = tokio::time::timeout(
        Duration::from_secs(2),
        runtime.service.lifecycle_gate.write(),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn session_actions_ask_malformed_reply_and_drain_do_not_succeed_or_send() {
    let runtime = MockRuntime::new().await;
    runtime.replies.lock().unwrap().ask = json!({"error":"no answer"});
    assert!(
        runtime
            .service
            .ask_session(ask("a", "failure"))
            .await
            .is_err()
    );
    runtime.replies.lock().unwrap().ask = json!({"answer":"retry"});
    assert_eq!(
        runtime
            .service
            .ask_session(ask("a", "retry"))
            .await
            .unwrap()
            .answer,
        "retry"
    );
    runtime
        .service
        .accepting_work
        .store(false, Ordering::Relaxed);
    assert!(matches!(
        runtime.service.ask_session(ask("a", "draining")).await,
        Err(ServiceError::Draining)
    ));
    assert!(runtime.calls("session.send").is_empty());
}

#[tokio::test]
async fn session_actions_fork_uses_native_full_context_and_never_replays_pending_work_or_filters() {
    let runtime = MockRuntime::new().await;
    let parent_meta =
        serde_json::to_value(runtime.service.metadata.read().await.get("a").unwrap()).unwrap();
    let parent_summary =
        serde_json::to_value(&runtime.service.session_cache.read().await[0]).unwrap();
    let fork = runtime
        .service
        .fork_session(ForkSessionRequest {
            session_id: "a".into(),
            name: Some("  New fork  ".into()),
        })
        .await
        .unwrap();
    assert_eq!(fork.session_id, "fork-child");
    assert_eq!(fork.title, "New fork");
    assert!(fork.is_active);
    assert_eq!(
        runtime.calls("sessions.fork")[0]["params"],
        json!({"sessionId":"a","name":"New fork"})
    );
    let resumed = runtime.calls("session.resume");
    assert_eq!(resumed.len(), 1);
    assert_eq!(resumed[0]["params"]["sessionId"], "fork-child");
    assert_eq!(resumed[0]["params"]["continuePendingWork"], false);
    assert!(resumed[0]["params"].get("excludedTools").is_none());
    assert!(resumed[0]["params"].get("availableTools").is_none());
    assert_eq!(resumed[0]["params"]["model"], "model");
    assert_eq!(
        serde_json::to_value(runtime.service.metadata.read().await.get("a").unwrap()).unwrap(),
        parent_meta
    );
    assert_eq!(
        serde_json::to_value(&runtime.service.session_cache.read().await[0]).unwrap(),
        parent_summary
    );
    assert!(runtime.calls("session.send").is_empty());
    assert!(runtime.calls("session.abort").is_empty());
    let stored = load_metadata(&runtime.service.metadata_path);
    assert_eq!(stored["fork-child"].title.as_deref(), Some("New fork"));
    assert!(!stored["fork-child"].tool_controls_created);
    assert!(!stored["fork-child"].tool_controls_managed);
    assert!(stored["fork-child"].prevent_pending_work);
    runtime.service.active.write().await.remove("fork-child");
    runtime
        .service
        .resume_session("fork-child".into())
        .await
        .unwrap();
    assert_eq!(
        runtime.calls("session.resume").last().unwrap()["params"]["continuePendingWork"],
        false
    );
}

#[tokio::test]
async fn session_actions_fork_does_not_deadlock_behind_a_waiting_lifecycle_writer() {
    let runtime = MockRuntime::new().await;
    runtime.replies.lock().unwrap().hold_fork = true;
    let service = runtime.service.clone();
    let fork = tokio::spawn(async move {
        service
            .fork_session(ForkSessionRequest {
                session_id: "a".into(),
                name: None,
            })
            .await
    });
    let call = runtime.wait_for("sessions.fork").await;
    let service = runtime.service.clone();
    let (queued, waiting) = oneshot::channel();
    let lifecycle = tokio::spawn(async move {
        let _ = queued.send(());
        let _writer = service.lifecycle_gate.write().await;
    });
    waiting.await.unwrap();
    tokio::task::yield_now().await;
    runtime
        .respond(call["id"].clone(), json!({"sessionId":"fork-child"}))
        .await;
    let result = tokio::time::timeout(Duration::from_secs(2), fork)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(result.session_id, "fork-child");
    tokio::time::timeout(Duration::from_secs(2), lifecycle)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn session_actions_fork_rejects_busy_invalid_names_and_parent_id_results() {
    let runtime = MockRuntime::new().await;
    runtime.replies.lock().unwrap().processing = true;
    assert!(matches!(
        runtime
            .service
            .fork_session(ForkSessionRequest {
                session_id: "a".into(),
                name: None
            })
            .await,
        Err(ServiceError::SessionProcessing(_))
    ));
    assert!(runtime.calls("sessions.fork").is_empty());
    runtime.replies.lock().unwrap().processing = false;
    assert!(
        runtime
            .service
            .fork_session(ForkSessionRequest {
                session_id: "a".into(),
                name: Some(" ".into())
            })
            .await
            .is_err()
    );
    runtime.replies.lock().unwrap().fork = json!({"sessionId":"a"});
    assert!(
        runtime
            .service
            .fork_session(ForkSessionRequest {
                session_id: "a".into(),
                name: None
            })
            .await
            .is_err()
    );
    assert!(runtime.calls("session.resume").is_empty());
    assert_eq!(
        runtime.service.metadata.read().await["a"].title.as_deref(),
        Some("Original a")
    );
    runtime.replies.lock().unwrap().fork = json!({"sessionId":"b"});
    assert!(
        runtime
            .service
            .fork_session(ForkSessionRequest {
                session_id: "a".into(),
                name: None
            })
            .await
            .is_err()
    );
    assert_eq!(
        runtime.service.metadata.read().await["b"].title.as_deref(),
        Some("Original b")
    );
    runtime.replies.lock().unwrap().fork = json!({"name":"missing id"});
    assert!(
        runtime
            .service
            .fork_session(ForkSessionRequest {
                session_id: "a".into(),
                name: None
            })
            .await
            .is_err()
    );
    assert!(runtime.calls("session.resume").is_empty());
}

#[tokio::test]
async fn session_actions_rename_native_readback_cache_and_metadata_preserve_other_fields() {
    let runtime = MockRuntime::new().await;
    let mut before =
        serde_json::to_value(runtime.service.metadata.read().await.get("a").unwrap()).unwrap();
    let name = "A title; $(not a shell command)";
    let renamed = runtime
        .service
        .rename_session(RenameSessionRequest {
            session_id: "a".into(),
            name: format!("  {name}  "),
        })
        .await
        .unwrap();
    assert_eq!(renamed.title, name);
    assert!(renamed.pinned);
    assert_eq!(renamed.folder.as_deref(), Some("Folder"));
    assert_eq!(renamed.tags, vec!["tag"]);
    assert_eq!(
        runtime.calls("session.name.set")[0]["params"],
        json!({"sessionId":"a","name":name})
    );
    assert_eq!(
        runtime.calls("session.name.get")[0]["params"],
        json!({"sessionId":"a"})
    );
    assert_eq!(runtime.service.session_cache.read().await[0].title, name);
    before["title"] = json!(name);
    assert_eq!(
        serde_json::to_value(&load_metadata(&runtime.service.metadata_path)["a"]).unwrap(),
        before
    );
    assert!(runtime.calls("session.send").is_empty());
    assert!(runtime.calls("session.commands.invoke").is_empty());
}

#[tokio::test]
async fn session_actions_rename_failed_native_and_validation_never_report_local_success() {
    let runtime = MockRuntime::new().await;
    let original = std::fs::read(&runtime.service.metadata_path).unwrap();
    for name in [
        "".into(),
        " ".into(),
        "a\nb".into(),
        "x".repeat(101),
        "😀".repeat(51),
    ] {
        assert!(
            runtime
                .service
                .rename_session(RenameSessionRequest {
                    session_id: "a".into(),
                    name
                })
                .await
                .is_err()
        );
    }
    assert!(runtime.calls.lock().unwrap().is_empty());
    runtime.replies.lock().unwrap().fail_name_set = true;
    assert!(
        runtime
            .service
            .rename_session(RenameSessionRequest {
                session_id: "a".into(),
                name: "failed".into()
            })
            .await
            .is_err()
    );
    runtime.replies.lock().unwrap().fail_name_set = false;
    runtime.replies.lock().unwrap().mismatch_name = true;
    assert!(
        runtime
            .service
            .rename_session(RenameSessionRequest {
                session_id: "a".into(),
                name: "mismatch".into()
            })
            .await
            .is_err()
    );
    assert_eq!(
        runtime.service.session_cache.read().await[0].title,
        "Original a"
    );
    assert_eq!(
        std::fs::read(&runtime.service.metadata_path).unwrap(),
        original
    );
}
