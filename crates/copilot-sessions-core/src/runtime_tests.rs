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

#[path = "session_skills_tests.rs"]
mod session_skills;
#[path = "session_profiles_tests.rs"]
mod session_profiles;

struct MockRuntime {
    service: Arc<SessionService>,
    calls: Arc<Mutex<Vec<Value>>>,
    task: tokio::task::JoinHandle<()>,
    writer: Arc<AsyncMutex<tokio::io::WriteHalf<tokio::io::DuplexStream>>>,
    metadata_dir: PathBuf,
    processing: Arc<AtomicBool>,
    future_tool: Arc<AtomicBool>,
    missing_metadata: Arc<AtomicBool>,
    held_methods: Arc<Mutex<HashSet<String>>>,
}

impl MockRuntime {
    fn hold(&self, method: &str) {
        self.held_methods.lock().unwrap().insert(method.into());
    }

    fn requests(&self, method: &str) -> Vec<Value> {
        self.calls.lock().unwrap().iter().filter(|call| call["method"] == method).cloned().collect()
    }

    async fn request(&self, method: &str, count: usize) -> Value {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let calls = self.requests(method);
                if calls.len() >= count {
                    return calls[count - 1].clone();
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        }).await.unwrap_or_else(|_| panic!("missing {method} request {count}"))
    }

    async fn reply(&self, request: &Value, result: Value) {
        self.inject(json!({"jsonrpc":"2.0", "id": request["id"], "result": result})).await;
    }

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

