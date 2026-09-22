use super::*;

async fn prepared() -> MockRuntime {
    let runtime = mock_runtime();
    runtime.processing.store(false, Ordering::Relaxed);
    runtime.service.resume_session("a".into()).await.unwrap();
    runtime.service.metadata.write().await.get_mut("a").unwrap().cwd = Some(".".into());
    runtime
}

fn request(cwd: &str) -> ReloadSessionSkills {
    ReloadSessionSkills { session_id: "a".into(), cwd: cwd.into() }
}

#[tokio::test]
async fn session_skills_reads_effective_session_without_global_discovery_or_mutation() {
    let runtime = prepared().await;
    let reloads = runtime.requests("session.skills.reload").len();
    let snapshot = runtime.service.session_skills("a").await.unwrap();
    assert_eq!(snapshot.session_id, "a");
    assert_eq!(snapshot.cwd.as_deref(), Some("."));
    assert_eq!(snapshot.skills.len(), 2);
    assert!(!snapshot.skills[1].enabled);
    assert_eq!(runtime.requests("session.skills.reload").len(), reloads);
    assert!(runtime.requests("skills.discover").is_empty());
    assert_eq!(runtime.requests("session.skills.list")[0]["params"]["sessionId"], "a");
}

#[tokio::test]
async fn session_skills_reload_preserves_disabled_state_and_other_sessions() {
    let runtime = prepared().await;
    let before = runtime.calls.lock().unwrap().len();
    let snapshot = runtime.service.reload_session_skills(request(".")).await.unwrap();
    assert!(snapshot.errors.is_empty());
    assert!(snapshot.warnings.is_empty());
    assert!(!snapshot.skills[1].enabled);
    let calls = runtime.calls.lock().unwrap();
    let mutations = calls[before..].iter().filter(|call| {
        !matches!(call["method"].as_str(), Some("session.metadata.isProcessing" | "session.queue.pendingItems"
            | "session.tasks.list" | "session.skills.list" | "session.eventLog.read"))
    }).collect::<Vec<_>>();
    assert_eq!(mutations.len(), 2);
    assert_eq!(mutations[0]["method"], "session.resume");
    assert_eq!(mutations[0]["params"]["sessionId"], "a");
    assert_eq!(mutations[0]["params"]["enableConfigDiscovery"], true);
    assert_eq!(mutations[0]["params"]["continuePendingWork"], false);
    assert_eq!(mutations[0]["params"]["requestPermission"], true);
    assert!(mutations[0]["params"].get("availableTools").is_none());
    assert!(mutations[0]["params"].get("disabledSkills").is_none());
    assert_eq!(mutations[1]["method"], "session.skills.reload");
    assert_eq!(mutations[1]["params"], json!({"sessionId":"a"}));
}

#[tokio::test]
async fn session_skills_reload_rejects_stale_cwd_busy_and_draining() {
    let runtime = prepared().await;
    let before = runtime.requests("session.skills.reload").len();
    assert!(matches!(runtime.service.reload_session_skills(request("stale")).await, Err(ServiceError::InvalidArgument(_))));
    runtime.processing.store(true, Ordering::Relaxed);
    assert!(matches!(runtime.service.reload_session_skills(request(".")).await, Err(ServiceError::SessionProcessing(_))));
    runtime.processing.store(false, Ordering::Relaxed);
    runtime.service.accepting_work.store(false, Ordering::Relaxed);
    assert!(matches!(runtime.service.reload_session_skills(request(".")).await, Err(ServiceError::Draining)));
    assert_eq!(runtime.requests("session.skills.reload").len(), before);
}

#[tokio::test]
async fn session_skills_reload_rejects_running_background_tasks() {
    let runtime = prepared().await;
    runtime.hold("session.tasks.list");
    let service = runtime.service.clone();
    let job = tokio::spawn(async move { service.reload_session_skills(request(".")).await });
    let call = runtime.request("session.tasks.list", 1).await;
    runtime.reply(&call, json!({"tasks":[{"id":"child","status":"running","type":"agent"}]})).await;
    assert!(matches!(job.await.unwrap(), Err(ServiceError::SessionProcessing(_))));
}

