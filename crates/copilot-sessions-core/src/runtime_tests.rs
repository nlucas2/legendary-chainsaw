//! Mock JSON-RPC and isolated project-local app metadata; no real SDK sessions.
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use github_copilot_sdk::Client;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{Mutex as AsyncMutex, RwLock};

use crate::*;

struct MockRuntime {
    service: Arc<SessionService>,
    calls: Arc<Mutex<Vec<Value>>>,
    task: tokio::task::JoinHandle<()>,
    writer: Arc<AsyncMutex<tokio::io::WriteHalf<tokio::io::DuplexStream>>>,
    metadata_dir: PathBuf,
    processing: Arc<AtomicBool>,
    future_tool: Arc<AtomicBool>,
    missing_metadata: Arc<AtomicBool>,
}

impl MockRuntime {
    async fn inject(&self, value: Value) {
        let bytes = serde_json::to_vec(&value).unwrap();
        let mut writer = self.writer.lock().await;
        writer
            .write_all(format!("Content-Length: {}\r\n\r\n", bytes.len()).as_bytes())
            .await
            .unwrap();
        writer.write_all(&bytes).await.unwrap();
    }
}

impl Drop for MockRuntime {
    fn drop(&mut self) {
        self.task.abort();
        let _ = std::fs::remove_dir_all(&self.metadata_dir);
    }
}

fn mock_runtime() -> MockRuntime {
    mock_runtime_with_mcp(false)
}