fn new_session(deferred: bool) -> NewSession {
        serde_json::from_value(json!({
            "cwd": ".", "model": "requested-model", "deferInitialization": deferred,
        })).unwrap()
    }

    #[tokio::test]
    async fn creation_name_is_persisted_and_published_before_native_name_sync_finishes() {
        let runtime = mock_runtime();
        runtime.hold("session.name.set");
        let mut request = new_session(true);
        request.name = Some("  Focused review  ".into());
        let created = runtime.service.create_session(request).await.unwrap();
        let id = created.session_id.clone();
        assert_eq!(created.title, "Focused review");
        assert_eq!(created.initialization.unwrap().phase, InitializationPhase::Initializing);
        assert_eq!(load_metadata(&runtime.service.metadata_path)[&id].title.as_deref(), Some("Focused review"));
        assert_eq!(runtime.service.list_sessions().await.unwrap().iter().find(|session| session.session_id == id).unwrap().title, "Focused review");
        let naming = runtime.request("session.name.set", 1).await;
        assert_eq!(naming["params"]["name"], "Focused review");
        runtime.hold("session.name.get");
        runtime.reply(&naming, json!({})).await;
        let get = runtime.request("session.name.get", 1).await;
        runtime.reply(&get, json!({"name":"Focused review"})).await;
        initialization_phase(&runtime, &id, InitializationPhase::Ready).await;
        assert_eq!(runtime.service.session_initialization(&id).await.unwrap().session.unwrap().title, "Focused review");
        assert_eq!(runtime.requests("session.create").len(), 1);
        assert!(runtime.requests("session.send").is_empty());
    }

    #[tokio::test]
    async fn creation_name_sync_failure_retries_same_session_without_losing_local_name() {
        let runtime = mock_runtime();
        runtime.hold("session.name.set");
        let mut request = new_session(true);
        request.name = Some("Retry this name".into());
        let created = runtime.service.create_session(request).await.unwrap();
        let call = runtime.request("session.name.set", 1).await;
        runtime.inject(json!({"jsonrpc":"2.0","id":call["id"],"error":{"code":-32000,"message":"Name temporarily unavailable"}})).await;
        initialization_phase(&runtime, &created.session_id, InitializationPhase::Failed).await;
        assert_eq!(load_metadata(&runtime.service.metadata_path)[&created.session_id].title.as_deref(), Some("Retry this name"));
        runtime.held_methods.lock().unwrap().remove("session.name.set");
        runtime.service.retry_session_initialization(&created.session_id).await.unwrap();
        initialization_phase(&runtime, &created.session_id, InitializationPhase::Ready).await;
        assert_eq!(runtime.requests("session.name.set").len(), 2);
        assert_eq!(runtime.requests("session.create").len(), 1);
    }

    #[tokio::test]
    async fn creation_name_supports_synchronous_creation_and_blank_default() {
        let runtime = mock_runtime();
        let mut named = new_session(false);
        named.name = Some("Named conversation".into());
        let created = runtime.service.create_session(named).await.unwrap();
        assert_eq!(created.title, "Named conversation");
        assert_eq!(runtime.requests("session.name.set")[0]["params"]["name"], "Named conversation");
        let mut blank = new_session(false);
        blank.name = Some(" \t ".into());
        assert_eq!(runtime.service.create_session(blank).await.unwrap().title, "New session");
        assert_eq!(runtime.requests("session.name.set").len(), 1);
    }

    #[tokio::test]
    async fn creation_name_validation_rejects_invalid_names_before_native_creation() {
        let runtime = mock_runtime();
        for name in ["x".repeat(101), "line\nbreak".into(), "\u{1f680}".repeat(51)] {
            let mut request = new_session(true);
            request.name = Some(name);
            assert!(matches!(runtime.service.create_session(request).await, Err(ServiceError::InvalidArgument(_))));
        }
        assert!(runtime.requests("session.create").is_empty());
    }

    async fn scheduled_event(runtime: &MockRuntime, sid: &str, kind: &str, agent: Option<&str>, data: Value) {
        runtime.inject(json!({
            "jsonrpc":"2.0", "method":"session.event",
            "params":{"sessionId":sid, "event":{
                "id":format!("test-{kind}"), "timestamp":"2026-09-17T12:00:00Z",
                "type":kind, "agentId":agent, "data":data
            }}
        })).await;
    }

    #[tokio::test]
    async fn scheduled_prompt_uses_normal_permissions_interactive_enqueue_and_actual_root_completion() {
        let runtime = mock_runtime();
        runtime.processing.store(false, Ordering::Relaxed);
        let service = runtime.service.clone();
        let delivery = tokio::spawn(async move {
            service.deliver_scheduled_prompt("a".into(), "Use skill example and summarize changes".into(), "schedule-123".into()).await
        });
        let sent = runtime.request("session.send", 1).await;
        assert_eq!(sent["params"]["agentMode"], "interactive");
        assert_eq!(sent["params"]["mode"], "enqueue");
        assert_eq!(sent["params"]["source"], "schedule-123");
        assert_eq!(sent["params"]["prompt"], "Use skill example and summarize changes");
        assert!(!delivery.is_finished(), "acceptance is not turn completion");
        let resume = runtime.request("session.resume", 1).await;
        assert_eq!(resume["params"]["continuePendingWork"], false);
        for handler in ["requestPermission", "requestUserInput", "requestElicitation", "requestExitPlanMode", "requestAutoModeSwitch"] {
            assert_eq!(resume["params"][handler], true);
        }
        assert!(runtime.requests("session.commands.invoke").is_empty());
        scheduled_event(&runtime, "a", "session.idle", None, json!({})).await;
        scheduled_event(&runtime, "a", "assistant.turn_start", None, json!({})).await;
        scheduled_event(&runtime, "a", "session.idle", Some("child"), json!({})).await;
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(!delivery.is_finished(), "stale idle and child idle must not complete root");
        scheduled_event(&runtime, "a", "permission.requested", None, json!({
            "requestId":"scheduled-permission", "permissionRequest":{"kind":"shell", "fullCommandText":"example"}
        })).await;
        tokio::time::timeout(Duration::from_secs(1), async {
            while runtime.service.pending_permissions().is_empty() { tokio::task::yield_now().await; }
        }).await.unwrap();
        assert!(runtime.requests("session.permissions.handlePendingPermissionRequest").is_empty(), "scheduler must not auto-approve");
        runtime.service.decide_permission(PermissionDecision {
            request_id:"scheduled-permission".into(), approved:false,
        }).await.unwrap();
        let rejected = runtime.request("session.permissions.handlePendingPermissionRequest", 1).await;
        assert!(!rejected.to_string().contains("approved"));
        scheduled_event(&runtime, "a", "session.idle", None, json!({})).await;
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(1), delivery).await.unwrap().unwrap().unwrap(),
            ScheduledDelivery::Completed { .. }
        ));
    }

    #[tokio::test]
    async fn scheduled_prompt_defers_processing_steering_background_tasks_and_drain() {
        let runtime = mock_runtime();
        assert!(matches!(runtime.service.deliver_scheduled_prompt("a".into(), "not sent".into(), "schedule-123".into()).await.unwrap(), ScheduledDelivery::Deferred(_)));
        assert!(runtime.requests("session.send").is_empty());
        runtime.processing.store(false, Ordering::Relaxed);
        runtime.hold("session.queue.pendingItems");
        let service = runtime.service.clone();
        let delivery = tokio::spawn(async move { service.deliver_scheduled_prompt("a".into(), "not sent".into(), "schedule-123".into()).await });
        let queue = runtime.request("session.queue.pendingItems", 1).await;
        runtime.reply(&queue, json!({"items":[], "steeringMessages":["existing work"]})).await;
        assert!(matches!(delivery.await.unwrap().unwrap(), ScheduledDelivery::Deferred(_)));
        runtime.held_methods.lock().unwrap().remove("session.queue.pendingItems");
        runtime.hold("session.tasks.list");
        let service = runtime.service.clone();
        let delivery = tokio::spawn(async move { service.deliver_scheduled_prompt("a".into(), "not sent".into(), "schedule-123".into()).await });
        let tasks = runtime.request("session.tasks.list", 1).await;
        runtime.reply(&tasks, json!({"tasks":[{"id":"child","status":"running","type":"agent"}]})).await;
        assert!(matches!(delivery.await.unwrap().unwrap(), ScheduledDelivery::Deferred(_)));
        runtime.service.accepting_work.store(false, Ordering::Relaxed);
        assert!(matches!(runtime.service.deliver_scheduled_prompt("a".into(), "not sent".into(), "schedule-123".into()).await, Err(ServiceError::Draining)));
        assert!(runtime.requests("session.send").is_empty());
    }

    #[tokio::test]
    async fn scheduled_prompt_idle_check_and_send_share_gate_and_recheck_drain() {
        let runtime = mock_runtime();
        runtime.processing.store(false, Ordering::Relaxed);
        runtime.hold("session.tasks.list");
        let service = runtime.service.clone();
        let delivery = tokio::spawn(async move { service.deliver_scheduled_prompt("a".into(), "not sent".into(), "schedule-123".into()).await });
        let tasks = runtime.request("session.tasks.list", 1).await;
        let gate = runtime.service.turn_gate("a").await;
        assert!(gate.try_lock().is_err(), "idle check lost per-session ordering");
        assert!(runtime.service.lifecycle_gate.try_write().is_err(), "admission must exclude drain");
        runtime.service.accepting_work.store(false, Ordering::Relaxed);
        runtime.reply(&tasks, json!({"tasks":[]})).await;
        assert!(matches!(delivery.await.unwrap(), Err(ServiceError::Draining)));
        assert!(runtime.requests("session.send").is_empty());
    }

    #[tokio::test]
    async fn scheduled_prompt_awaiting_completion_does_not_block_lifecycle_or_user_turn_gate() {
        let runtime = mock_runtime();
        runtime.processing.store(false, Ordering::Relaxed);
        let service = runtime.service.clone();
        let delivery = tokio::spawn(async move { service.deliver_scheduled_prompt("a".into(), "test".into(), "schedule-123".into()).await });
        runtime.request("session.send", 1).await;
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(runtime.service.turn_gate("a").await.try_lock().is_ok());
        assert!(runtime.service.lifecycle_gate.try_write().is_ok());
        let session = runtime.service.active.read().await["a"].clone();
        session.disconnect().await.unwrap();
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(2), delivery).await.unwrap().unwrap().unwrap(),
            ScheduledDelivery::Uncertain(_)
        ));
    }

    #[tokio::test]
    async fn scheduled_session_is_dedicated_organized_and_durable_before_warmup() {
        let runtime = mock_runtime();
        runtime.hold("session.tools.initializeAndValidate");
        let id = runtime.service.create_scheduled_session("Daily briefing", ".".into(), Some("requested-model".into())).await.unwrap();
        let metadata = load_metadata(&runtime.service.metadata_path);
        assert_eq!(metadata[&id].title.as_deref(), Some("Daily briefing"));
        assert!(metadata[&id].pinned);
        assert_eq!(metadata[&id].folder.as_deref(), Some("Scheduled"));
        assert_eq!(metadata[&id].tags, ["scheduled"]);
        assert!(metadata[&id].prevent_pending_work);
        assert!(runtime.service.validate_scheduled_target(&id).await.is_ok());
        assert!(runtime.service.validate_scheduled_target("missing").await.is_err());
        assert_eq!(runtime.requests("session.create").len(), 1);
        assert!(runtime.requests("session.send").is_empty());
    }

    #[tokio::test]
    async fn scheduled_prompt_lost_acceptance_is_uncertain_not_retryable() {
        let runtime = mock_runtime();
        runtime.processing.store(false, Ordering::Relaxed);
        runtime.hold("session.send");
        let service = runtime.service.clone();
        let delivery = tokio::spawn(async move { service.deliver_scheduled_prompt("a".into(), "test".into(), "schedule-123".into()).await });
        let send = runtime.request("session.send", 1).await;
        runtime.inject(json!({"jsonrpc":"2.0", "id":send["id"], "error":{"code":-32000, "message":"lost acknowledgement"}})).await;
        assert!(matches!(delivery.await.unwrap().unwrap(), ScheduledDelivery::Uncertain(_)));
        assert_eq!(runtime.requests("session.send").len(), 1);
    }

    #[tokio::test]
    async fn scheduled_prompt_never_inherits_autopilot_or_plan_permission_posture() {
        for mode in ["autopilot", "plan"] {
            let runtime = mock_runtime();
            runtime.processing.store(false, Ordering::Relaxed);
            runtime.hold("session.mode.get");
            let service = runtime.service.clone();
            let delivery = tokio::spawn(async move { service.deliver_scheduled_prompt("a".into(), "not sent".into(), "schedule-123".into()).await });
            let get = runtime.request("session.mode.get", 1).await;
            runtime.reply(&get, json!(mode)).await;
            assert!(matches!(delivery.await.unwrap().unwrap(), ScheduledDelivery::Deferred(reason) if reason.contains("interactive")));
            assert!(runtime.requests("session.send").is_empty());
            assert!(runtime.requests("session.mode.set").is_empty(), "do not silently change user-selected session mode");
        }
    }

    #[tokio::test]
    async fn scheduled_prompt_defers_queued_items_and_pending_ask_user() {
        let runtime = mock_runtime();
        runtime.processing.store(false, Ordering::Relaxed);
        runtime.hold("session.queue.pendingItems");
        let service = runtime.service.clone();
        let delivery = tokio::spawn(async move { service.deliver_scheduled_prompt("a".into(), "not sent".into(), "schedule-123".into()).await });
        let queue = runtime.request("session.queue.pendingItems", 1).await;
        runtime.reply(&queue, json!({"items":[{
            "id":"queued", "kind":"message", "displayText":"Prior request", "agentMode":"interactive"
        }], "steeringMessages":[]})).await;
        assert!(matches!(delivery.await.unwrap().unwrap(), ScheduledDelivery::Deferred(_)));
        runtime.held_methods.lock().unwrap().remove("session.queue.pendingItems");
        runtime.service.interactions.observe_native_event("a", &json!({
            "id":"ask", "type":"user_input.requested", "ephemeral":true,
            "data":{"requestId":"ask", "question":"Continue?", "choices":["Yes","No"], "allowFreeform":false, "toolCallId":"t"}
        }));
        assert!(matches!(
            runtime.service.deliver_scheduled_prompt("a".into(), "not sent".into(), "schedule-123".into()).await.unwrap(),
            ScheduledDelivery::Deferred(reason) if reason.contains("user input")
        ));
        assert!(runtime.requests("session.send").is_empty());
    }

    async fn initialization_phase(runtime: &MockRuntime, id: &str, phase: InitializationPhase) -> SessionInitialization {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let state = runtime.service.session_initialization(id).await.unwrap();
                if state.initialization.phase == phase {
                    return state;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        }).await.expect("initialization phase was not reached")
    }

    #[tokio::test]
    async fn deferred_creation_returns_real_durable_attached_session_then_singleflight_readiness() {
        let runtime = mock_runtime();
        runtime.hold("session.tools.initializeAndValidate");
        runtime.hold("session.model.getCurrent");
        let mut events = runtime.service.subscribe(None);
        let created = tokio::time::timeout(
            Duration::from_millis(500), runtime.service.create_session(new_session(true)),
        ).await.expect("creation waited for warmup").unwrap();
        let id = &created.session_id;
        let request = runtime.request("session.create", 1).await;
        assert_eq!(id, request["params"]["sessionId"].as_str().unwrap());
        assert!(created.is_active);
        assert_eq!(serde_json::to_value(&created.initialization).unwrap(), json!({"phase":"initializing", "stage":"tools"}));
        assert_eq!(load_metadata(&runtime.service.metadata_path)[id].model.as_deref(), Some("requested-model"));
        let tools = runtime.request("session.tools.initializeAndValidate", 1).await;
        let before = runtime.calls.lock().unwrap().len();
        let snapshot = runtime.service.session_initialization(id).await.unwrap();
        assert_eq!(snapshot.initialization.phase, InitializationPhase::Initializing);
        assert!(snapshot.session.is_none());
        // Polling has no native RPC; ignore independently running event log reads.
        assert!(runtime.calls.lock().unwrap()[before..].iter().all(|call| call["method"] == "session.eventLog.read"));
        assert!(matches!(runtime.service.submit_message(serde_json::from_value(json!({
            "sessionId":id, "content":"do not submit this while pending",
        })).unwrap()).await, Err(ServiceError::SessionNotReady { .. })));
        assert!(runtime.service.switch_model(id, "other".into(), None, None, None).await.is_err());
        assert!(runtime.service.execute_command(id, "test".into(), "".into()).await.is_err());
        assert!(runtime.requests("session.send").is_empty());
        assert!(runtime.requests("session.model.switchTo").is_empty());
        assert!(runtime.requests("session.commands.invoke").is_empty());

        let first = {
            let service = runtime.service.clone();
            let id = id.clone();
            tokio::spawn(async move { service.resume_session(id).await })
        };
        let second = {
            let service = runtime.service.clone();
            let id = id.clone();
            tokio::spawn(async move { service.resume_session(id).await })
        };
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(!first.is_finished() && !second.is_finished());
        assert_eq!(runtime.requests("session.tools.initializeAndValidate").len(), 1);
        assert!(runtime.requests("session.resume").is_empty());
        let archived = runtime.service.set_session_archived(SetSessionArchived { session_id: id.clone(), archived: true }).await.unwrap();
        assert!(archived.archived);
        let organized = runtime.service.organize_session(OrganizationUpdate {
            session_id: id.clone(), pinned: true, folder: Some("Projects".into()), tags: vec!["new".into()],
        }).await.unwrap();
        assert!(organized.pinned && organized.archived);
        assert!(organized.initialization.is_some());
        assert!(runtime.service.list_sessions().await.unwrap().iter().any(|item| item.session_id == *id));
        runtime.reply(&tools, json!({})).await;
        let model = runtime.request("session.model.getCurrent", 1).await;
        let state = runtime.service.session_initialization(id).await.unwrap();
        assert_eq!(state.initialization.stage, InitializationStage::Model);
        assert_eq!(state.initialization.phase, InitializationPhase::Initializing);
        runtime.reply(&model, json!({"modelId":"resolved-model"})).await;
        let ready = initialization_phase(&runtime, id, InitializationPhase::Ready).await;
        let summary = ready.session.unwrap();
        assert_eq!(summary.model.as_deref(), Some("resolved-model"));
        assert!(summary.pinned && summary.archived && summary.is_active);
        assert_eq!(summary.tags, ["new"]);
        assert_eq!(load_metadata(&runtime.service.metadata_path)[id].model.as_deref(), Some("resolved-model"));
        assert!(first.await.unwrap().unwrap().initialization.is_some());
        assert_eq!(second.await.unwrap().unwrap().model.as_deref(), Some("resolved-model"));
        let cached = runtime.service.list_sessions().await.unwrap().into_iter().find(|item| item.session_id == *id).unwrap();
        assert_eq!(cached.model, summary.model);
        let mut stages = vec![];
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let AppEvent::SessionInitializationChanged { session_id, initialization } = events.recv().await.unwrap().event {
                    assert_eq!(session_id, *id);
                    stages.push(initialization.stage);
                    if initialization.phase == InitializationPhase::Ready { break; }
                }
            }
        }).await.unwrap();
        assert_eq!(stages, [InitializationStage::Tools, InitializationStage::Model, InitializationStage::Ready]);
        runtime.service.submit_message(serde_json::from_value(json!({
            "sessionId":id, "content":"explicit user submission",
        })).unwrap()).await.unwrap();
        assert_eq!(runtime.requests("session.send").len(), 1);
    }

    #[tokio::test]
    async fn deferred_initialization_failure_and_retry_keep_id_and_deduplicate() {
        let runtime = mock_runtime();
        runtime.hold("session.tools.initializeAndValidate");
        let summary = runtime.service.create_session(new_session(true)).await.unwrap();
        let id = &summary.session_id;
        let tools = runtime.request("session.tools.initializeAndValidate", 1).await;
        runtime.inject(json!({"jsonrpc":"2.0","id":tools["id"],"error":{"code":-32000,"message":"tools unavailable"}})).await;
        let failed = initialization_phase(&runtime, id, InitializationPhase::Failed).await;
        assert_eq!(failed.session_id, *id);
        assert_eq!(failed.initialization.stage, InitializationStage::Tools);
        assert!(failed.initialization.error.unwrap().contains("tools unavailable"));
        assert!(runtime.service.resume_session(id.clone()).await.is_err());
        let (one, two) = tokio::join!(
            runtime.service.retry_session_initialization(id),
            runtime.service.retry_session_initialization(id),
        );
        for response in [one.unwrap(), two.unwrap()] {
            assert_eq!(response.session_id, *id);
            assert_eq!(response.initialization.phase, InitializationPhase::Initializing);
        }
        let retry_tools = runtime.request("session.tools.initializeAndValidate", 2).await;
        assert_eq!(runtime.requests("session.tools.initializeAndValidate").len(), 2);
        runtime.reply(&retry_tools, json!({})).await;
        initialization_phase(&runtime, id, InitializationPhase::Ready).await;
        assert_eq!(runtime.requests("session.create").len(), 1);
        assert!(runtime.requests("session.resume").is_empty());
        assert!(runtime.requests("session.send").is_empty());
        let ready = runtime.service.retry_session_initialization(id).await.unwrap();
        assert_eq!(ready.initialization.phase, InitializationPhase::Ready);
        assert_eq!(runtime.requests("session.tools.initializeAndValidate").len(), 2);
    }

    #[tokio::test]
    async fn deferred_create_survives_caller_cancellation_before_sdk_reply() {
        let runtime = mock_runtime();
        runtime.hold("session.create");
        runtime.hold("session.tools.initializeAndValidate");
        let service = runtime.service.clone();
        let caller = tokio::spawn(async move { service.create_session(new_session(true)).await });
        let create = runtime.request("session.create", 1).await;
        let id = create["params"]["sessionId"].as_str().unwrap();
        caller.abort();
        let _ = caller.await;
        runtime.reply(&create, json!({"sessionId":id})).await;
        let tools = runtime.request("session.tools.initializeAndValidate", 1).await;
        assert!(load_metadata(&runtime.service.metadata_path).contains_key(id));
        assert!(runtime.service.active.read().await.contains_key(id));
        runtime.reply(&tools, json!({})).await;
        initialization_phase(&runtime, id, InitializationPhase::Ready).await;
        assert!(runtime.requests("session.send").is_empty());
    }

    #[tokio::test]
    async fn deferred_delete_and_late_index_model_replies_cannot_resurrect_session() {
        let runtime = mock_runtime();
        runtime.hold("session.model.getCurrent");
        runtime.hold("session.list");
        let created = runtime.service.create_session(new_session(true)).await.unwrap();
        let id = &created.session_id;
        let model = runtime.request("session.model.getCurrent", 1).await;
        let service = runtime.service.clone();
        let listing = tokio::spawn(async move { service.list_sessions().await });
        let list = runtime.request("session.list", 1).await;
        runtime.service.delete_session(id).await.unwrap();
        runtime.reply(&model, json!({"modelId":"late-model"})).await;
        runtime.reply(&list, json!({"sessions":[{"sessionId":id,"summary":"stale-index"}]})).await;
        assert!(!listing.await.unwrap().unwrap().iter().any(|item| item.session_id == *id));
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(!runtime.service.metadata.read().await.contains_key(id));
        assert!(!load_metadata(&runtime.service.metadata_path).contains_key(id));
        assert!(!runtime.service.warmed.read().await.contains(id));
        assert!(!runtime.service.active.read().await.contains_key(id));
        assert!(runtime.service.session_initialization(id).await.is_err());
        assert!(runtime.service.retry_session_initialization(id).await.is_err());
        let events = &runtime.service.events.state.lock().unwrap().history;
        let deleted = events.iter().position(|event| matches!(&event.event, AppEvent::SessionDeleted { session_id } if session_id == id)).unwrap();
        assert!(!events.iter().skip(deleted + 1).any(|event| matches!(&event.event, AppEvent::SessionInitializationChanged { .. })));
    }

    #[tokio::test]
    async fn deferred_drain_cancels_warmup_without_waiting_for_resume_or_tools() {
        for force in [false, true] {
            let runtime = mock_runtime();
            runtime.processing.store(false, Ordering::Relaxed);
            runtime.hold("session.tools.initializeAndValidate");
            let created = runtime.service.create_session(new_session(true)).await.unwrap();
            let tools = runtime.request("session.tools.initializeAndValidate", 1).await;
            let service = runtime.service.clone();
            let id = created.session_id.clone();
            let resume = tokio::spawn(async move { service.resume_session(id).await });
            tokio::time::sleep(Duration::from_millis(10)).await;
            let drained = tokio::time::timeout(Duration::from_secs(2),
                runtime.service.drain(Duration::ZERO, force),
            ).await.expect("drain waited for native warmup").unwrap();
            assert!(drained.complete);
            assert_eq!(drained.disconnected_sessions, 1);
            assert!(resume.await.unwrap().is_err());
            let state = runtime.service.session_initialization(&created.session_id).await.unwrap();
            assert_eq!(state.initialization.phase, InitializationPhase::Failed);
            assert!(state.session.is_none());
            assert!(runtime.service.active.read().await.is_empty());
            assert!(runtime.service.warmed.read().await.is_empty());
            assert!(!runtime.service.runtime_status().await.connected);
            assert!(runtime.service.list_sessions().await.unwrap().iter().all(|item| !item.is_active));
            assert!(runtime.requests("session.model.getCurrent").is_empty());
            // Closing a stopped duplex transport is expected; the held response
            // cannot be delivered, and no background initializer survives drain.
            assert_eq!(tools["params"]["sessionId"], created.session_id);
        }
    }

    #[tokio::test]
    async fn deferred_late_list_reads_merge_current_metadata_and_initialization() {
        let runtime = mock_runtime();
        runtime.hold("session.list");
        runtime.hold("session.tools.initializeAndValidate");
        let service = runtime.service.clone();
        let listing = tokio::spawn(async move { service.list_sessions().await });
        let list = runtime.request("session.list", 1).await;
        let created = runtime.service.create_session(new_session(true)).await.unwrap();
        runtime.service.set_session_archived(SetSessionArchived { session_id: created.session_id.clone(), archived: true }).await.unwrap();
        runtime.reply(&list, json!({"sessions":[]})).await;
        let summaries = listing.await.unwrap().unwrap();
        let cached = summaries.iter().find(|item| item.session_id == created.session_id).unwrap();
        assert!(cached.archived && cached.is_active);
        assert_eq!(cached.model, created.model);
        assert_eq!(cached.initialization.as_ref().unwrap().phase, InitializationPhase::Initializing);
    }

    #[tokio::test]
    async fn deferred_local_index_is_visible_before_attach_and_ahead_of_native_history() {
        let runtime = mock_runtime();
        runtime.hold("session.eventLog.tail");
        runtime.hold("session.tools.initializeAndValidate");
        runtime.hold("session.list");
        let service = runtime.service.clone();
        let listing = tokio::spawn(async move { service.list_sessions().await });
        let list = runtime.request("session.list", 1).await;
        let service = runtime.service.clone();
        let creation = tokio::spawn(async move { service.create_session(new_session(true)).await });
        let tail = runtime.request("session.eventLog.tail", 1).await;
        let id = tail["params"]["sessionId"].as_str().unwrap();
        let rows: Vec<_> = (0..150).map(|index| json!({
            "sessionId": format!("older-{index}"), "summary":"Existing session",
            "modifiedTime":"2026-09-20T10:00:00Z",
        })).collect();
        runtime.reply(&list, json!({"sessions":rows})).await;
        let indexed = listing.await.unwrap().unwrap();
        assert_eq!(indexed[0].session_id, id, "the native ID must be on the first sidebar page");
        assert_eq!(indexed[0].initialization.as_ref().unwrap().phase, InitializationPhase::Initializing);
        assert!(!indexed[0].is_active, "do not claim the event stream is attached before tail completes");
        assert!(!creation.is_finished(), "event-log attachment is still pending");
        assert!(runtime.requests("session.resume").is_empty());
        assert!(runtime.requests("session.send").is_empty());
        runtime.reply(&tail, json!({"cursor":"tail"})).await;
        creation.await.unwrap().unwrap();
        assert_eq!(runtime.requests("session.list").len(), 1, "creation must not wait for native indexing");
    }

    #[tokio::test]
    async fn deferred_create_gate_rejects_inflight_creation_but_does_not_wait_for_warmup() {
        let runtime = mock_runtime();
        runtime.hold("session.create");
        runtime.hold("session.tools.initializeAndValidate");
        let service = runtime.service.clone();
        let first = tokio::spawn(async move { service.create_session(new_session(true)).await });
        let create = runtime.request("session.create", 1).await;
        let duplicate = tokio::time::timeout(
            Duration::from_millis(500), runtime.service.create_session(new_session(true)),
        ).await.expect("the create gate must reject, not queue");
        assert!(matches!(duplicate, Err(ServiceError::SessionProcessing(_))));
        assert_eq!(runtime.requests("session.create").len(), 1);
        runtime.reply(&create, json!({"sessionId":create["params"]["sessionId"]})).await;
        let first = first.await.unwrap().unwrap();
        runtime.request("session.tools.initializeAndValidate", 1).await;
        runtime.held_methods.lock().unwrap().remove("session.create");
        let second = tokio::time::timeout(
            Duration::from_millis(500), runtime.service.create_session(new_session(true)),
        ).await.expect("another session's warmup must not hold the create gate").unwrap();
        assert_ne!(first.session_id, second.session_id);
        assert_eq!(runtime.requests("session.create").len(), 2);
        assert!(runtime.requests("session.list").is_empty());
        assert!(runtime.requests("session.resume").is_empty());
        assert!(runtime.requests("session.send").is_empty());
    }

    #[tokio::test]
    async fn default_create_still_waits_for_initialization_and_unknown_readiness_is_explicit() {
        let runtime = mock_runtime();
        let request: NewSession = serde_json::from_value(json!({"cwd":"."})).unwrap();
        assert!(!request.defer_initialization);
        assert!(runtime.service.session_initialization("a").await.is_err());
        runtime.hold("session.tools.initializeAndValidate");
        let service = runtime.service.clone();
        let create = tokio::spawn(async move { service.create_session(request).await });
        let tools = runtime.request("session.tools.initializeAndValidate", 1).await;
        assert!(!create.is_finished());
        runtime.reply(&tools, json!({})).await;
        let created = create.await.unwrap().unwrap();
        assert!(created.initialization.is_none());
        assert_eq!(runtime.requests("session.model.getCurrent").len(), 1);
        let state = runtime.service.session_initialization(&created.session_id).await.unwrap();
        assert_eq!(state.initialization.phase, InitializationPhase::Ready);
    }

