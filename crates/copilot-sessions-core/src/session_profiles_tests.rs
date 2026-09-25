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
        excluded_skill_plugins: vec![],
        excluded_mcp_plugins: vec![],
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
async fn installed_plugins_reports_disabled_and_duplicate_names_without_internal_source_details() {
    let runtime = mock_runtime();
    runtime.hold("plugins.list");
    let service = runtime.service.clone();
    let read = tokio::spawn(async move { service.installed_plugins().await });
    let request = runtime.request("plugins.list", 1).await;
    runtime.reply(&request, json!({"plugins":[
        {"name":"fixture-z","marketplace":"","enabled":false,"directSourceId":"internal-id","installedFrom":"private-path"},
        {"name":"fixture-a","marketplace":"second","enabled":true,"version":"2"},
        {"name":"fixture-a","marketplace":"first","enabled":true,"version":"1"}
    ]})).await;
    assert_eq!(read.await.unwrap().unwrap(), json!({"plugins":[
        {"name":"fixture-a","marketplace":"first","enabled":true,"version":"1"},
        {"name":"fixture-a","marketplace":"second","enabled":true,"version":"2"},
        {"name":"fixture-z","marketplace":"","enabled":false,"version":null}
    ]}));
    assert!(runtime.requests("session.create").is_empty());
    assert!(runtime.requests("plugins.enable").is_empty());
}

#[tokio::test]
async fn installed_plugins_surfaces_runtime_errors_instead_of_claiming_empty_inventory() {
    let runtime = mock_runtime();
    runtime.hold("plugins.list");
    let service = runtime.service.clone();
    let read = tokio::spawn(async move { service.installed_plugins().await });
    let request = runtime.request("plugins.list", 1).await;
    runtime.inject(json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32601,"message":"Unsupported inventory"}})).await;
    assert!(read.await.unwrap().is_err());
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

#[tokio::test]
async fn profile_plugin_skills_apply_and_restore_without_global_plugin_changes() {
    let runtime = mock_runtime();
    let (profile, _, _) = setup(&runtime).await;
    runtime.processing.store(false, Ordering::Relaxed);
    runtime.plugin_skills.store(true, Ordering::Relaxed);
    let library = runtime.service.profile_library().unwrap();
    let current = library.snapshot().unwrap();
    let saved = library.save_profile(SaveSessionProfile {
        id: Some(profile.clone()), name: current.profiles[0].name.clone(),
        group_ids: current.profiles[0].group_ids.clone(), excluded_skill_plugins: vec!["fixture-alpha".into()],
        excluded_mcp_plugins: vec![],
        expected_revision: current.revision,
    }).unwrap();
    assert_eq!(saved.profiles[0].excluded_skill_plugins, ["fixture-alpha"]);
    let preview = runtime.service.preview_session_profile(PreviewSessionProfile {
        session_id: Some("a".into()), profile_id: Some(profile.clone()), cwd: ".".into(),
    }).await.unwrap();
    runtime.service.set_session_profile(change(&profile, preview["revision"].as_str().unwrap())).await.unwrap();
    assert!(!runtime.service.session_skills("a").await.unwrap().skills.iter().find(|s|s.name=="alpha-on").unwrap().enabled);
    let default = runtime.service.preview_session_profile(PreviewSessionProfile {
        session_id: Some("a".into()), profile_id: None, cwd: ".".into(),
    }).await.unwrap();
    runtime.service.set_session_profile(SetSessionProfile {
        session_id: "a".into(), profile_id: None, revision: default["revision"].as_str().unwrap().into(),
    }).await.unwrap();
    let skills = runtime.service.session_skills("a").await.unwrap().skills;
    assert!(skills.iter().find(|s|s.name=="alpha-on").unwrap().enabled);
    assert!(!skills.iter().find(|s|s.name=="alpha-off").unwrap().enabled);
    assert!(runtime.requests("plugins.disable").is_empty());
    assert!(runtime.requests("session.mcp.disable").is_empty());
    assert!(load_metadata(&runtime.service.metadata_path)["a"].profile_disabled_skills.is_empty());
}

