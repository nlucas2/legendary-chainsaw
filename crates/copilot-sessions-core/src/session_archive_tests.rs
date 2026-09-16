//! Disconnected services and project-local metadata only; never native sessions.
use std::sync::atomic::AtomicU64;

use serde_json::{Value, json};

use crate::*;

struct Fixture {
    service: Arc<SessionService>,
    directory: PathBuf,
}

impl Fixture {
    async fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let directory = PathBuf::from("target")
            .join("session-archive-tests")
            .join(format!(
                "{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        std::fs::create_dir_all(&directory).unwrap();
        let events = EventBus::new();
        let service = Arc::new(SessionService {
            client: RwLock::new(None),
            accepting_work: AtomicBool::new(false),
            active: RwLock::new(HashMap::new()),
            warmed: RwLock::new(HashSet::new()),
            turn_gates: RwLock::new(HashMap::new()),
            ask_gates: RwLock::new(HashMap::new()),
            last_submissions: RwLock::new(HashMap::new()),
            create_gate: AsyncMutex::new(()),
            runtime_gate: AsyncMutex::new(()),
            lifecycle_gate: RwLock::new(()),
            session_cache: RwLock::new(vec![serde_json::from_value(legacy_summary()).unwrap()]),
            events: events.clone(),
            approvals: Arc::new(ApprovalBroker {
                events: events.clone(),
                pending: Mutex::new(HashMap::new()),
            }),
            interactions: Arc::new(interactions::InteractionBroker::new(events)),
            tool_state: RwLock::new(HashMap::new()),
            tool_catalog: tool_catalog::ToolCatalog::default(),
            metadata_path: directory.join("sessions.json"),
            metadata: RwLock::new(HashMap::from([
                (
                    "a".into(),
                    serde_json::from_value(legacy_metadata()).unwrap(),
                ),
                ("other".into(), StoredSessionMeta::default()),
            ])),
            metadata_write_gate: AsyncMutex::new(()),
        });
        service.persist_metadata().await.unwrap();
        Self { service, directory }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

fn legacy_summary() -> Value {
    json!({
        "sessionId":"a", "title":"Original", "startTime":"start", "modifiedTime":"modified",
        "cwd":".", "model":"model", "isActive":false, "isRemote":true,
        "pinned":true, "folder":"Folder", "tags":["tag"]
    })
}

fn legacy_metadata() -> Value {
    json!({
        "cwd":".", "model":"model", "reasoningEffort":"low", "reasoningSummary":"detailed",
        "contextTier":"long_context", "title":"Original", "pinned":true,
        "folder":"Folder", "tags":["tag"], "toolExclusions":["builtin:blocked"],
        "toolControlsManaged":true, "toolControlsCreated":true,
        "toolAvailableTools":["builtin:allowed"], "preventPendingWork":true
    })
}

fn update(archived: bool) -> SetSessionArchived {
    SetSessionArchived {
        session_id: "a".into(),
        archived,
    }
}

fn without_archive<T: Serialize>(value: T) -> Value {
    let mut value = serde_json::to_value(value).unwrap();
    value.as_object_mut().unwrap().remove("archived");
    value
}

#[test]
fn archive_legacy_metadata_and_summaries_default_false() {
    let meta: StoredSessionMeta = serde_json::from_value(legacy_metadata()).unwrap();
    let summary: SessionSummary = serde_json::from_value(legacy_summary()).unwrap();
    assert!(!meta.archived);
    assert!(!summary.archived);
    assert!(
        !serde_json::from_str::<StoredSessionMeta>("{}")
            .unwrap()
            .archived
    );
    assert_eq!(serde_json::to_value(meta).unwrap()["archived"], false);
    assert_eq!(serde_json::to_value(summary).unwrap()["archived"], false);
}

#[tokio::test]
async fn archive_restore_roundtrip_preserves_every_other_field_and_publishes_narrow_events() {
    let fixture = Fixture::new().await;
    let service = &fixture.service;
    let mut first_client = service.subscribe(None);
    let mut second_client = service.subscribe(None);
    for archived in [true, false, true, true, false] {
        let summary = service
            .set_session_archived(update(archived))
            .await
            .unwrap();
        assert_eq!(summary.archived, archived);
        assert_eq!(without_archive(summary), legacy_summary());
        let disk = load_metadata(&service.metadata_path);
        assert_eq!(disk["a"].archived, archived);
        assert_eq!(without_archive(&disk["a"]), legacy_metadata());
        assert_eq!(
            serde_json::to_value(&*service.metadata.read().await).unwrap(),
            serde_json::to_value(disk).unwrap()
        );
        let listed = service.list_sessions().await.unwrap();
        assert_eq!(listed.len(), 1, "archive must not filter the daemon list");
        assert_eq!(listed[0].archived, archived);
        for client in [&mut first_client, &mut second_client] {
            let envelope = tokio::time::timeout(Duration::from_secs(1), client.recv())
                .await
                .unwrap()
                .unwrap();
            let expected =
                json!({"type":"session_archive_changed","sessionId":"a","archived":archived});
            assert_eq!(serde_json::to_value(&envelope.event).unwrap(), expected);
            for diagnostics in [false, true] {
                assert_eq!(
                    serde_json::to_value(
                        project_app_event(envelope.clone(), diagnostics)
                            .unwrap()
                            .event
                    )
                    .unwrap(),
                    expected
                );
            }
        }
    }
    assert!(service.client.read().await.is_none());
    assert!(service.active.read().await.is_empty());
    assert!(service.turn_gates.read().await.is_empty());
    assert!(service.ask_gates.read().await.is_empty());
    assert!(service.warmed.read().await.is_empty());
    assert_eq!(service.events.state.lock().unwrap().history.len(), 5);
}

#[tokio::test]
async fn archive_accepts_unopened_cache_only_and_persisted_metadata_only_sessions() {
    let fixture = Fixture::new().await;
    let service = &fixture.service;
    service.metadata.write().await.remove("a");
    assert!(
        service
            .set_session_archived(update(true))
            .await
            .unwrap()
            .archived
    );
    assert!(load_metadata(&service.metadata_path)["a"].archived);
    *service.metadata.write().await = HashMap::from([(
        "a".into(),
        serde_json::from_value(legacy_metadata()).unwrap(),
    )]);
    service.session_cache.write().await.clear();
    let summary = service.set_session_archived(update(true)).await.unwrap();
    assert_eq!(summary.title, "Original");
    assert_eq!(summary.folder.as_deref(), Some("Folder"));
    assert_eq!(summary.tags, ["tag"]);
    assert!(summary.pinned && summary.archived);
    assert!(!summary.is_active);
    assert_eq!(service.list_sessions().await.unwrap().len(), 1);
}

#[tokio::test]
async fn archive_rejects_unknown_and_malformed_ids_without_mutations() {
    let fixture = Fixture::new().await;
    let service = &fixture.service;
    let before = std::fs::read(&service.metadata_path).unwrap();
    for id in ["", " ", " a", "a ", "a\nb", "\0", "unknown"] {
        assert!(matches!(
            service
                .set_session_archived(SetSessionArchived {
                    session_id: id.into(),
                    archived: true,
                })
                .await,
            Err(ServiceError::InvalidArgument(_))
        ));
    }
    assert_eq!(std::fs::read(&service.metadata_path).unwrap(), before);
    assert!(!service.metadata.read().await["a"].archived);
    assert!(!service.session_cache.read().await[0].archived);
    assert!(service.events.state.lock().unwrap().history.is_empty());
}

#[tokio::test]
async fn archive_staging_failure_leaves_disk_memory_cache_and_events_unchanged() {
    let fixture = Fixture::new().await;
    let service = &fixture.service;
    let before = std::fs::read(&service.metadata_path).unwrap();
    let staging = service.metadata_path.with_extension("json.tmp");
    std::fs::create_dir(&staging).unwrap();
    assert!(matches!(
        service.set_session_archived(update(true)).await,
        Err(ServiceError::Persistence(_))
    ));
    assert_eq!(std::fs::read(&service.metadata_path).unwrap(), before);
    assert!(!service.metadata.read().await["a"].archived);
    assert!(!service.session_cache.read().await[0].archived);
    assert!(service.events.state.lock().unwrap().history.is_empty());
    std::fs::remove_dir(staging).unwrap();
    assert!(
        service
            .set_session_archived(update(true))
            .await
            .unwrap()
            .archived
    );
}

#[tokio::test]
async fn archive_replace_failure_does_not_unarchive_or_emit_success_and_cleans_staging() {
    let fixture = Fixture::new().await;
    let service = &fixture.service;
    service.set_session_archived(update(true)).await.unwrap();
    let backup = fixture.directory.join("saved.json");
    std::fs::rename(&service.metadata_path, &backup).unwrap();
    std::fs::create_dir(&service.metadata_path).unwrap();
    assert!(matches!(
        service.set_session_archived(update(false)).await,
        Err(ServiceError::Persistence(_))
    ));
    assert!(load_metadata(&backup)["a"].archived);
    assert!(service.metadata.read().await["a"].archived);
    assert!(service.session_cache.read().await[0].archived);
    assert_eq!(service.events.state.lock().unwrap().history.len(), 1);
    assert!(!service.metadata_path.with_extension("json.tmp").exists());
    std::fs::remove_dir(&service.metadata_path).unwrap();
    std::fs::rename(backup, &service.metadata_path).unwrap();
    assert!(
        !service
            .set_session_archived(update(false))
            .await
            .unwrap()
            .archived
    );
}

#[tokio::test]
async fn archive_organization_updates_from_old_clients_preserve_flag() {
    let fixture = Fixture::new().await;
    let service = &fixture.service;
    service.set_session_archived(update(true)).await.unwrap();
    let request = serde_json::from_value::<OrganizationUpdate>(json!({
        "sessionId":"a", "pinned":false, "folder":" New folder ",
        "tags":[" zoo ", "Alpha", "alpha", ""]
    }))
    .unwrap();
    let summary = service.organize_session(request).await.unwrap();
    assert!(summary.archived);
    assert!(!summary.pinned);
    assert_eq!(summary.folder.as_deref(), Some("New folder"));
    assert_eq!(summary.tags, ["Alpha", "zoo"]);
    let restored = service.set_session_archived(update(false)).await.unwrap();
    assert!(!restored.archived);
    assert_eq!(without_archive(restored), without_archive(summary));
    let meta = load_metadata(&service.metadata_path).remove("a").unwrap();
    let mut expected = legacy_metadata();
    expected["pinned"] = json!(false);
    expected["folder"] = json!("New folder");
    expected["tags"] = json!(["Alpha", "zoo"]);
    assert_eq!(without_archive(meta), expected);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn archive_concurrent_toggles_organization_and_metadata_writes_preserve_other_fields() {
    let fixture = Fixture::new().await;
    let mut tasks = Vec::new();
    for index in 0..24 {
        let service = fixture.service.clone();
        tasks.push(tokio::spawn(async move {
            service
                .set_session_archived(update(index % 2 == 0))
                .await
                .unwrap();
        }));
        let service = fixture.service.clone();
        tasks.push(tokio::spawn(async move {
            service
                .organize_session(OrganizationUpdate {
                    session_id: "a".into(),
                    pinned: false,
                    folder: Some("Concurrent".into()),
                    tags: vec!["changed".into()],
                })
                .await
                .unwrap();
        }));
        let service = fixture.service.clone();
        tasks.push(tokio::spawn(async move {
            // Match runtime preference writers: field edit, followed by the
            // common snapshot persistence path.
            service.metadata.write().await.get_mut("a").unwrap().model = Some("new-model".into());
            service.persist_metadata().await.unwrap();
        }));
    }
    tokio::time::timeout(Duration::from_secs(15), async {
        for task in tasks {
            task.await.unwrap();
        }
    })
    .await
    .unwrap();
    let service = &fixture.service;
    let disk = load_metadata(&service.metadata_path);
    assert_eq!(
        serde_json::to_value(&disk).unwrap(),
        serde_json::to_value(&*service.metadata.read().await).unwrap()
    );
    let meta = &disk["a"];
    assert!(!meta.pinned);
    assert_eq!(meta.folder.as_deref(), Some("Concurrent"));
    assert_eq!(meta.tags, ["changed"]);
    assert_eq!(meta.model.as_deref(), Some("new-model"));
    assert_eq!(meta.tool_exclusions, ["builtin:blocked"]);
    assert!(meta.prevent_pending_work);
    assert_eq!(disk.len(), 2);
    assert_eq!(
        service.session_cache.read().await[0].archived,
        meta.archived
    );
    let events = service.events.state.lock().unwrap();
    assert_eq!(events.history.len(), 24);
    assert_eq!(
        serde_json::to_value(&events.history.back().unwrap().event).unwrap(),
        json!({"type":"session_archive_changed","sessionId":"a","archived":meta.archived})
    );
}
