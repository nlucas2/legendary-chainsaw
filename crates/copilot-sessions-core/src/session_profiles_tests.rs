use super::*;
use crate::profiles::{SaveProfileGroup, SaveSessionProfile};
use crate::session_profiles::{PreviewSessionProfile, SetSessionProfile};

async fn setup(runtime: &MockRuntime) -> (String, String, PathBuf) {
    runtime.service.metadata.write().await.get_mut("a").unwrap().cwd = Some(".".into());
    runtime.service.resume_session("a".into()).await.unwrap();
    let source = std::fs::canonicalize(&runtime.metadata_dir).unwrap().join("fixture-mcp.json");
    std::fs::write(&source, r#"{"mcpServers":{}}"#).unwrap();
    let library = runtime.service.profile_library().unwrap();
    let snapshot = library.snapshot().unwrap();
    let snapshot = library.save_group(SaveProfileGroup {
        id: None, name: "Fixture sources".into(),
        mcp_config_files: vec![source.to_string_lossy().into()], skill_directories: vec![],
        expected_revision: snapshot.revision,
    }).unwrap();
    let snapshot = library.save_profile(SaveSessionProfile {
        id: None, name: "Fixture profile".into(), group_ids: vec![snapshot.groups[0].id.clone()],
        expected_revision: snapshot.revision,
    }).unwrap();
    let id = snapshot.profiles[0].id.clone();
    let preview = runtime.service.preview_session_profile(PreviewSessionProfile {
        session_id: Some("a".into()), profile_id: Some(id.clone()), cwd: ".".into(),
    }).await.unwrap();
    (id, preview["revision"].as_str().unwrap().into(), source)
}

fn change(profile: &str, revision: &str) -> SetSessionProfile {
    SetSessionProfile { session_id: "a".into(), profile_id: Some(profile.into()), revision: revision.into() }
}

fn message() -> SendMessageRequest {
    serde_json::from_value(json!({"sessionId":"a","content":"Keep normal message semantics","deliveryMode":"enqueue"})).unwrap()
}

#[tokio::test]
async fn profile_applies_immediately_when_idle_and_preserves_handle_and_other_sessions() {
    let runtime = mock_runtime();
    let (profile, revision, _) = setup(&runtime).await;
    runtime.processing.store(false, Ordering::Relaxed);
    let original = runtime.service.active.read().await["a"].clone();
    let status = runtime.service.set_session_profile(change(&profile, &revision)).await.unwrap();
    assert_eq!(status["profile"]["id"], profile);
    assert_eq!(status["applying"], false);
    assert_eq!(status["configurationBlocked"], false);
    assert!(Arc::ptr_eq(&original, &runtime.service.active.read().await["a"]));
    assert_eq!(runtime.requests("session.mcp.reload").len(), 1);
    assert_eq!(runtime.requests("session.mcp.reload")[0]["params"]["sessionId"], "a");
    assert!(runtime.requests("session.send").is_empty());
    assert!(!runtime.metadata_dir.join("profile-operations.json").exists());
}

#[tokio::test]
async fn profile_busy_change_is_rejected_not_queued_or_automatically_retried() {
    let runtime = mock_runtime();
    let (profile, revision, _) = setup(&runtime).await;
    assert!(matches!(runtime.service.set_session_profile(change(&profile, &revision)).await,
        Err(ServiceError::SessionProcessing(_))));
    runtime.processing.store(false, Ordering::Relaxed);
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(runtime.requests("session.mcp.reload").is_empty());
    assert_eq!(runtime.service.get_session_profile("a").await.unwrap()["applying"], false);
    runtime.service.set_session_profile(change(&profile, &revision)).await.unwrap();
    assert_eq!(runtime.requests("session.mcp.reload").len(), 1);
}

#[tokio::test]
async fn profile_rejects_running_subagents_without_cancelling_them() {
    let runtime = mock_runtime();
    let (profile, revision, _) = setup(&runtime).await;
    runtime.processing.store(false, Ordering::Relaxed);
    runtime.hold("session.tasks.list");
    let service = runtime.service.clone();
    let apply = tokio::spawn(async move { service.set_session_profile(change(&profile, &revision)).await });
    let tasks = runtime.request("session.tasks.list", 1).await;
    runtime.reply(&tasks, json!({"tasks":[{"id":"child","type":"agent","status":"running"}]})).await;
    assert!(matches!(apply.await.unwrap(), Err(ServiceError::SessionProcessing(_))));
    assert!(runtime.requests("session.abort").is_empty());
    assert!(runtime.requests("session.cancelAllBackgroundAgents").is_empty());
    assert!(runtime.requests("session.mcp.reload").is_empty());
}

#[tokio::test]
async fn profile_does_not_reorder_or_replace_the_existing_native_queue() {
    let runtime = mock_runtime();
    let (profile, revision, _) = setup(&runtime).await;
    runtime.processing.store(false, Ordering::Relaxed);
    runtime.hold("session.queue.pendingItems");
    let service = runtime.service.clone();
    let apply = tokio::spawn(async move { service.set_session_profile(change(&profile, &revision)).await });
    let queue = runtime.request("session.queue.pendingItems", 1).await;
    runtime.reply(&queue, json!({"items":[{"id":"native","displayText":"Prior work","kind":"message","agentMode":"interactive"}],"steeringMessages":[]})).await;
    assert!(matches!(apply.await.unwrap(), Err(ServiceError::SessionProcessing(_))));
    assert!(runtime.requests("session.mcp.reload").is_empty());
    assert!(runtime.requests("session.queue.removeAt").is_empty());
}

#[tokio::test]
async fn profile_source_and_cwd_changes_require_a_new_preview() {
    let runtime = mock_runtime();
    let (profile, revision, source) = setup(&runtime).await;
    runtime.processing.store(false, Ordering::Relaxed);
    std::fs::write(&source, r#"{ "mcpServers": {} }"#).unwrap();
    assert!(runtime.service.set_session_profile(change(&profile, &revision)).await.is_err());
    assert!(runtime.requests("session.mcp.reload").is_empty());
    let preview = runtime.service.preview_session_profile(PreviewSessionProfile {
        session_id: Some("a".into()), profile_id: Some(profile.clone()), cwd: ".".into(),
    }).await.unwrap();
    runtime.service.metadata.write().await.get_mut("a").unwrap().cwd = Some("..".into());
    assert!(runtime.service.set_session_profile(change(&profile, preview["revision"].as_str().unwrap())).await.is_err());
    assert!(runtime.requests("session.mcp.reload").is_empty());
}

#[tokio::test]
async fn profile_application_temporarily_blocks_sends_without_accepting_or_storing_messages() {
    let runtime = mock_runtime();
    let (profile, revision, _) = setup(&runtime).await;
    runtime.processing.store(false, Ordering::Relaxed);
    runtime.hold("session.mcp.reload");
    let service = runtime.service.clone();
    let apply = tokio::spawn(async move { service.set_session_profile(change(&profile, &revision)).await });
    let reload = runtime.request("session.mcp.reload", 1).await;
    assert_eq!(runtime.service.get_session_profile("a").await.unwrap()["applying"], true);
    assert!(matches!(runtime.service.submit_message(message()).await, Err(ServiceError::SessionNotReady { .. })));
    assert!(runtime.requests("session.send").is_empty());
    runtime.reply(&reload, json!({})).await;
    apply.await.unwrap().unwrap();
    assert_eq!(runtime.service.submit_message(message()).await.unwrap(), "accepted-without-reply");
    assert!(!runtime.metadata_dir.join("profile-operations.json").exists());
}

#[tokio::test]
async fn profile_failed_application_restores_known_previous_sources_without_sending() {
    let runtime = mock_runtime();
    let (profile, revision, _) = setup(&runtime).await;
    runtime.processing.store(false, Ordering::Relaxed);
    runtime.hold("session.mcp.reload");
    let service = runtime.service.clone();
    let apply = tokio::spawn(async move { service.set_session_profile(change(&profile, &revision)).await });
    let reload = runtime.request("session.mcp.reload", 1).await;
    runtime.held_methods.lock().unwrap().remove("session.mcp.reload");
    runtime.inject(json!({"jsonrpc":"2.0","id":reload["id"],"error":{"code":-32000,"message":"Fixture reload failure"}})).await;
    assert!(apply.await.unwrap().is_err());
    let state = runtime.service.get_session_profile("a").await.unwrap();
    assert_eq!(state["applying"], false);
    assert_eq!(state["configurationBlocked"], false);
    assert!(state["error"].as_str().unwrap().contains("restored"));
    assert!(runtime.requests("session.send").is_empty());
}

#[tokio::test]
async fn profile_failure_without_known_rollback_blocks_sends_and_allows_explicit_repair() {
    let runtime = mock_runtime();
    let (profile, revision, _) = setup(&runtime).await;
    runtime.service.metadata.write().await.get_mut("a").unwrap().tool_controls_created = false;
    runtime.processing.store(false, Ordering::Relaxed);
    runtime.hold("session.mcp.reload");
    let service = runtime.service.clone();
    let input = change(&profile, &revision);
    let apply = tokio::spawn(async move { service.set_session_profile(input).await });
    let reload = runtime.request("session.mcp.reload", 1).await;
    runtime.held_methods.lock().unwrap().remove("session.mcp.reload");
    runtime.inject(json!({"jsonrpc":"2.0","id":reload["id"],"error":{"code":-32000,"message":"Fixture reload failure"}})).await;
    assert!(apply.await.unwrap().is_err());
    assert_eq!(runtime.service.get_session_profile("a").await.unwrap()["configurationBlocked"], true);
    assert!(runtime.service.submit_message(message()).await.is_err());
    runtime.service.set_session_profile(change(&profile, &revision)).await.unwrap();
    assert_eq!(runtime.service.get_session_profile("a").await.unwrap()["configurationBlocked"], false);
}

#[tokio::test]
async fn profile_create_and_resume_retain_approved_sources_without_a_message_store() {
    let runtime = mock_runtime();
    let (profile, _, source) = setup(&runtime).await;
    std::fs::write(source, r#"{"mcpServers":{"fixture":{"command":"node","args":["fixture.cjs"],"env":{"KEY":"synthetic-value"}}}}"#).unwrap();
    let preview = runtime.service.preview_session_profile(PreviewSessionProfile {
        session_id: None, profile_id: Some(profile.clone()), cwd: ".".into(),
    }).await.unwrap();
    let created = runtime.service.create_session(serde_json::from_value(json!({
        "cwd":".","profileId":profile,"profileRevision":preview["revision"],
    })).unwrap()).await.unwrap();
    let call = runtime.requests("session.create")[0].clone();
    assert_eq!(call["params"]["mcpServers"]["fixture"]["command"], "node");
    let metadata = std::fs::read_to_string(&runtime.service.metadata_path).unwrap();
    assert!(!metadata.contains("synthetic-value"));
    runtime.service.active.write().await.remove(&created.session_id);
    runtime.service.resume_session(created.session_id.clone()).await.unwrap();
    let resumed = runtime.requests("session.resume").last().unwrap().clone();
    assert_eq!(resumed["params"]["mcpServers"]["fixture"]["command"], "node");
    assert!(!runtime.metadata_dir.join("profile-operations.json").exists());
}

#[test]
fn profile_change_request_has_no_queue_mode_or_cancellation_identity() {
    assert!(serde_json::from_value::<SetSessionProfile>(json!({
        "sessionId":"a","profileId":null,"revision":"r",
    })).is_ok());
    assert!(serde_json::from_value::<SetSessionProfile>(json!({
        "sessionId":"a","profileId":null,"revision":"r","mode":"whenIdle",
    })).is_err());
}