#[tokio::test]
async fn profile_plugin_skills_apply_before_new_session_ready_and_after_resume() {
    let runtime = mock_runtime();
    let (profile, _, _) = setup(&runtime).await;
    let library = runtime.service.profile_library().unwrap();
    let current = library.snapshot().unwrap();
    library.save_profile(SaveSessionProfile {
        id: Some(profile.clone()), name: current.profiles[0].name.clone(),
        group_ids: current.profiles[0].group_ids.clone(), excluded_skill_plugins: vec!["fixture-alpha".into()],
        excluded_mcp_plugins: vec![],
        expected_revision: current.revision,
    }).unwrap();
    runtime.plugin_skills.store(true, Ordering::Relaxed);
    let preview = runtime.service.preview_session_profile(PreviewSessionProfile {
        session_id: None, profile_id: Some(profile.clone()), cwd: ".".into(),
    }).await.unwrap();
    let created = runtime.service.create_session(serde_json::from_value(json!({
        "cwd":".","profileId":profile,"profileRevision":preview["revision"],"deferInitialization":true,
    })).unwrap()).await.unwrap();
    initialization_phase(&runtime, &created.session_id, InitializationPhase::Ready).await;
    let skills = runtime.service.session_skills(&created.session_id).await.unwrap().skills;
    assert!(!skills.iter().find(|s|s.name=="alpha-on").unwrap().enabled);
    // Simulate a newly loaded runtime that no longer has the prior disabled flag.
    runtime.service.active.read().await[&created.session_id].rpc().skills()
        .enable(github_copilot_sdk::rpc::SkillsEnableRequest { name:"alpha-on".into() }).await.unwrap();
    runtime.service.active.write().await.remove(&created.session_id);
    // Non-deferred resume uses the same policy; this also exercises saved ownership.
    runtime.service.initializations.write().await.runs.remove(&created.session_id);
    runtime.service.resume_session(created.session_id.clone()).await.unwrap();
    assert!(!runtime.service.session_skills(&created.session_id).await.unwrap().skills.iter().find(|s|s.name=="alpha-on").unwrap().enabled);
}

async fn mcp_profile(runtime: &MockRuntime) -> (String, Value) {
    let (profile, _, _) = setup(runtime).await;
    runtime.processing.store(false, Ordering::Relaxed);
    runtime.plugin_mcps.store(true, Ordering::Relaxed);
    let library = runtime.service.profile_library().unwrap();
    let current = library.snapshot().unwrap();
    library.save_profile(SaveSessionProfile {
        id: Some(profile.clone()), name: "MCP exclusions".into(), group_ids: current.profiles[0].group_ids.clone(),
        excluded_skill_plugins: vec![], excluded_mcp_plugins: vec!["fixture-alpha".into()], expected_revision: current.revision,
    }).unwrap();
    let preview = runtime.service.preview_session_profile(PreviewSessionProfile {
        session_id: Some("a".into()), profile_id: Some(profile.clone()), cwd: ".".into(),
    }).await.unwrap();
    (profile, preview)
}