fn mock_runtime_with_mcp(mcp: bool) -> MockRuntime {
    static NEXT_TEST: AtomicU64 = AtomicU64::new(1);
    let metadata_dir = PathBuf::from("target")
        .join("parity-test-state")
        .join(format!(
            "{}-{}",
            std::process::id(),
            NEXT_TEST.fetch_add(1, Ordering::Relaxed)
        ));
    std::fs::create_dir_all(&metadata_dir).unwrap();
    let (transport, server) = tokio::io::duplex(65536);
    let (read, write) = tokio::io::split(transport);
    let client = Client::from_streams(read, write, PathBuf::from(".")).unwrap();
    let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
    let recorded = calls.clone();
    let (read, write) = tokio::io::split(server);
    let writer = Arc::new(AsyncMutex::new(write));
    let server_writer = writer.clone();
    let processing = Arc::new(AtomicBool::new(true));
    let runtime_processing = processing.clone();
    let future_tool = Arc::new(AtomicBool::new(false));
    let runtime_future_tool = future_tool.clone();
    let missing_metadata = Arc::new(AtomicBool::new(false));
    let runtime_missing_metadata = missing_metadata.clone();
    let task = tokio::spawn(async move {
        let mut read = BufReader::new(read);
        let mut modes = HashMap::<String, Value>::new();
        let mut excluded = HashMap::<String, Vec<Value>>::new();
        let mut available = HashMap::<String, Vec<Value>>::new();
        loop {
            let mut header = String::new();
            if read.read_line(&mut header).await.unwrap_or(0) == 0 {
                break;
            }
            let Some(size) = header
                .trim()
                .strip_prefix("Content-Length: ")
                .and_then(|n| n.parse::<usize>().ok())
            else {
                break;
            };
            let mut blank = String::new();
            read.read_line(&mut blank).await.unwrap();
            let mut bytes = vec![0; size];
            read.read_exact(&mut bytes).await.unwrap();
            let request: Value = serde_json::from_slice(&bytes).unwrap();
            recorded.lock().unwrap().push(request.clone());
            if request.get("method").is_none() {
                continue;
            }
            let method = request["method"].as_str().unwrap_or("");
            let sid = request["params"]["sessionId"].as_str().unwrap_or("");
            let result = match method {
                "session.list" => json!({"sessions":[]}),
                "session.create" => {
                    excluded.insert(
                        sid.into(),
                        request["params"]["excludedTools"]
                            .as_array()
                            .cloned()
                            .unwrap_or_default(),
                    );
                    json!({"sessionId":sid})
                }
                "session.resume" => {
                    if let Some(values) = request["params"]["excludedTools"].as_array() {
                        excluded.insert(sid.into(), values.clone());
                    }
                    if let Some(values) = request["params"]["availableTools"].as_array() {
                        available.insert(sid.into(), values.clone());
                    }
                    json!({"sessionId":sid})
                }
                "session.skills.reload" | "session.tools.initializeAndValidate" => json!({}),
                "session.model.getCurrent" => json!({}),
                "session.eventLog.tail" => json!({"cursor":"tail"}),
                "session.eventLog.read" => {
                    // Keep the existing long-poll loop from spinning in tests.
                    if request["params"]["waitMs"].is_number() {
                        tokio::time::sleep(Duration::from_millis(2)).await;
                    }
                    json!({"cursor":"tail","events":[],"hasMore":false})
                }
                "session.metadata.isProcessing" => {
                    json!({"processing":runtime_processing.load(Ordering::Relaxed)})
                }
                "session.mode.get" => modes.get(sid).cloned().unwrap_or(json!("interactive")),
                "session.mode.set" if request["params"]["mode"] == "plan" => {
                    json!({"status":"confirmation_required","modelChanged":false,
                        "confirmation":{"currentTokens":2000,"targetModelDisplayName":"plan-model","targetLimit":1000}})
                }
                "session.mode.set" => {
                    modes.insert(sid.into(), request["params"]["mode"].clone());
                    json!({"status":"success","modelChanged":false,"deferImplementation":true,"armInteractiveContinuation":true,"message":"native update"})
                }
                "session.send" => json!({"messageId":"accepted-without-reply"}),
                "session.tools.getCurrentMetadata"
                    if runtime_missing_metadata.load(Ordering::Relaxed) =>
                {
                    json!({})
                }
                "session.tools.getCurrentMetadata" => {
                    let candidates = [
                        ("powershell", true, false),
                        ("deferred_tool", true, true),
                        (
                            "future_tool",
                            runtime_future_tool.load(Ordering::Relaxed),
                            false,
                        ),
                    ];
                    let tools = candidates.into_iter().filter(|(name, exists, _)| {
                        let id = json!(format!("builtin:{name}"));
                        *exists && available.get(sid).is_none_or(|values| values.contains(&id))
                            && !excluded.get(sid).is_some_and(|values| values.contains(&id))
                    }).map(|(name, _, deferred)| json!({"name":name,"description":"Runtime tool","deferLoading":deferred})).collect::<Vec<_>>();
                    json!({"tools":tools})
                }
                "tools.list" => {
                    json!({"tools":[{"name":"powershell","description":"Shell"},{"name":"unused","description":"Not offered"},{"name":"deferred_tool","description":"Deferred"},{"name":"future_tool","description":"Future tool"}]})
                }
                "session.mcp.list" if mcp => json!({"servers":[
                    {"name":"fast","status":"connected"}, {"name":"slow","status":"connected"},
                ]}),
                "session.mcp.list" => json!({"servers":[]}),
                "session.mcp.listTools" if request["params"]["serverName"] == "slow" => {
                    // Leave only this RPC pending; unrelated runtime calls keep working.
                    continue;
                }
                "session.mcp.listTools" => {
                    json!({"tools":[{"name":"lookup","description":"Fast catalog"}]})
                }
                "session.metadata.snapshot" => {
                    json!({"sessionId":sid,"workingDirectory":".","modifiedTime":"2026-09-04T23:00:00Z"})
                }
                "session.options.update" => {
                    if let Some(values) = request["params"]["excludedTools"].as_array() {
                        excluded.insert(sid.into(), values.clone());
                    }
                    if let Some(values) = request["params"]["availableTools"].as_array() {
                        available.insert(sid.into(), values.clone());
                    }
                    json!({"success":true})
                }
                _ => {
                    let error = json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32601,"message":format!("Unexpected method {method}")}});
                    let bytes = serde_json::to_vec(&error).unwrap();
                    let frame = format!("Content-Length: {}\r\n\r\n", bytes.len());
                    let mut write = server_writer.lock().await;
                    if write.write_all(frame.as_bytes()).await.is_err() {
                        break;
                    }
                    if write.write_all(&bytes).await.is_err() {
                        break;
                    }
                    continue;
                }
            };
            let response =
                serde_json::to_vec(&json!({"jsonrpc":"2.0","id":request["id"],"result":result}))
                    .unwrap();
            let frame = format!("Content-Length: {}\r\n\r\n", response.len());
            let mut write = server_writer.lock().await;
            if write.write_all(frame.as_bytes()).await.is_err() {
                break;
            }
            if write.write_all(&response).await.is_err() {
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
                    title: id.into(),
                    start_time: String::new(),
                    modified_time: String::new(),
                    cwd: None,
                    model: None,
                    is_active: false,
                    is_remote: false,
                    pinned: false,
                    archived: false,
                    folder: None,
                    tags: vec![],
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
        metadata_path: metadata_dir.join("sessions.json"),
        metadata: RwLock::new(HashMap::from([(
            "a".into(),
            StoredSessionMeta {
                tool_exclusions: vec!["builtin:secret*".into()],
                tool_controls_managed: true,
                tool_controls_created: true,
                ..Default::default()
            },
        )])),
        metadata_write_gate: AsyncMutex::new(()),
    });
    MockRuntime {
        service,
        calls,
        task,
        writer,
        metadata_dir,
        processing,
        future_tool,
        missing_metadata,
    }
}

