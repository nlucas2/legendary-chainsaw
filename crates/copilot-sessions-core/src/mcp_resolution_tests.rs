use super::*;

struct Fixture {
    root: std::path::PathBuf,
    profile: ResolvedProfile,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("copilot-mcp-{}", uuid::Uuid::new_v4()));
        let library = crate::profiles::ProfileLibrary::open(root.join("data")).unwrap();
        let mut profile = library.resolve(None).unwrap();
        profile.excluded_mcp_plugins = vec!["excluded-fixture".into()];
        Self { root, profile }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn sources() -> Vec<Source> {
    serde_json::from_value(json!([
        {"name":"only-plugin","source":"plugin","sourcePlugin":"excluded-fixture","enabled":true},
        {"name":"base-overlap","source":"plugin","sourcePlugin":"excluded-fixture","enabled":true},
        {"name":"profile-overlap","source":"plugin","sourcePlugin":"excluded-fixture","enabled":true},
        {"name":"included-winner","source":"plugin","sourcePlugin":"included-fixture","enabled":true},
        {"name":"user-disabled","source":"user","enabled":false}
    ])).unwrap()
}

#[test]
fn source_resolution_keeps_explicit_and_base_definitions_not_the_excluded_plugin() {
    let mut fixture = Fixture::new();
    fixture.profile.mcp_servers = serde_json::from_value(
        json!({"profile-overlap":{"type":"stdio","command":"explicit","tools":["*"]}}),
    )
    .unwrap();
    let base =
        json!({"base-overlap":{"command":"base","env":{"TOKEN":"fixture-secret"},"tools":["*"]}});
    let resolution = resolve_sources(
        &fixture.profile,
        &sources(),
        base.as_object().unwrap(),
        &HashMap::new(),
        &[],
    )
    .unwrap();
    resolution.require_resolved().unwrap();
    assert_eq!(resolution.disabled, ["only-plugin"]);
    let definitions = serde_json::to_value(resolution.definitions(&fixture.profile)).unwrap();
    assert_eq!(definitions["base-overlap"]["command"], "base");
    assert_eq!(definitions["profile-overlap"]["command"], "explicit");
    assert!(
        !serde_json::to_string(&resolution.decisions)
            .unwrap()
            .contains("fixture-secret")
    );
    let state = resolution.state(&["previous-choice".into(), "only-plugin".into()], &[]);
    assert!(
        state.owned.is_empty(),
        "do not own pre-existing disabled choices"
    );
    assert_eq!(
        state.disabled,
        ["only-plugin", "previous-choice", "user-disabled"]
    );
    let next = McpResolution::default().state(&state.disabled, &state.owned);
    assert!(next.disabled.contains(&"only-plugin".into()));
}

#[test]
fn only_profile_owned_names_are_removed_on_switch_and_base_changes_invalidate_approval() {
    let fixture = Fixture::new();
    let source: Vec<Source> = serde_json::from_value(json!([{"name":"only-plugin","source":"plugin","sourcePlugin":"excluded-fixture","enabled":true}])).unwrap();
    let first = resolve_sources(
        &fixture.profile,
        &source,
        &Default::default(),
        &Default::default(),
        &[],
    )
    .unwrap();
    let state = first.state(&["unrelated".into()], &[]);
    assert_eq!(state.owned, ["only-plugin"]);
    assert_eq!(
        McpResolution::default()
            .state(&state.disabled, &state.owned)
            .disabled,
        ["unrelated"]
    );
    let base = json!({"only-plugin":{"command":"independent"}});
    let second = resolve_sources(
        &fixture.profile,
        &source,
        base.as_object().unwrap(),
        &Default::default(),
        &[],
    )
    .unwrap();
    assert_ne!(first.revision, second.revision);
    assert!(second.disabled.is_empty());
    let changed = json!({"only-plugin":{"command":"new-independent"}});
    let third = resolve_sources(
        &fixture.profile,
        &source,
        changed.as_object().unwrap(),
        &Default::default(),
        &[],
    )
    .unwrap();
    assert_ne!(second.revision, third.revision);
}