#[tokio::test]
async fn profile_mcp_exclusions_preserve_base_and_preexisting_disables_and_restore_only_owned() {
    let runtime = mock_runtime();
    let (profile, preview) = mcp_profile(&runtime).await;
    assert!(!preview.to_string().contains("fixture-secret"));
    assert_eq!(preview["resolutionIssues"], json!([]));
    runtime.service.client().await.unwrap().call("session.mcp.disable", Some(json!({"sessionId":"a","serverName":"base-overlap"}))).await.unwrap();
    runtime.service.set_session_profile(change(&profile, preview["revision"].as_str().unwrap())).await.unwrap();
    let call = runtime.requests("session.resume").last().unwrap().clone();
    assert_eq!(call["params"]["disabledMcpServers"], json!(["base-overlap","only-plugin"]));
    assert_eq!(call["params"]["mcpServers"]["base-overlap"]["command"], "base-command");
    let persisted = load_metadata(&runtime.service.metadata_path);
    assert_eq!(persisted["a"].profile_mcps.as_ref().unwrap().owned, ["only-plugin"]);
    assert!(!std::fs::read_to_string(&runtime.service.metadata_path).unwrap().contains("fixture-secret"));
    let default = runtime.service.preview_session_profile(PreviewSessionProfile {
        session_id: Some("a".into()), profile_id: None, cwd: ".".into(),
    }).await.unwrap();
    runtime.service.set_session_profile(SetSessionProfile {
        session_id:"a".into(),profile_id:None,revision:default["revision"].as_str().unwrap().into(),
    }).await.unwrap();
    let call = runtime.requests("session.resume").last().unwrap().clone();
    assert_eq!(call["params"]["disabledMcpServers"], json!(["base-overlap"]));
    assert_eq!(call["params"]["mcpServers"], json!({}));
    assert!(load_metadata(&runtime.service.metadata_path)["a"].profile_mcps.as_ref().unwrap().owned.is_empty());
    assert!(runtime.requests("plugins.disable").is_empty());
    assert!(runtime.requests("mcp.config.set").is_empty());
}

#[tokio::test]
async fn profile_mcp_exclusions_apply_before_deferred_startup_and_on_resume() {
    let runtime = mock_runtime();
    let (profile, preview) = mcp_profile(&runtime).await;
    let created = runtime.service.create_session(serde_json::from_value(json!({
        "cwd":".","profileId":profile,"profileRevision":preview["revision"],"deferInitialization":true,
    })).unwrap()).await.unwrap();
    initialization_phase(&runtime, &created.session_id, InitializationPhase::Ready).await;
    let request = runtime.requests("session.create").last().unwrap().clone();
    assert_eq!(request["params"]["disabledMcpServers"],json!(["only-plugin"]));
    assert_eq!(request["params"]["mcpServers"]["base-overlap"]["command"],"base-command");
    runtime.service.active.write().await.remove(&created.session_id);
    runtime.service.initializations.write().await.runs.remove(&created.session_id);
    runtime.service.resume_session(created.session_id).await.unwrap();
    assert_eq!(runtime.requests("session.resume").last().unwrap()["params"]["disabledMcpServers"],json!(["only-plugin"]));
}

#[tokio::test]
async fn profile_mcp_source_changes_reject_stale_preview_before_any_mutation() {
    let runtime = mock_runtime();
    let (profile, preview) = mcp_profile(&runtime).await;
    runtime.hold("mcp.config.list");
    let service = runtime.service.clone();
    let apply = tokio::spawn(async move { service.set_session_profile(change(&profile,preview["revision"].as_str().unwrap())).await });
    let next = runtime.request("mcp.config.list", 2).await;
    runtime.reply(&next,json!({"servers":{"base-overlap":{"command":"changed-base"}}})).await;
    assert!(matches!(apply.await.unwrap(),Err(ServiceError::InvalidArgument(_))));
    assert!(runtime.requests("session.mcp.reload").is_empty());
}

#[tokio::test]
async fn profile_mcp_failed_apply_restores_exact_prior_disabled_set() {
    let runtime = mock_runtime();
    let (profile, preview) = mcp_profile(&runtime).await;
    runtime.service.client().await.unwrap().call("session.mcp.disable",Some(json!({"sessionId":"a","serverName":"only-plugin"}))).await.unwrap();
    runtime.hold("session.mcp.reload");
    let service = runtime.service.clone();
    let apply = tokio::spawn(async move { service.set_session_profile(change(&profile,preview["revision"].as_str().unwrap())).await });
    let reload = runtime.request("session.mcp.reload",1).await;
    runtime.held_methods.lock().unwrap().remove("session.mcp.reload");
    runtime.inject(json!({"jsonrpc":"2.0","id":reload["id"],"error":{"code":-32000,"message":"Synthetic reload error"}})).await;
    assert!(apply.await.unwrap().is_err());
    assert_eq!(runtime.service.get_session_profile("a").await.unwrap()["configurationBlocked"],false);
    assert_eq!(runtime.requests("session.resume").last().unwrap()["params"]["disabledMcpServers"],json!(["only-plugin"]));
}