async fn catalog_requests(runtime: &MockRuntime, count: usize) -> Vec<Value> {
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let requests = runtime
                .calls
                .lock()
                .unwrap()
                .iter()
                .filter(|call| call["method"] == "session.mcp.listTools")
                .cloned()
                .collect::<Vec<_>>();
            if requests.len() >= count {
                return requests;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("catalog discovery did not start")
}

#[tokio::test]
async fn tool_catalog_never_blocks_controls_and_is_shared_across_readers() {
    let runtime = mock_runtime_with_mcp(true);
    runtime.service.resume_session("a".into()).await.unwrap();
    let first = tokio::time::timeout(
        Duration::from_millis(250),
        runtime.service.tool_controls("a"),
    )
    .await
    .expect("live tools waited for optional MCP catalogs")
    .unwrap();
    assert!(first.inventory_loading);
    assert!(
        first
            .tools
            .iter()
            .any(|tool| tool.id == "builtin:powershell" && tool.enabled)
    );
    let requests = catalog_requests(&runtime, 2).await;
    for _ in 0..3 {
        let controls = runtime.service.tool_controls("a").await.unwrap();
        assert!(controls.inventory_loading);
    }
    assert_eq!(catalog_requests(&runtime, 2).await.len(), 2);
    let slow = requests
        .iter()
        .find(|call| call["params"]["serverName"] == "slow")
        .unwrap();
    runtime
        .inject(
            json!({"jsonrpc":"2.0","id":slow["id"],"result":{"tools":[{"name":"slow_lookup"}]}}),
        )
        .await;
    let completed = tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let controls = runtime.service.tool_controls("a").await.unwrap();
            if !controls.inventory_loading {
                break controls;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    assert!(
        completed
            .tools
            .iter()
            .any(|tool| tool.id == "mcp:fast-lookup" && !tool.enabled)
    );
    assert!(
        completed
            .tools
            .iter()
            .any(|tool| tool.id == "mcp:slow-slow_lookup" && !tool.enabled)
    );
    assert!(runtime.service.events.state.lock().unwrap().history.iter().any(|event|
        matches!(&event.event, AppEvent::ToolInventoryUpdated { session_id } if session_id == "a")));
    assert_eq!(catalog_requests(&runtime, 2).await.len(), 2);
}

#[tokio::test]
async fn invalidated_tool_catalog_rejects_late_results_from_old_discovery() {
    let runtime = mock_runtime_with_mcp(true);
    runtime.service.resume_session("a".into()).await.unwrap();
    runtime.service.tool_controls("a").await.unwrap();
    let original = catalog_requests(&runtime, 2).await;
    runtime.service.refresh_tool_inventory("a").await.unwrap();
    let all = catalog_requests(&runtime, 4).await;
    let old = original
        .iter()
        .find(|call| call["params"]["serverName"] == "slow")
        .unwrap();
    let new = all
        .iter()
        .rev()
        .find(|call| call["params"]["serverName"] == "slow")
        .unwrap();
    runtime
        .inject(json!({"jsonrpc":"2.0","id":old["id"],"result":{"tools":[{"name":"stale"}]}}))
        .await;
    runtime
        .inject(json!({"jsonrpc":"2.0","id":new["id"],"result":{"tools":[{"name":"fresh"}]}}))
        .await;
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let controls = runtime.service.tool_controls("a").await.unwrap();
            assert!(
                !controls
                    .tools
                    .iter()
                    .any(|tool| tool.id == "mcp:slow-stale")
            );
            if !controls.inventory_loading {
                assert!(
                    controls
                        .tools
                        .iter()
                        .any(|tool| tool.id == "mcp:slow-fresh")
                );
                break;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn optional_catalog_timeout_keeps_tools_usable_and_does_not_retry_every_read() {
    let runtime = mock_runtime_with_mcp(true);
    runtime.service.resume_session("a".into()).await.unwrap();
    runtime.service.tool_controls("a").await.unwrap();
    catalog_requests(&runtime, 2).await;
    tokio::time::sleep(Duration::from_millis(5100)).await;
    let controls = runtime.service.tool_controls("a").await.unwrap();
    assert!(!controls.inventory_loading);
    assert!(
        controls
            .warnings
            .iter()
            .any(|warning| warning.contains("slow") && warning.contains("timed out"))
    );
    assert!(
        controls
            .tools
            .iter()
            .any(|tool| tool.id == "builtin:powershell" && tool.enabled)
    );
    assert_eq!(catalog_requests(&runtime, 2).await.len(), 2);
}

#[tokio::test]
async fn missing_tool_metadata_keeps_catalog_readable_and_initializes_once_without_filter_writes() {
    let runtime = mock_runtime();
    runtime.service.resume_session("a".into()).await.unwrap();
    runtime.calls.lock().unwrap().clear();
    runtime.missing_metadata.store(true, Ordering::Relaxed);
    let controls = runtime.service.tool_controls("a").await.unwrap();
    assert!(!controls.metadata_available);
    assert!(!controls.can_edit_tools);
    assert!(controls.metadata_loading);
    assert!(!controls.tools.is_empty());
    for _ in 0..3 {
        runtime.service.tool_controls("a").await.unwrap();
    }
    let requests = runtime.calls.lock().unwrap().clone();
    assert_eq!(
        requests
            .iter()
            .filter(|call| call["method"] == "session.tools.initializeAndValidate")
            .count(),
        1
    );
    assert!(
        !requests
            .iter()
            .any(|call| call["method"] == "session.options.update")
    );
    assert!(
        runtime
            .service
            .set_tool_enabled(SetToolEnabled {
                session_id: "a".into(),
                tool_id: "builtin:powershell".into(),
                enabled: false,
            })
            .await
            .is_err()
    );
    runtime.missing_metadata.store(false, Ordering::Relaxed);
    let controls = runtime.service.tool_controls("a").await.unwrap();
    assert!(controls.metadata_available);
    assert!(controls.can_edit_tools);
}

#[tokio::test]
async fn newly_created_sessions_have_editable_known_app_defaults() {
    let runtime = mock_runtime();
    let session = runtime
        .service
        .create_session(NewSession {
            cwd: ".".into(),
            model: None,
            reasoning_effort: None,
            reasoning_summary: None,
            context_tier: None,
        })
        .await
        .unwrap();
    assert!(!session.archived);
    assert!(!load_metadata(&runtime.service.metadata_path)[&session.session_id].archived);
    let controls = runtime
        .service
        .tool_controls(&session.session_id)
        .await
        .unwrap();
    assert!(controls.can_edit_tools);
    assert!(!controls.requires_adoption);
    assert!(controls.available_tools.is_none());
    assert!(controls.excluded_tools.is_empty());
    let disabled = runtime
        .service
        .set_tool_enabled(SetToolEnabled {
            session_id: session.session_id.clone(),
            tool_id: "builtin:powershell".into(),
            enabled: false,
        })
        .await
        .unwrap();
    assert!(
        !disabled
            .tools
            .iter()
            .find(|tool| tool.id == "builtin:powershell")
            .unwrap()
            .enabled
    );
    let enabled = runtime
        .service
        .set_tool_enabled(SetToolEnabled {
            session_id: session.session_id,
            tool_id: "builtin:powershell".into(),
            enabled: true,
        })
        .await
        .unwrap();
    assert!(
        enabled
            .tools
            .iter()
            .find(|tool| tool.id == "builtin:powershell")
            .unwrap()
            .enabled
    );
    let calls = runtime.calls.lock().unwrap();
    let create = calls
        .iter()
        .find(|call| call["method"] == "session.create")
        .unwrap();
    assert_eq!(create["params"]["excludedTools"], json!([]));
    assert!(create["params"].get("availableTools").is_none());
}

#[tokio::test]
async fn resume_preserves_known_cwd_and_name_before_native_session_index_catches_up() {
    let runtime = mock_runtime();
    runtime.service.session_cache.write().await.clear();
    {
        let mut metadata = runtime.service.metadata.write().await;
        let meta = metadata.get_mut("a").unwrap();
        meta.cwd = Some(".".into());
        meta.title = Some("Unindexed workspace".into());
        meta.model = Some("selected-model".into());
        meta.archived = true;
    }
    let summary = runtime.service.resume_session("a".into()).await.unwrap();
    assert_eq!(summary.cwd.as_deref(), Some("."));
    assert_eq!(summary.title, "Unindexed workspace");
    assert_eq!(summary.model.as_deref(), Some("selected-model"));
    assert!(summary.archived);
}

#[tokio::test]
async fn concurrent_session_creation_is_rejected_before_reaching_the_runtime() {
    let runtime = mock_runtime();
    let _creating = runtime.service.create_gate.lock().await;
    let error = runtime
        .service
        .create_session(NewSession {
            cwd: ".".into(),
            model: None,
            reasoning_effort: None,
            reasoning_summary: None,
            context_tier: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(error, ServiceError::SessionProcessing(ref id) if id == "creation"));
    assert!(
        !runtime
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|call| call["method"] == "session.create")
    );
}

#[tokio::test]
async fn unknown_sessions_require_explicit_bounded_adoption_and_future_tool_opt_in() {
    let runtime = mock_runtime();
    runtime.service.resume_session("b".into()).await.unwrap();
    let unknown = runtime.service.tool_controls("b").await.unwrap();
    assert!(!unknown.can_edit_tools);
    assert!(unknown.requires_adoption);
    assert_eq!(unknown.filter_ownership, "unknown");
    assert!(matches!(
        runtime
            .service
            .set_tool_enabled(SetToolEnabled {
                session_id: "b".into(),
                tool_id: "builtin:powershell".into(),
                enabled: false,
            })
            .await,
        Err(ServiceError::CapabilityUnavailable(_))
    ));
    assert!(matches!(
        runtime
            .service
            .adopt_tool_controls(AdoptToolControls {
                session_id: "b".into(),
            })
            .await,
        Err(ServiceError::SessionProcessing(_))
    ));
    {
        let calls = runtime.calls.lock().unwrap();
        let resume = calls
            .iter()
            .find(|call| call["method"] == "session.resume")
            .unwrap();
        assert!(resume["params"].get("availableTools").is_none());
        assert!(resume["params"].get("excludedTools").is_none());
        assert!(
            !calls
                .iter()
                .any(|call| call["method"] == "session.options.update")
        );
    }
    runtime.processing.store(false, Ordering::Relaxed);
    let adopted = runtime
        .service
        .adopt_tool_controls(AdoptToolControls {
            session_id: "b".into(),
        })
        .await
        .unwrap();
    assert!(adopted.can_edit_tools);
    assert!(!adopted.requires_adoption);
    assert_eq!(
        adopted.available_tools,
        Some(vec![
            "builtin:deferred_tool".into(),
            "builtin:powershell".into()
        ])
    );
    assert!(adopted.excluded_tools.is_empty());
    assert_eq!(
        adopted
            .tools
            .iter()
            .find(|tool| tool.id == "builtin:deferred_tool")
            .unwrap()
            .deferred,
        Some(true)
    );
    let persisted = load_metadata(&runtime.service.metadata_path);
    assert!(persisted["b"].tool_controls_managed);
    let restored = mock_runtime();
    *restored.service.metadata.write().await = persisted;
    restored.future_tool.store(true, Ordering::Relaxed);
    restored.service.resume_session("b".into()).await.unwrap();
    let after_reattach = restored.service.tool_controls("b").await.unwrap();
    assert!(!after_reattach.can_edit_tools);
    assert!(after_reattach.requires_adoption);
    {
        let calls = restored.calls.lock().unwrap();
        let resume = calls
            .iter()
            .find(|call| call["method"] == "session.resume")
            .unwrap();
        assert!(resume["params"].get("availableTools").is_none());
        assert!(resume["params"].get("excludedTools").is_none());
        assert!(
            !calls
                .iter()
                .any(|call| call["method"] == "session.options.update")
        );
    }

    runtime.future_tool.store(true, Ordering::Relaxed);
    assert!(
        !runtime
            .service
            .tool_controls("b")
            .await
            .unwrap()
            .tools
            .iter()
            .find(|tool| tool.id == "builtin:future_tool")
            .unwrap()
            .enabled
    );
    let expanded = runtime
        .service
        .set_tool_enabled(SetToolEnabled {
            session_id: "b".into(),
            tool_id: "builtin:future_tool".into(),
            enabled: true,
        })
        .await
        .unwrap();
    assert!(
        expanded
            .tools
            .iter()
            .find(|tool| tool.id == "builtin:future_tool")
            .unwrap()
            .enabled
    );
    runtime
        .service
        .set_tool_enabled(SetToolEnabled {
            session_id: "b".into(),
            tool_id: "builtin:powershell".into(),
            enabled: false,
        })
        .await
        .unwrap();
    let repeated = runtime
        .service
        .adopt_tool_controls(AdoptToolControls {
            session_id: "b".into(),
        })
        .await
        .unwrap();
    assert_eq!(repeated.excluded_tools, ["builtin:powershell"]);
}

#[tokio::test]
async fn adopted_edits_never_replace_native_exclusions_or_reenable_other_blocked_tools() {
    let runtime = mock_runtime();
    runtime.processing.store(false, Ordering::Relaxed);
    runtime.service.resume_session("b".into()).await.unwrap();
    runtime
        .service
        .adopt_tool_controls(AdoptToolControls {
            session_id: "b".into(),
        })
        .await
        .unwrap();
    // Simulate another actor tightening both filter arrays after consent.
    runtime
        .service
        .client()
        .await
        .unwrap()
        .call(
            "session.options.update",
            Some(json!({
                "sessionId":"b", "availableTools":["builtin:deferred_tool"],
                "excludedTools":["builtin:powershell"], "toolFilterPrecedence":"excluded"
            })),
        )
        .await
        .unwrap();
    runtime.future_tool.store(true, Ordering::Relaxed);
    let future = runtime
        .service
        .set_tool_enabled(SetToolEnabled {
            session_id: "b".into(),
            tool_id: "builtin:future_tool".into(),
            enabled: true,
        })
        .await
        .unwrap();
    assert!(
        future
            .tools
            .iter()
            .find(|tool| tool.id == "builtin:future_tool")
            .unwrap()
            .enabled
    );
    assert!(
        !future
            .tools
            .iter()
            .find(|tool| tool.id == "builtin:powershell")
            .unwrap()
            .enabled
    );
    let blocked = runtime
        .service
        .set_tool_enabled(SetToolEnabled {
            session_id: "b".into(),
            tool_id: "builtin:powershell".into(),
            enabled: true,
        })
        .await
        .unwrap();
    assert!(
        !blocked
            .tools
            .iter()
            .find(|tool| tool.id == "builtin:powershell")
            .unwrap()
            .enabled
    );
    assert!(
        blocked
            .warnings
            .iter()
            .any(|warning| warning.contains("not offered"))
    );
    let calls = runtime.calls.lock().unwrap();
    let updates = calls
        .iter()
        .filter(|call| call["method"] == "session.options.update")
        .collect::<Vec<_>>();
    assert_eq!(updates.len(), 4); // adoption, external update, two explicit edits
    for update in &updates[2..] {
        assert!(update["params"].get("excludedTools").is_none());
        assert_eq!(update["params"]["toolFilterPrecedence"], "excluded");
    }
    assert_eq!(
        updates[2]["params"]["availableTools"],
        json!(["builtin:deferred_tool", "builtin:future_tool"])
    );
}

#[tokio::test]
async fn service_state_directory_also_scopes_terminal_checkpoints() {
    let mut runtime = mock_runtime();
    let service = Arc::get_mut(&mut runtime.service).unwrap();
    service.metadata_path = PathBuf::from("test-state")
        .join("disposable-daemon")
        .join("sessions.json");
    assert_eq!(
        service.data_dir().join("terminals.json"),
        PathBuf::from("test-state")
            .join("disposable-daemon")
            .join("terminals.json")
    );
}

#[tokio::test]
async fn concurrent_resume_warms_once_and_refresh_never_recycles_other_sessions() {
    let runtime = mock_runtime();
    let service = &runtime.service;
    let (first, second) = tokio::join!(
        service.resume_session("a".into()),
        service.resume_session("a".into())
    );
    first.unwrap();
    second.unwrap();
    service.resume_session("b".into()).await.unwrap();
    let a = service.session("a").await.unwrap();
    let b = service.session("b").await.unwrap();
    let refreshed = service.refresh_session("a".into()).await.unwrap();
    assert!(!refreshed.runtime_recycled);
    assert!(Arc::ptr_eq(&a, &service.session("a").await.unwrap()));
    assert!(Arc::ptr_eq(&b, &service.session("b").await.unwrap()));
    assert!(service.runtime_status().await.accepting_work);
    let calls = runtime.calls.lock().unwrap();
    for method in [
        "session.resume",
        "session.tools.initializeAndValidate",
        "session.eventLog.tail",
    ] {
        assert_eq!(
            calls
                .iter()
                .filter(
                    |request| request["method"] == method && request["params"]["sessionId"] == "a"
                )
                .count(),
            1,
            "{method} must be singleflight"
        );
    }
    assert!(!calls.iter().any(|request| matches!(
        request["method"].as_str(),
        Some("runtime.shutdown" | "session.shutdown" | "session.disconnect")
    )));
    let resume = calls
        .iter()
        .find(|request| request["method"] == "session.resume")
        .unwrap();
    for handler in [
        "requestPermission",
        "requestUserInput",
        "requestElicitation",
        "requestExitPlanMode",
        "requestAutoModeSwitch",
    ] {
        assert_eq!(
            resume["params"][handler], true,
            "native {handler} registration"
        );
    }
    assert!(
        !calls
            .iter()
            .any(|request| request["method"] == "session.events.registerInterest")
    );
}

#[tokio::test]
async fn send_returns_acceptance_without_waiting_for_model_output() {
    let runtime = mock_runtime();
    runtime.service.resume_session("a".into()).await.unwrap();
    let request = serde_json::from_value(json!({"sessionId":"a","content":"hi","deliveryMode":"immediate","attachments":[{"type":"blob","data":"aGk=","mimeType":"text/plain"}]})).unwrap();
    let accepted = tokio::time::timeout(
        Duration::from_secs(1),
        runtime.service.submit_message(request),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(accepted, "accepted-without-reply");
    let calls = runtime.calls.lock().unwrap();
    let send = calls
        .iter()
        .find(|request| request["method"] == "session.send")
        .unwrap();
    assert_eq!(send["params"]["mode"], "immediate");
    assert_eq!(send["params"]["attachments"][0]["type"], "blob");
    assert!(send["params"].get("agentMode").is_none());
    assert!(
        !calls
            .iter()
            .any(|request| request["method"] == "session.mode.set")
    );
}

#[tokio::test]
async fn mode_confirmation_is_not_accepted_and_effective_mode_stays_authoritative() {
    let runtime = mock_runtime();
    runtime.service.resume_session("a".into()).await.unwrap();
    let result = runtime
        .service
        .set_session_mode(serde_json::from_value(json!({"sessionId":"a","mode":"plan"})).unwrap())
        .await
        .unwrap();
    assert_eq!(result.result.status, "confirmation_required");
    assert!(result.result.confirmation.is_some());
    assert!(
        result
            .result
            .message
            .as_deref()
            .unwrap()
            .contains("No decision was submitted")
    );
    assert!(result.result.warning.is_some());
    assert_eq!(result.effective_mode, AgentMode::Interactive);
    let state = runtime.service.session_state("a").await.unwrap();
    assert!(state.processing);
    assert_eq!(state.mode, AgentMode::Interactive);
    let calls = runtime.calls.lock().unwrap();
    let sets: Vec<_> = calls
        .iter()
        .filter(|request| request["method"] == "session.mode.set")
        .collect();
    assert_eq!(sets.len(), 1);
    assert!(sets[0]["params"].get("compactionDecision").is_none());
    assert_eq!(sets[0]["params"]["persistPlanSelection"], false);
}

#[tokio::test]
async fn unsupported_compaction_decisions_are_explicit_and_never_submitted() {
    let runtime = mock_runtime();
    runtime.service.resume_session("a".into()).await.unwrap();
    let result = runtime
        .service
        .set_session_mode(
            serde_json::from_value(json!({
                "sessionId":"a", "mode":"plan", "compactionDecision":"unverified"
            }))
            .unwrap(),
        )
        .await;
    assert!(matches!(
        result,
        Err(ServiceError::CapabilityUnavailable(_))
    ));
    assert!(
        !runtime
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|request| request["method"] == "session.mode.set")
    );
}

#[tokio::test]
async fn tool_changes_persist_app_exclusions_and_never_patch_the_allowlist() {
    let runtime = mock_runtime();
    runtime.service.resume_session("a".into()).await.unwrap();
    let result = runtime
        .service
        .set_tool_enabled(SetToolEnabled {
            session_id: "a".into(),
            tool_id: "builtin:powershell".into(),
            enabled: false,
        })
        .await
        .unwrap();
    assert_eq!(
        result.excluded_tools,
        ["builtin:secret*", "builtin:powershell"]
    );
    assert!(
        !result
            .tools
            .iter()
            .find(|tool| tool.id == "builtin:powershell")
            .unwrap()
            .enabled
    );
    assert!(
        !result
            .tools
            .iter()
            .find(|tool| tool.id == "builtin:unused")
            .unwrap()
            .enabled
    );
    let calls = runtime.calls.lock().unwrap();
    let update = calls
        .iter()
        .find(|request| request["method"] == "session.options.update")
        .unwrap();
    assert_eq!(update["params"]["toolFilterPrecedence"], "excluded");
    assert!(update["params"].get("availableTools").is_none());
    assert_eq!(
        update["params"]["excludedTools"],
        json!(["builtin:secret*", "builtin:powershell"])
    );
    assert!(
        !calls
            .iter()
            .any(|request| request["method"] == "session.metadata.snapshot")
    );
    assert!(
        !calls
            .iter()
            .filter(|request| request["method"] == "session.resume")
            .any(|request| request["params"].get("availableTools").is_some())
    );
    drop(calls);
    let persisted = load_metadata(&runtime.service.metadata_path);
    assert_eq!(
        persisted["a"].tool_exclusions,
        ["builtin:secret*", "builtin:powershell"]
    );
    let restarted = mock_runtime();
    *restarted.service.metadata.write().await = persisted;
    restarted.service.resume_session("a".into()).await.unwrap();
    let controls = restarted.service.tool_controls("a").await.unwrap();
    assert_eq!(
        controls.excluded_tools,
        ["builtin:secret*", "builtin:powershell"]
    );
    assert_eq!(controls.filter_ownership, "app");
    assert!(controls.can_edit_tools);
    assert!(!controls.filter_state_known);
    assert!(controls.available_tools.is_none());
    assert!(
        !controls
            .tools
            .iter()
            .find(|tool| tool.id == "builtin:powershell")
            .unwrap()
            .enabled
    );
}

#[tokio::test]
async fn removing_app_exclusion_does_not_claim_external_tool_availability() {
    let runtime = mock_runtime();
    runtime.service.resume_session("a".into()).await.unwrap();
    runtime
        .service
        .set_tool_enabled(SetToolEnabled {
            session_id: "a".into(),
            tool_id: "builtin:unused".into(),
            enabled: false,
        })
        .await
        .unwrap();
    let controls = runtime
        .service
        .set_tool_enabled(SetToolEnabled {
            session_id: "a".into(),
            tool_id: "builtin:unused".into(),
            enabled: true,
        })
        .await
        .unwrap();
    assert!(!controls.excluded_tools.contains(&"builtin:unused".into()));
    assert!(
        !controls
            .tools
            .iter()
            .find(|tool| tool.id == "builtin:unused")
            .unwrap()
            .enabled
    );
    assert!(
        controls
            .warnings
            .iter()
            .any(|warning| warning.contains("is not offered"))
    );
}

#[tokio::test]
async fn unresolved_mode_followups_preserve_native_status_without_starting_work() {
    let runtime = mock_runtime();
    runtime.service.resume_session("a".into()).await.unwrap();
    let result = runtime
        .service
        .set_session_mode(
            serde_json::from_value(json!({"sessionId":"a","mode":"autopilot"})).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(result.result.status, "success");
    assert_eq!(result.effective_mode, AgentMode::Autopilot);
    assert_eq!(result.result.defer_implementation, Some(true));
    assert_eq!(result.result.arm_interactive_continuation, Some(true));
    assert_eq!(
        result.pending_post_actions,
        ["defer_implementation", "arm_interactive_continuation"]
    );
    assert!(result.result.message.unwrap().contains("no continuation"));
    let calls = runtime.calls.lock().unwrap();
    assert!(!calls.iter().any(|request| matches!(
        request["method"].as_str(),
        Some("session.send" | "session.history.compact")
    )));
    assert_eq!(
        calls
            .iter()
            .filter(|request| request["method"] == "session.mode.set")
            .count(),
        1
    );
}

#[tokio::test]
async fn native_user_input_waits_for_ui_and_sends_one_response() {
    let runtime = mock_runtime();
    runtime.service.resume_session("a".into()).await.unwrap();
    let mut events = runtime.service.subscribe(None);
    runtime.inject(json!({"jsonrpc":"2.0","id":9001,"method":"userInput.request","params":{"sessionId":"a","question":"Continue?","choices":["Yes","No"],"allowFreeform":false}})).await;
    let interaction = tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if let AppEvent::InteractionRequested { interaction } =
                events.recv().await.unwrap().event
            {
                break interaction;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(interaction.kind, InteractionKind::UserInput);
    assert_eq!(runtime.service.pending_interactions("a").len(), 1);
    assert!(
        !runtime
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|call| call["id"] == 9001)
    );
    runtime
        .service
        .respond_interaction(InteractionResponse {
            session_id: "a".into(),
            request_id: interaction.request_id.clone(),
            kind: InteractionKind::UserInput,
            response: json!({"answer":"Yes","wasFreeform":false}),
        })
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), async {
        while !runtime
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|call| call["id"] == 9001)
        {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    let calls = runtime.calls.lock().unwrap();
    let replies: Vec<_> = calls.iter().filter(|call| call["id"] == 9001).collect();
    assert_eq!(replies.len(), 1);
    assert_eq!(
        replies[0]["result"],
        json!({"answer":"Yes","wasFreeform":false})
    );
}

#[tokio::test]
async fn fork_recovery_is_enabled_only_after_its_own_new_message_is_accepted() {
    let runtime = mock_runtime();
    runtime.service.metadata.write().await.get_mut("a").unwrap().prevent_pending_work = true;
    runtime.service.resume_session("a".into()).await.unwrap();
    let last_resume = || runtime.calls.lock().unwrap().iter()
        .rev().find(|request| request["method"] == "session.resume").unwrap().clone();
    assert_eq!(last_resume()["params"]["continuePendingWork"], false);
    runtime.service.accepting_work.store(false, Ordering::Relaxed);
    let request = || serde_json::from_value::<SendMessageRequest>(json!({
        "sessionId":"a", "content":"New work in this fork", "deliveryMode":"enqueue"
    })).unwrap();
    assert!(runtime.service.submit_message(request()).await.is_err());
    assert!(runtime.service.metadata.read().await["a"].prevent_pending_work);
    runtime.service.accepting_work.store(true, Ordering::Relaxed);
    runtime.service.submit_message(request()).await.unwrap();
    assert!(!load_metadata(&runtime.service.metadata_path)["a"].prevent_pending_work);
    runtime.service.active.write().await.remove("a");
    runtime.service.resume_session("a".into()).await.unwrap();
    assert_eq!(last_resume()["params"]["continuePendingWork"], true);
}