#[test]
fn shadowed_repository_or_other_plugin_sources_are_blocked_instead_of_guessed() {
    let fixture = Fixture::new();
    let source: Vec<Source> = serde_json::from_value(json!([{"name":"only-plugin","source":"plugin","sourcePlugin":"excluded-fixture","enabled":true}])).unwrap();
    let workspace = HashMap::from([("only-plugin".into(), vec!["repo/.mcp.json".into()])]);
    let repo = resolve_sources(
        &fixture.profile,
        &source,
        &Default::default(),
        &workspace,
        &[],
    )
    .unwrap();
    assert!(repo.require_resolved().is_err());
    let plugin = resolve_sources(
        &fixture.profile,
        &source,
        &Default::default(),
        &Default::default(),
        &["included-fixture".into()],
    )
    .unwrap();
    assert!(plugin.require_resolved().is_err());
    assert!(plugin.disabled.is_empty());
    for entries in [
        json!([{"name":"unknown","source":"future","enabled":true}]),
        json!([{"name":"unknown","source":"plugin","enabled":true}]),
        json!([{"name":"same","source":"user","enabled":true},{"name":"same","source":"plugin","sourcePlugin":"excluded-fixture","enabled":true}]),
    ] {
        let resolution = resolve_sources(
            &fixture.profile,
            &serde_json::from_value::<Vec<Source>>(entries).unwrap(),
            &Default::default(),
            &Default::default(),
            &[],
        )
        .unwrap();
        assert!(resolution.require_resolved().is_err());
    }
}

#[test]
fn workspace_candidates_are_bounded_and_linked_profiles_establish_precedence() {
    let mut fixture = Fixture::new();
    let repo = fixture.root.join("repo");
    std::fs::create_dir_all(repo.join(".git")).unwrap();
    std::fs::create_dir_all(repo.join("child")).unwrap();
    std::fs::write(
        repo.join(".mcp.json"),
        r#"{"mcpServers":{"only-plugin":{"command":"repo"}}}"#,
    )
    .unwrap();
    std::fs::write(fixture.root.join(".mcp.json"), "not JSON outside repo").unwrap();
    let workspace = workspace_candidates(&repo.join("child")).unwrap();
    assert_eq!(workspace.len(), 1);
    fixture.profile.mcp_servers =
        serde_json::from_value(json!({"only-plugin":{"type":"stdio","command":"chosen-repo"}}))
            .unwrap();
    let source: Vec<Source> = serde_json::from_value(json!([{"name":"only-plugin","source":"plugin","sourcePlugin":"excluded-fixture","enabled":true}])).unwrap();
    let resolution = resolve_sources(
        &fixture.profile,
        &source,
        &Default::default(),
        &workspace,
        &["included-fixture".into()],
    )
    .unwrap();
    resolution.require_resolved().unwrap();
    assert!(resolution.disabled.is_empty());
}

#[test]
fn workspace_url_without_transport_does_not_block_unrelated_plugin_exclusions() {
    let fixture = Fixture::new();
    let repo = fixture.root.join("repo");
    std::fs::create_dir_all(repo.join(".git")).unwrap();
    std::fs::create_dir_all(repo.join("child")).unwrap();
    let file = repo.join(".mcp.json");
    let bytes = br#"{"mcpServers":{"repository-service":{"url":"https://example.invalid/mcp","headers":{"x-api-key":"fixture-secret"}}}}"#;
    std::fs::write(&file, bytes).unwrap();
    let workspace = workspace_candidates(&repo.join("child")).unwrap();
    assert_eq!(
        workspace["repository-service"],
        [std::fs::canonicalize(&file).unwrap().to_string_lossy().into_owned()]
    );
    let source: Vec<Source> = serde_json::from_value(json!([
        {"name":"only-plugin","source":"plugin","sourcePlugin":"excluded-fixture","enabled":true},
        {"name":"repository-service","source":"workspace","enabled":true}
    ])).unwrap();
    let resolution = resolve_sources(
        &fixture.profile,
        &source,
        &Default::default(),
        &workspace,
        &[],
    )
    .unwrap();
    resolution.require_resolved().unwrap();
    assert_eq!(resolution.disabled, ["only-plugin"]);
    assert!(resolution.overrides.is_empty());
    assert_eq!(std::fs::read(&file).unwrap(), bytes);
    let preview = serde_json::to_string(&resolution.decisions).unwrap();
    assert!(!preview.contains("fixture-secret"));
    assert!(!preview.contains("example.invalid"));
    let error = crate::profiles::parse_mcp(bytes, &file).unwrap_err().to_string();
    assert!(error.contains("must explicitly specify type http or sse"));
}