#[tokio::test]
async fn deferred_model_failure_retries_without_losing_preferences_or_accepting_work() {
    let runtime = mock_runtime();
    runtime.hold("session.model.getCurrent");
    let created = runtime.service.create_session(new_session(true)).await.unwrap();
    let id = &created.session_id;
    let model = runtime.request("session.model.getCurrent", 1).await;
    runtime.inject(json!({"jsonrpc":"2.0","id":model["id"],"error":{"code":-32000,"message":"model discovery failed"}})).await;
    let failed = initialization_phase(&runtime, id, InitializationPhase::Failed).await;
    assert_eq!(failed.initialization.stage, InitializationStage::Model);
    assert!(failed.initialization.error.unwrap().contains("model discovery failed"));
    assert!(!runtime.service.warmed.read().await.contains(id));
    assert!(runtime.service.submit_message(serde_json::from_value(json!({
        "sessionId":id,"content":"blocked during failure",
    })).unwrap()).await.is_err());
    runtime.service.retry_session_initialization(id).await.unwrap();
    let retry = runtime.request("session.model.getCurrent", 2).await;
    runtime.reply(&retry, json!({"modelId":"resolved-after-retry"})).await;
    let ready = initialization_phase(&runtime, id, InitializationPhase::Ready).await;
    assert_eq!(ready.session.unwrap().model.as_deref(), Some("resolved-after-retry"));
    assert_eq!(runtime.requests("session.create").len(), 1);
    assert!(runtime.requests("session.send").is_empty());
}