#[tokio::test]
async fn session_skills_reload_exposes_native_warnings_and_errors() {
    let runtime = prepared().await;
    let before = runtime.requests("session.skills.reload").len();
    runtime.hold("session.skills.reload");
    let service = runtime.service.clone();
    let job = tokio::spawn(async move { service.reload_session_skills(request(".")).await });
    let call = runtime.request("session.skills.reload", before + 1).await;
    runtime.reply(&call, json!({"warnings":["Duplicate skill"],"errors":["Malformed SKILL.md"]})).await;
    let result = job.await.unwrap().unwrap();
    assert_eq!(result.warnings, ["Duplicate skill"]);
    assert_eq!(result.errors, ["Malformed SKILL.md"]);
    assert_eq!(result.skills.len(), 2);
}

#[tokio::test]
async fn session_skills_reload_serializes_against_working_directory_changes() {
    let runtime = prepared().await;
    let before = runtime.requests("session.skills.reload").len();
    runtime.hold("session.skills.reload");
    let service = runtime.service.clone();
    let job = tokio::spawn(async move { service.reload_session_skills(request(".")).await });
    let call = runtime.request("session.skills.reload", before + 1).await;
    assert!(runtime.service.turn_gate("a").await.try_lock().is_err());
    let service = runtime.service.clone();
    let change = tokio::spawn(async move { service.set_working_directory("a", "..".into()).await });
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(runtime.requests("session.metadata.setWorkingDirectory").is_empty());
    runtime.reply(&call, json!({"warnings":[],"errors":[]})).await;
    assert_eq!(job.await.unwrap().unwrap().cwd.as_deref(), Some("."));
    assert_eq!(change.await.unwrap().unwrap(), "..");
}

#[tokio::test]
async fn session_skills_preview_is_read_only_and_uses_current_cwd() {
    let runtime = prepared().await;
    runtime.hold("skills.discover");
    let before_resume = runtime.requests("session.resume").len();
    let before_reload = runtime.requests("session.skills.reload").len();
    let service = runtime.service.clone();
    let job = tokio::spawn(async move { service.preview_session_skills(request(".")).await });
    let call = runtime.request("skills.discover", 1).await;
    assert_eq!(call["params"]["projectPaths"], json!(["."]));
    assert_eq!(call["params"]["excludeHostSkills"], false);
    runtime.reply(&call, json!({"skills":[{
        "name":"new-skill","description":"New repo skill","source":"project",
        "path":"Q:\\fixture\\SKILL.md","enabled":true,"userInvocable":true
    }],"errors":[]})).await;
    let preview = job.await.unwrap().unwrap();
    assert_eq!(preview.added, ["new-skill"]);
    assert_eq!(preview.not_discovered, ["disabled-fixture", "repo-review"]);
    assert!(preview.changed.is_empty());
    assert_eq!(runtime.requests("session.resume").len(), before_resume);
    assert_eq!(runtime.requests("session.skills.reload").len(), before_reload);
}

#[test]
fn skill_diff_distinguishes_source_changes_without_overwriting_enablement() {
    use github_copilot_sdk::rpc::{ServerSkill, Skill};
    let current: Vec<Skill> = serde_json::from_value(json!([
        {"name":"same","description":"Kept","enabled":false,"source":"custom","path":"Q:\\group\\same\\SKILL.md","userInvocable":true},
        {"name":"removed","description":"Still a possible session source","enabled":true,"source":"custom","userInvocable":true}
    ])).unwrap();
    let discovered: Vec<ServerSkill> = serde_json::from_value(json!([
        {"name":"same","description":"Kept","enabled":true,"source":"project","path":"Q:\\repo\\same\\SKILL.md","userInvocable":true},
        {"name":"new","description":"New","enabled":true,"source":"project","userInvocable":true}
    ])).unwrap();
    let (added, changed, not_discovered) = crate::session_skills::skill_discovery_diff(&current, &discovered);
    assert_eq!(added, ["new"]);
    assert_eq!(changed, ["same"]);
    assert_eq!(not_discovered, ["removed"]);
    assert!(!current[0].enabled);
}