#[test]
fn workspace_name_discovery_keeps_shadowed_repository_definitions_blocked() {
    let mut fixture = Fixture::new();
    let repo = fixture.root.join("repo");
    std::fs::create_dir_all(repo.join(".git")).unwrap();
    std::fs::create_dir_all(repo.join(".github")).unwrap();
    for file in [repo.join(".mcp.json"), repo.join(".github").join("mcp.json")] {
        std::fs::write(
            &file,
            br#"{"mcpServers":{"only-plugin":{"url":"https://example.invalid/mcp"}}}"#,
        )
        .unwrap();
    }
    let workspace = workspace_candidates(&repo).unwrap();
    assert_eq!(workspace["only-plugin"].len(), 2);
    let source: Vec<Source> = serde_json::from_value(json!([
        {"name":"only-plugin","source":"plugin","sourcePlugin":"excluded-fixture","enabled":true}
    ])).unwrap();
    let resolution = resolve_sources(
        &fixture.profile,
        &source,
        &Default::default(),
        &workspace,
        &[],
    )
    .unwrap();
    assert!(resolution.require_resolved().is_err());
    assert_eq!(resolution.decisions[0].action, "unresolved");
    assert!(resolution.decisions[0].reason.contains("Repository also defines"));
    assert!(resolution.disabled.is_empty());
    assert!(resolution.overrides.is_empty());
    fixture.profile.mcp_servers =
        serde_json::from_value(json!({"only-plugin":{"type":"http","url":"https://example.invalid/chosen"}}))
            .unwrap();
    let explicit = resolve_sources(
        &fixture.profile,
        &source,
        &Default::default(),
        &workspace,
        &[],
    )
    .unwrap();
    explicit.require_resolved().unwrap();
    assert!(explicit.disabled.is_empty());
}

#[test]
fn workspace_name_discovery_ignores_transport_fields_but_retains_document_bounds() {
    let path = Path::new("repository.json");
    let bytes = b"\xef\xbb\xbf{\"$schema\":\"fixture\",\"mcpServers\":{\"remote\":{\"url\":\"https://example.invalid/mcp\",\"futureOption\":true},\"local\":{\"command\":\"__HOME__\\\\tool\",\"env\":{\"TOKEN\":123}}}}";
    let mut names = crate::profiles::parse_mcp_server_names(bytes, path).unwrap();
    names.sort();
    assert_eq!(names, ["local", "remote"]);
    assert!(crate::profiles::parse_mcp(bytes, path).is_err());
    for bytes in [
        b"not json".as_slice(),
        br#"[]"#,
        br#"{"servers":{}}"#,
        br#"{"mcpServers":[]}"#,
        br#"{"mcpServers":{"remote":null}}"#,
        br#"{"mcpServers":{"remote":"fixture-secret"}}"#,
        br#"{"mcpServers":{" bad ":{}}}"#,
        br#"{"mcpServers":{"bad\nname":{}}}"#,
    ] {
        let error = crate::profiles::parse_mcp_server_names(bytes, path).unwrap_err().to_string();
        assert!(!error.contains("fixture-secret"));
    }
    let oversized = vec![b' '; 2 * 1024 * 1024 + 1];
    assert!(crate::profiles::parse_mcp_server_names(&oversized, path)
        .unwrap_err().to_string().contains("exceeds 2 MiB"));
    let servers: serde_json::Map<String, Value> =
        (0..513).map(|index| (format!("server-{index}"), json!({}))).collect();
    let too_many = serde_json::to_vec(&json!({"mcpServers":servers})).unwrap();
    assert!(crate::profiles::parse_mcp_server_names(&too_many, path)
        .unwrap_err().to_string().contains("exceeds 512 servers"));
}

#[test]
fn workspace_name_discovery_does_not_silently_skip_malformed_files() {
    let fixture = Fixture::new();
    let repo = fixture.root.join("repo");
    std::fs::create_dir_all(repo.join(".git")).unwrap();
    let file = repo.join(".mcp.json");
    std::fs::write(&file, b"{ invalid").unwrap();
    let error = workspace_candidates(&repo).unwrap_err().to_string();
    assert!(error.contains("Malformed MCP JSON"));
    assert!(error.contains(".mcp.json"));
}