#[tokio::test]
async fn deferred_incomplete_drain_cancels_job_and_same_id_retry_ignores_late_reply() {
    let runtime = mock_runtime();
    runtime.hold("session.tools.initializeAndValidate");
    let created = runtime.service.create_session(new_session(true)).await.unwrap();
    let id = &created.session_id;
    let original = runtime.request("session.tools.initializeAndValidate", 1).await;
    let drained = tokio::time::timeout(Duration::from_secs(1),
        runtime.service.drain(Duration::ZERO, false),
    ).await.unwrap().unwrap();
    assert!(!drained.complete);
    assert_eq!(drained.processing_sessions, [id.clone()]);
    assert_eq!(runtime.service.session_initialization(id).await.unwrap().initialization.phase, InitializationPhase::Failed);
    assert!(runtime.service.retry_session_initialization(id).await.is_err());
    runtime.service.cancel_drain().await.unwrap();
    runtime.service.retry_session_initialization(id).await.unwrap();
    let retry = runtime.request("session.tools.initializeAndValidate", 2).await;
    runtime.reply(&original, json!({})).await;
    tokio::time::sleep(Duration::from_millis(10)).await;
    assert!(runtime.requests("session.model.getCurrent").is_empty());
    assert!(!runtime.service.warmed.read().await.contains(id));
    runtime.reply(&retry, json!({})).await;
    initialization_phase(&runtime, id, InitializationPhase::Ready).await;
    assert_eq!(runtime.requests("session.create").len(), 1);
}