#[tokio::test]
async fn profile_mcp_reload_and_cwd_changes_preserve_exclusions_and_manual_choices() {
    let runtime = mock_runtime();
    let (profile, preview) = mcp_profile(&runtime).await;
    runtime.service.set_session_profile(change(&profile,preview["revision"].as_str().unwrap())).await.unwrap();
    runtime.service.set_mcp_enabled(serde_json::from_value(json!({
        "sessionId":"a","serverName":"base-overlap","enabled":false,
    })).unwrap()).await.unwrap();
    assert!(runtime.service.set_mcp_enabled(serde_json::from_value(json!({
        "sessionId":"a","serverName":"only-plugin","enabled":true,
    })).unwrap()).await.is_err());
    let results = runtime.service.reload_mcp().await.unwrap();
    assert!(results.iter().all(|result|result.success));
    let state = load_metadata(&runtime.service.metadata_path)["a"].profile_mcps.clone().unwrap();
    assert_eq!(state.owned, ["only-plugin"]);
    assert_eq!(state.disabled, ["base-overlap","only-plugin"]);
    runtime.service.set_working_directory("a", "..".into()).await.unwrap();
    runtime.service.active.write().await.remove("a");
    runtime.service.resume_session("a".into()).await.unwrap();
    assert_eq!(runtime.requests("session.resume").last().unwrap()["params"]["disabledMcpServers"],json!(["base-overlap","only-plugin"]));
}

#[tokio::test]
async fn profile_mcp_first_application_saves_a_recovery_baseline_before_changing_filters() {
    let runtime = mock_runtime();
    let (profile, preview) = mcp_profile(&runtime).await;
    runtime.hold("session.mcp.reload");
    let service = runtime.service.clone();
    let apply = tokio::spawn(async move { service.set_session_profile(change(&profile,preview["revision"].as_str().unwrap())).await });
    let reload = runtime.request("session.mcp.reload",1).await;
    let saved = load_metadata(&runtime.service.metadata_path);
    let baseline = saved["a"].profile_mcps.as_ref().unwrap();
    assert!(baseline.disabled.is_empty());
    assert!(baseline.owned.is_empty());
    assert!(baseline.revision.is_empty());
    runtime.held_methods.lock().unwrap().remove("session.mcp.reload");
    runtime.inject(json!({"jsonrpc":"2.0","id":reload["id"],"error":{"code":-32000,"message":"Synthetic apply error"}})).await;
    assert!(apply.await.unwrap().is_err());
    // Model a resident runtime left with an unacknowledged filter after transport loss.
    runtime.service.client().await.unwrap().call("session.resume",Some(json!({
        "sessionId":"a","disabledMcpServers":["only-plugin"],
    }))).await.unwrap();
    runtime.service.profile_configuration.lock().await.insert("a".into(),crate::session_profiles::ProfileConfigurationState {
        blocked:true,requires_reconnect:true,..Default::default()
    });
    runtime.service.active.write().await.remove("a");
    runtime.service.resume_session("a".into()).await.unwrap();
    assert_eq!(runtime.requests("session.resume").last().unwrap()["params"]["disabledMcpServers"],json!([]));
    assert_eq!(crate::mcp_resolution::disabled_servers(&runtime.service.client().await.unwrap(),"a").await.unwrap(),Vec::<String>::new());
    assert_eq!(runtime.service.get_session_profile("a").await.unwrap()["configurationBlocked"],false);
}