/// Explicit opt-in: starts the installed CLI with an isolated home, no account,
/// synthetic local plugins/MCPs only, and no inference or live daemon access.
#[tokio::test]
#[ignore = "requires the pinned Copilot CLI and Node; isolated native integration"]
async fn native_source_resolution_excludes_plugin_only_and_preserves_independent_implementations() {
    use crate::session_configuration::SessionConfiguration;
    use github_copilot_sdk::{ClientOptions, SessionConfig};
    let fixture = Fixture::new();
    let root = fixture.root.clone();
    for directory in ["home", "user", "repo", "plugin"] {
        std::fs::create_dir_all(root.join(directory)).unwrap();
    }
    std::fs::create_dir(root.join("repo").join(".git")).unwrap();
    let repository_mcp = root.join("repo").join(".mcp.json");
    let repository_bytes = br#"{"mcpServers":{"repository-service":{"url":"http://127.0.0.1:1/mcp","headers":{"x-api-key":"fixture-secret"}}}}"#;
    std::fs::write(&repository_mcp, repository_bytes).unwrap();
    let script = root.join("mcp.cjs");
    std::fs::write(&script, include_str!("fixtures/profile-mcp.cjs")).unwrap();
    let definition = |marker: &str| json!({"type":"stdio","command":"node","args":[script,marker],"tools":["*"]});
    let base = root.join("home").join("mcp-config.json");
    std::fs::write(
        &base,
        serde_json::to_vec(&json!({"mcpServers":{
            "base-overlap":definition("base"),"control":definition("control")
        }}))
        .unwrap(),
    )
    .unwrap();
    std::fs::write(root.join("plugin").join("plugin.json"), r#"{"name":"excluded-fixture","version":"1.0.0","description":"Synthetic exclusion fixture"}"#).unwrap();
    std::fs::write(root.join("plugin").join(".mcp.json"), serde_json::to_vec(&json!({"mcpServers":{
        "only-plugin":definition("pluginonly"),"base-overlap":definition("pluginbase"),"profile-overlap":definition("pluginprofile")
    }})).unwrap()).unwrap();
    let mut options = ClientOptions::default().with_base_directory(root.join("home"));
    options.working_directory = root.join("repo");
    options.use_logged_in_user = Some(false);
    options.env = vec![
        ("USERPROFILE".into(), root.join("user").into_os_string()),
        ("HOME".into(), root.join("user").into_os_string()),
        ("COPILOT_DISABLE_KEYTAR".into(), "1".into()),
    ];
    options.env_remove = [
        "COPILOT_CUSTOM_INSTRUCTIONS_DIRS",
        "COPILOT_SKILL_DIRS",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "COPILOT_GITHUB_TOKEN",
        "COPILOT_SDK_AUTH_TOKEN",
    ]
    .into_iter()
    .map(Into::into)
    .collect();
    let client = Client::start(options).await.unwrap();
    let running = client.clone();
    let mut profile = fixture.profile.clone();
    profile.mcp_servers =
        serde_json::from_value(json!({"profile-overlap":definition("explicit")})).unwrap();
    let mut task = tokio::spawn(async move {
        let client = running;
        client
            .call(
                "plugins.install",
                Some(json!({"source":root.join("plugin")})),
            )
            .await
            .unwrap();
        let globals = client.rpc().plugins().list().await.unwrap();
        let home_before = std::fs::read(root.join("home").join("config.json")).unwrap();
        let base_before = std::fs::read(&base).unwrap();
        let cwd = root.join("repo").to_string_lossy().into_owned();
        let ordinary = SessionConfig::default()
            .with_working_directory(&cwd)
            .with_config_directory(root.join("home"))
            .with_enable_config_discovery(true)
            .with_enable_file_hooks(false);
        let control = client.create_session(ordinary.clone()).await.unwrap();
        async fn has_marker(client: &Client, id: &str, name: &str, marker: &str) {
            let tools = client
                .call(
                    "session.mcp.listTools",
                    Some(json!({"sessionId":id,"serverName":name})),
                )
                .await
                .unwrap();
            assert!(
                tools.to_string().contains(&format!("probe_{marker}")),
                "{tools}"
            );
        }
        has_marker(&client, control.id().as_str(), "base-overlap", "pluginbase").await;
        let resolution = resolve(&client, &profile, &cwd).await.unwrap();
        resolution.require_resolved().unwrap();
        assert_eq!(resolution.disabled, ["only-plugin"]);
        let session = client
            .create_session(SessionConfiguration.configure_new_profile(
                ordinary,
                Some(&profile),
                &resolution,
            ))
            .await
            .unwrap();
        let id = session.id().as_str();
        verify_disabled(&client, id, &resolution.disabled)
            .await
            .unwrap();
        has_marker(&client, id, "base-overlap", "base").await;
        has_marker(&client, id, "profile-overlap", "explicit").await;
        has_marker(&client, id, "control", "control").await;
        let metadata = client
            .call(
                "session.tools.getCurrentMetadata",
                Some(json!({"sessionId":id})),
            )
            .await
            .unwrap();
        assert!(!metadata.to_string().contains("probe_pluginonly"));
        for method in ["session.mcp.reload", "session.plugins.reload"] {
            client
                .call(method, Some(json!({"sessionId":id})))
                .await
                .unwrap();
            verify_disabled(&client, id, &resolution.disabled)
                .await
                .unwrap();
            has_marker(&client, id, "base-overlap", "base").await;
        }
        client.call("session.resume",Some(json!({"sessionId":id,"enableConfigDiscovery":true,"continuePendingWork":false}))).await.unwrap();
        verify_disabled(&client, id, &resolution.disabled)
            .await
            .unwrap();
        has_marker(&client, control.id().as_str(), "only-plugin", "pluginonly").await;
        has_marker(&client, control.id().as_str(), "base-overlap", "pluginbase").await;
        client
            .call(
                "session.mcp.disable",
                Some(json!({"sessionId":id,"serverName":"control"})),
            )
            .await
            .unwrap();
        let disabled = disabled_servers(&client, id).await.unwrap();
        SessionConfiguration
            .update_discovery(&client, id, &cwd, Some(&disabled))
            .await
            .unwrap();
        client
            .call("session.mcp.reload", Some(json!({"sessionId":id})))
            .await
            .unwrap();
        verify_disabled(&client, id, &["control".into(), "only-plugin".into()])
            .await
            .unwrap();
        // Removing the profile also removes the base override, restoring normal native precedence.
        let library = crate::profiles::ProfileLibrary::open(root.join("data")).unwrap();
        SessionConfiguration
            .apply_profile(
                &client,
                id,
                &cwd,
                &library.resolve(None).unwrap(),
                None,
                &McpResolution::default(),
                Some(&["control".into()]),
            )
            .await
            .unwrap();
        has_marker(&client, id, "only-plugin", "pluginonly").await;
        has_marker(&client, id, "base-overlap", "pluginbase").await;
        verify_disabled(&client, id, &["control".into()])
            .await
            .unwrap();
        has_marker(&client, control.id().as_str(), "control", "control").await;
        assert_eq!(std::fs::read(&repository_mcp).unwrap(), repository_bytes);
        assert_eq!(base_before, std::fs::read(base).unwrap());
        assert_eq!(
            home_before,
            std::fs::read(root.join("home").join("config.json")).unwrap()
        );
        assert_eq!(
            serde_json::to_value(globals).unwrap(),
            serde_json::to_value(client.rpc().plugins().list().await.unwrap()).unwrap()
        );
        let other = root.join("other-plugin");
        std::fs::create_dir(&other).unwrap();
        std::fs::write(other.join("plugin.json"),r#"{"name":"included-fixture","version":"1.0.0","description":"Synthetic included plugin"}"#).unwrap();
        std::fs::write(other.join(".mcp.json"),serde_json::to_vec(&json!({"mcpServers":{
            "profile-overlap":{"type":"stdio","command":"node","args":[root.join("mcp.cjs"),"included"],"tools":["*"]}
        }})).unwrap()).unwrap();
        client
            .call("plugins.install", Some(json!({"source":other})))
            .await
            .unwrap();
        let ambiguous = resolve(&client, &profile, &cwd).await.unwrap();
        assert!(
            ambiguous.require_resolved().is_err(),
            "hidden included-plugin contributions must not be guessed"
        );
        assert!(ambiguous.disabled.is_empty());
        assert!(
            ambiguous
                .decisions
                .iter()
                .any(|decision| decision.name == "profile-overlap" && decision.action == "keep")
        );
    });
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(150), &mut task).await;
    task.abort();
    client.stop().await.unwrap();
    outcome.unwrap().unwrap();
}