#[tokio::test]
async fn deferred_disconnect_downgrades_ready_and_explicit_resume_never_replays_pending_work() {
    let runtime = mock_runtime();
    let created = runtime.service.create_session(new_session(true)).await.unwrap();
    let id = &created.session_id;
    initialization_phase(&runtime, id, InitializationPhase::Ready).await;
    let session = runtime.service.session(id).await.unwrap();
    session.disconnect().await.unwrap();
    initialization_phase(&runtime, id, InitializationPhase::Failed).await;
    tokio::time::timeout(Duration::from_secs(1), async {
        while runtime.service.active.read().await.contains_key(id) {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    }).await.unwrap();
    assert!(!runtime.service.list_sessions().await.unwrap().into_iter().find(|item| item.session_id == *id).unwrap().is_active);
    let resumed = runtime.service.resume_session(id.clone()).await.unwrap();
    assert!(resumed.is_active);
    assert_eq!(runtime.request("session.resume", 1).await["params"]["continuePendingWork"], false);
    assert_eq!(runtime.service.session_initialization(id).await.unwrap().initialization.phase, InitializationPhase::Ready);
    assert_eq!(runtime.requests("session.create").len(), 1);
    assert!(runtime.requests("session.send").is_empty());
}

#[tokio::test]
async fn deferred_readiness_registered_before_attach_and_retry_survives_caller_cancellation() {
    let runtime = mock_runtime();
    runtime.hold("session.eventLog.tail");
    runtime.hold("session.tools.initializeAndValidate");
    let service = runtime.service.clone();
    let creation = tokio::spawn(async move { service.create_session(new_session(true)).await });
    let tail = runtime.request("session.eventLog.tail", 1).await;
    let id = tail["params"]["sessionId"].as_str().unwrap();
    assert_eq!(runtime.service.session_initialization(id).await.unwrap().initialization.phase, InitializationPhase::Initializing);
    assert!(runtime.service.session(id).await.is_err());
    assert!(!runtime.service.active.read().await.contains_key(id));
    assert!(runtime.requests("session.tools.initializeAndValidate").is_empty());
    runtime.reply(&tail, json!({"cursor":"tail"})).await;
    assert!(creation.await.unwrap().unwrap().is_active);
    let tools = runtime.request("session.tools.initializeAndValidate", 1).await;
    runtime.inject(json!({"jsonrpc":"2.0","id":tools["id"],"error":{"code":-32000,"message":"retryable"}})).await;
    initialization_phase(&runtime, id, InitializationPhase::Failed).await;
    let lifecycle = runtime.service.lifecycle_gate.write().await;
    let service = runtime.service.clone();
    let retry_id = id.to_owned();
    let caller = tokio::spawn(async move { service.retry_session_initialization(&retry_id).await });
    tokio::time::sleep(Duration::from_millis(10)).await;
    caller.abort();
    let _ = caller.await;
    drop(lifecycle);
    let retry = runtime.request("session.tools.initializeAndValidate", 2).await;
    runtime.reply(&retry, json!({})).await;
    initialization_phase(&runtime, id, InitializationPhase::Ready).await;
    assert_eq!(runtime.requests("session.create").len(), 1);
}

#[tokio::test]
async fn deferred_safe_reads_remain_available_without_duplicate_tool_initialization() {
    let runtime = mock_runtime();
    runtime.hold("session.tools.initializeAndValidate");
    let created = runtime.service.create_session(new_session(true)).await.unwrap();
    let id = &created.session_id;
    let tools = runtime.request("session.tools.initializeAndValidate", 1).await;
    tokio::time::timeout(Duration::from_secs(1), async {
        assert!(runtime.service.history(id, None).await.unwrap().events.is_empty());
        assert!(runtime.service.recent_history(id).await.unwrap().events.is_empty());
        assert!(runtime.service.subagent_context(id).await.unwrap().is_empty());
        runtime.service.session_state(id).await.unwrap();
        runtime.service.reference_section(id, "tools").await.unwrap();
        runtime.service.mcp_tools(id).await.unwrap();
    }).await.expect("safe reads waited for initialization");
    assert!(runtime.service.tool_controls(id).await.is_err());
    assert!(runtime.service.submit_message(serde_json::from_value(json!({
        "sessionId":id,"content":"still blocked",
    })).unwrap()).await.is_err());
    assert_eq!(runtime.requests("session.tools.initializeAndValidate").len(), 1);
    assert!(runtime.requests("session.send").is_empty());
    runtime.reply(&tools, json!({})).await;
    initialization_phase(&runtime, id, InitializationPhase::Ready).await;
}

#[tokio::test]
async fn deferred_ready_status_survives_cancelled_drain_then_downgrades_on_disconnect() {
    let runtime = mock_runtime();
    let created = runtime.service.create_session(new_session(true)).await.unwrap();
    let id = &created.session_id;
    initialization_phase(&runtime, id, InitializationPhase::Ready).await;
    let incomplete = runtime.service.drain(Duration::ZERO, false).await.unwrap();
    assert!(!incomplete.complete);
    assert_eq!(runtime.service.session_initialization(id).await.unwrap().initialization.phase, InitializationPhase::Ready);
    assert!(runtime.service.submit_message(serde_json::from_value(json!({
        "sessionId":id,"content":"blocked by admission despite readiness",
    })).unwrap()).await.is_err());
    runtime.service.cancel_drain().await.unwrap();
    assert_eq!(runtime.service.session_initialization(id).await.unwrap().initialization.phase, InitializationPhase::Ready);
    assert!(runtime.service.session(id).await.is_ok());
    runtime.processing.store(false, Ordering::Relaxed);
    assert!(runtime.service.drain(Duration::ZERO, false).await.unwrap().complete);
    let disconnected = runtime.service.session_initialization(id).await.unwrap();
    assert_eq!(disconnected.initialization.phase, InitializationPhase::Failed);
    assert!(disconnected.session.is_none());
    assert!(runtime.service.session(id).await.is_err());
    assert!(runtime.requests("session.send").is_empty());
}

#[tokio::test]
async fn deferred_recovery_retry_reattaches_disconnected_ready_and_pending_sessions_once() {
    for pending in [false, true] {
        let runtime = mock_runtime();
        if pending {
            runtime.hold("session.tools.initializeAndValidate");
        }
        let created = runtime.service.create_session(new_session(true)).await.unwrap();
        let id = &created.session_id;
        let original = runtime.request("session.tools.initializeAndValidate", 1).await;
        if !pending {
            initialization_phase(&runtime, id, InitializationPhase::Ready).await;
        }
        // Even a previously used session must never replay pending work on Retry.
        runtime.service.metadata.write().await.get_mut(id).unwrap().prevent_pending_work = false;
        let session = runtime.service.active.read().await[id].clone();
        session.disconnect().await.unwrap();
        initialization_phase(&runtime, id, InitializationPhase::Failed).await;
        runtime.hold("session.resume");
        runtime.hold("session.tools.initializeAndValidate");
        let service = runtime.service.clone();
        let first_id = id.clone();
        let first = tokio::spawn(async move { service.retry_session_initialization(&first_id).await });
        let native_resume = runtime.request("session.resume", 1).await;
        let service = runtime.service.clone();
        let second_id = id.clone();
        let second = tokio::spawn(async move { service.retry_session_initialization(&second_id).await });
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(runtime.requests("session.resume").len(), 1);
        assert_eq!(native_resume["params"]["sessionId"], *id);
        assert_eq!(native_resume["params"]["continuePendingWork"], false);
        assert_eq!(native_resume["params"]["excludedTools"], json!([]));
        assert_eq!(runtime.service.session_initialization(id).await.unwrap().initialization.phase, InitializationPhase::Failed);
        runtime.reply(&native_resume, json!({"sessionId":id})).await;
        for response in [first.await.unwrap().unwrap(), second.await.unwrap().unwrap()] {
            assert_eq!(response.session_id, *id);
            assert_eq!(response.initialization.phase, InitializationPhase::Initializing);
        }
        let retry_tools = runtime.request("session.tools.initializeAndValidate", 2).await;
        if pending {
            runtime.reply(&original, json!({})).await;
            tokio::time::sleep(Duration::from_millis(10)).await;
            assert!(runtime.requests("session.model.getCurrent").is_empty());
        }
        runtime.reply(&retry_tools, json!({})).await;
        let ready = initialization_phase(&runtime, id, InitializationPhase::Ready).await;
        assert!(ready.session.unwrap().is_active);
        assert_eq!(runtime.requests("session.create").len(), 1);
        assert_eq!(runtime.requests("session.resume").len(), 1);
        assert!(runtime.requests("session.send").is_empty());
    }
}

#[tokio::test]
async fn deferred_recovery_deleted_tombstones_block_queued_retry_and_stale_registry() {
    let runtime = mock_runtime();
    let created = runtime.service.create_session(new_session(true)).await.unwrap();
    let id = &created.session_id;
    initialization_phase(&runtime, id, InitializationPhase::Ready).await;
    let stale = runtime.service.initializations.read().await.runs[id].clone();
    runtime.service.active.read().await[id].disconnect().await.unwrap();
    initialization_phase(&runtime, id, InitializationPhase::Failed).await;
    runtime.hold("session.delete");
    let service = runtime.service.clone();
    let delete_id = id.clone();
    let deleting = tokio::spawn(async move { service.delete_session(&delete_id).await });
    let deletion = runtime.request("session.delete", 1).await;
    let service = runtime.service.clone();
    let retry_id = id.clone();
    let retry = tokio::spawn(async move { service.retry_session_initialization(&retry_id).await });
    runtime.reply(&deletion, json!({})).await;
    deleting.await.unwrap().unwrap();
    assert!(retry.await.unwrap().is_err());
    // Even an erroneous late record insertion is not authority to resurrect.
    runtime.service.initializations.write().await.runs.insert(id.clone(), stale);
    assert!(runtime.service.retry_session_initialization(id).await.is_err());
    assert!(runtime.service.resume_session(id.clone()).await.is_err());
    assert!(!runtime.service.list_sessions().await.unwrap().iter().any(|item| item.session_id == *id));
    assert!(runtime.requests("session.resume").is_empty());
    assert_eq!(runtime.requests("session.create").len(), 1);
}

#[tokio::test]
async fn deferred_recovery_failed_delete_restores_visibility_preferences_and_retry() {
    for pending in [false, true] {
        let runtime = mock_runtime();
        if pending {
            runtime.hold("session.tools.initializeAndValidate");
        }
        let created = runtime.service.create_session(new_session(true)).await.unwrap();
        let id = &created.session_id;
        let original = runtime.request("session.tools.initializeAndValidate", 1).await;
        if !pending {
            initialization_phase(&runtime, id, InitializationPhase::Ready).await;
        }
        runtime.hold("session.delete");
        runtime.hold("session.tools.initializeAndValidate");
        let service = runtime.service.clone();
        let delete_id = id.clone();
        let deleting = tokio::spawn(async move { service.delete_session(&delete_id).await });
        let deletion = runtime.request("session.delete", 1).await;
        assert!(runtime.service.initializations.read().await.deleted.contains(id));
        // Local organization remains editable during native deletion.
        runtime.service.set_session_archived(SetSessionArchived {
            session_id: id.clone(), archived: true,
        }).await.unwrap();
        runtime.inject(json!({"jsonrpc":"2.0","id":deletion["id"],"error":{"code":-32000,"message":"delete denied"}})).await;
        assert!(deleting.await.unwrap().is_err());
        assert!(!runtime.service.initializations.read().await.deleted.contains(id));
        assert!(load_metadata(&runtime.service.metadata_path)[id].archived);
        let listed = runtime.service.list_sessions().await.unwrap();
        let matches = listed.iter().filter(|item| item.session_id == *id).collect::<Vec<_>>();
        assert_eq!(matches.len(), 1);
        assert!(matches[0].is_active && matches[0].archived);
        assert_eq!(matches[0].initialization.as_ref().unwrap().phase, InitializationPhase::Failed);
        assert!(runtime.service.session_initialization(id).await.unwrap().initialization.error.unwrap().contains("delete denied"));
        if pending {
            runtime.reply(&original, json!({})).await;
            tokio::time::sleep(Duration::from_millis(10)).await;
            assert!(runtime.requests("session.model.getCurrent").is_empty());
        }
        runtime.service.retry_session_initialization(id).await.unwrap();
        let retry = runtime.request("session.tools.initializeAndValidate", 2).await;
        runtime.reply(&retry, json!({})).await;
        assert!(initialization_phase(&runtime, id, InitializationPhase::Ready).await.session.unwrap().archived);
        assert!(runtime.requests("session.resume").is_empty());
        assert_eq!(runtime.requests("session.create").len(), 1);
        assert!(runtime.requests("session.send").is_empty());
    }
}

#[tokio::test]
async fn deferred_recovery_failed_delete_rolls_back_after_http_caller_cancels() {
    let runtime = mock_runtime();
    let created = runtime.service.create_session(new_session(true)).await.unwrap();
    let id = &created.session_id;
    initialization_phase(&runtime, id, InitializationPhase::Ready).await;
    runtime.hold("session.delete");
    let service = runtime.service.clone();
    let delete_id = id.clone();
    let caller = tokio::spawn(async move { service.delete_session(&delete_id).await });
    let deletion = runtime.request("session.delete", 1).await;
    caller.abort();
    let _ = caller.await;
    runtime.inject(json!({"jsonrpc":"2.0","id":deletion["id"],"error":{"code":-32000,"message":"retry deletion later"}})).await;
    tokio::time::timeout(Duration::from_secs(1), async {
        while runtime.service.initializations.read().await.deleted.contains(id) {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    }).await.unwrap();
    assert!(runtime.service.list_sessions().await.unwrap().iter().any(|item| item.session_id == *id));
    runtime.service.retry_session_initialization(id).await.unwrap();
    initialization_phase(&runtime, id, InitializationPhase::Ready).await;
}

#[tokio::test]
async fn deferred_recovery_retry_after_drain_uses_reconnected_mock_client_without_create() {
    for pending in [false, true] {
        let runtime = mock_runtime();
        runtime.processing.store(false, Ordering::Relaxed);
        if pending {
            runtime.hold("session.tools.initializeAndValidate");
        }
        let created = runtime.service.create_session(new_session(true)).await.unwrap();
        let id = &created.session_id;
        runtime.request("session.tools.initializeAndValidate", 1).await;
        if !pending {
            initialization_phase(&runtime, id, InitializationPhase::Ready).await;
        }
        assert!(runtime.service.drain(Duration::ZERO, false).await.unwrap().complete);
        assert!(runtime.service.retry_session_initialization(id).await.is_err());
        // Replace only the mocked transport; never launch a real SDK runtime.
        let reconnected = mock_runtime();
        *runtime.service.client.write().await = Some(reconnected.service.client().await.unwrap());
        runtime.service.accepting_work.store(true, Ordering::Relaxed);
        runtime.service.retry_session_initialization(id).await.unwrap();
        initialization_phase(&runtime, id, InitializationPhase::Ready).await;
        let resumed = reconnected.request("session.resume", 1).await;
        assert_eq!(resumed["params"]["sessionId"], *id);
        assert_eq!(resumed["params"]["continuePendingWork"], false);
        assert_eq!(runtime.requests("session.create").len(), 1);
        assert!(reconnected.requests("session.create").is_empty());
        assert!(reconnected.requests("session.send").is_empty());
    }
}

#[tokio::test]
async fn deferred_recovery_failed_reattach_stays_retryable_with_same_id() {
    let runtime = mock_runtime();
    let created = runtime.service.create_session(new_session(true)).await.unwrap();
    let id = &created.session_id;
    initialization_phase(&runtime, id, InitializationPhase::Ready).await;
    runtime.service.active.read().await[id].disconnect().await.unwrap();
    initialization_phase(&runtime, id, InitializationPhase::Failed).await;
    runtime.hold("session.resume");
    let service = runtime.service.clone();
    let retry_id = id.clone();
    let retry = tokio::spawn(async move { service.retry_session_initialization(&retry_id).await });
    let first = runtime.request("session.resume", 1).await;
    runtime.inject(json!({"jsonrpc":"2.0","id":first["id"],"error":{"code":-32000,"message":"reattach unavailable"}})).await;
    assert!(retry.await.unwrap().is_err());
    let failed = runtime.service.session_initialization(id).await.unwrap();
    assert_eq!(failed.initialization.phase, InitializationPhase::Failed);
    assert!(failed.initialization.error.unwrap().contains("reattach unavailable"));
    let service = runtime.service.clone();
    let retry_id = id.clone();
    let retry = tokio::spawn(async move { service.retry_session_initialization(&retry_id).await });
    let second = runtime.request("session.resume", 2).await;
    runtime.reply(&second, json!({"sessionId":id})).await;
    retry.await.unwrap().unwrap();
    initialization_phase(&runtime, id, InitializationPhase::Ready).await;
    assert_eq!(runtime.requests("session.create").len(), 1);
    assert!(runtime.requests("session.send").is_empty());
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
    let held_methods = Arc::new(Mutex::new(HashSet::<String>::new()));
    let runtime_held_methods = held_methods.clone();
    let task = tokio::spawn(async move {
        let mut read = BufReader::new(read);
        let mut names = HashMap::<String, Value>::new();
        let mut modes = HashMap::<String, Value>::new();
        let mut profile_mcp = HashMap::<String, Value>::new();
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
            if runtime_held_methods.lock().unwrap().contains(method) {
                continue;
            }
            let result = match method {
                "session.name.set" => {
                    names.insert(sid.into(), request["params"]["name"].clone());
                    json!({})
                }
                "session.name.get" => json!({"name":names.get(sid)}),
                "session.list" => json!({"sessions":[]}),
                "session.create" => {
                    if let Some(servers) = request["params"].get("mcpServers") {
                        profile_mcp.insert(sid.into(), servers.clone());
                    }
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
                    if let Some(servers) = request["params"].get("mcpServers") {
                        profile_mcp.insert(sid.into(), servers.clone());
                    }
                    if let Some(values) = request["params"]["excludedTools"].as_array() {
                        excluded.insert(sid.into(), values.clone());
                    }
                    if let Some(values) = request["params"]["availableTools"].as_array() {
                        available.insert(sid.into(), values.clone());
                    }
                    json!({"sessionId":sid})
                }
                "session.skills.reload" => json!({"warnings":[], "errors":[]}),
                "session.mcp.reload" | "session.cancelAllBackgroundAgents" => json!({}),
                "session.skills.list" => json!({"skills":[
                    {"name":"repo-review","description":"Review fixture code","enabled":true,"source":"project","path":"Q:\\fixture\\.github\\skills\\repo-review\\SKILL.md","userInvocable":true},
                    {"name":"disabled-fixture","description":"Not enabled","enabled":false,"source":"project","userInvocable":false}
                ]}),
                "session.tools.initializeAndValidate" => json!({}),
                "session.metadata.setWorkingDirectory" => json!({"workingDirectory":request["params"]["workingDirectory"]}),
                "session.delete" | "session.disconnect" | "session.destroy" | "session.abort" => json!({}),
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
                "session.queue.pendingItems" => json!({"items":[], "steeringMessages":[]}),
                "session.tasks.list" => json!({"tasks":[]}),
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
                "session.mcp.list" => json!({"servers":profile_mcp.get(sid)
                    .and_then(Value::as_object).into_iter().flat_map(|servers| servers.keys())
                    .map(|name| json!({"name":name,"status":"connected"})).collect::<Vec<_>>()}),
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
        initializations: RwLock::new(Default::default()),
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
                    initialization: None,
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
        profile_configuration: AsyncMutex::new(HashMap::new()),
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
        held_methods,
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
            name: None,
            model: None,
            reasoning_effort: None,
            reasoning_summary: None,
            context_tier: None,
            defer_initialization: false,
            profile_id: None,
            profile_revision: None,
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
            name: None,
            model: None,
            reasoning_effort: None,
            reasoning_summary: None,
            context_tier: None,
            defer_initialization: false,
            profile_id: None,
            profile_revision: None,
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
    assert_eq!(serde_json::to_value(accepted).unwrap(), json!("accepted-without-reply"));
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
