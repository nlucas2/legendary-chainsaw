use super::*;
use std::sync::{Arc, Barrier};

struct Fixture {
    root: PathBuf,
    library: ProfileLibrary,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::current_dir()
            .unwrap()
            .join("target")
            .join("profile-tests")
            .join(Uuid::new_v4().to_string());
        let library = ProfileLibrary::open(root.join("data")).unwrap();
        Self { root, library }
    }

    fn directory(&self) -> PathBuf {
        PathBuf::from(self.library.snapshot().unwrap().directory)
    }

    fn write(&self, name: &str, content: &str) -> PathBuf {
        let path = self.directory().join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&path, content).unwrap();
        path
    }

    fn group(&self, name: &str, mcp: &[&str], skills: &[&str]) -> ProfileGroup {
        let snapshot = self.library.snapshot().unwrap();
        self.library
            .save_group(SaveProfileGroup {
                id: None,
                name: name.into(),
                mcp_config_files: mcp.iter().map(|s| s.to_string()).collect(),
                skill_directories: skills.iter().map(|s| s.to_string()).collect(),
                expected_revision: snapshot.revision,
            })
            .unwrap()
            .groups
            .last()
            .unwrap()
            .clone()
    }

    fn profile(&self, name: &str, groups: &[&ProfileGroup]) -> SessionProfile {
        let snapshot = self.library.snapshot().unwrap();
        self.library
            .save_profile(SaveSessionProfile {
                id: None,
                name: name.into(),
                group_ids: groups.iter().map(|group| group.id.clone()).collect(),
                expected_revision: snapshot.revision,
            })
            .unwrap()
            .profiles
            .last()
            .unwrap()
            .clone()
    }

    fn resolve(&self, profile: &SessionProfile) -> ResolvedProfile {
        self.library.resolve(Some(&profile.id)).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn empty_library_and_default_are_explicitly_empty_and_persist() {
    let fixture = Fixture::new();
    let snapshot = fixture.library.snapshot().unwrap();
    assert!(snapshot.groups.is_empty());
    assert!(snapshot.profiles.is_empty());
    let default = fixture.library.resolve(None).unwrap();
    assert_eq!(default.name, "Default");
    assert!(default.mcp_servers.is_empty());
    assert!(default.skill_directories.is_empty());
    let reopened = ProfileLibrary::open(fixture.root.join("data")).unwrap();
    assert_eq!(snapshot.revision, reopened.snapshot().unwrap().revision);
    assert_eq!(default.revision, reopened.resolve(None).unwrap().revision);
    assert!(fixture.directory().join("profiles.json").is_file());
}

#[test]
fn crud_stable_ids_case_insensitive_names_and_referenced_group_protection() {
    let fixture = Fixture::new();
    let group = fixture.group("Shared", &[], &[]);
    let profile = fixture.profile("Work", &[&group]);
    let before = fixture.library.snapshot().unwrap();
    let renamed = fixture
        .library
        .save_group(SaveProfileGroup {
            id: Some(group.id.clone()),
            name: "Shared renamed".into(),
            mcp_config_files: vec![],
            skill_directories: vec![],
            expected_revision: before.revision.clone(),
        })
        .unwrap();
    assert_eq!(group.id, renamed.groups[0].id);
    assert_ne!(before.revision, renamed.revision);
    assert!(
        fixture
            .library
            .delete_group(DeleteProfileGroup {
                id: group.id.clone(),
                expected_revision: renamed.revision.clone(),
            })
            .is_err()
    );
    let duplicate = fixture.library.save_group(SaveProfileGroup {
        id: None,
        name: "SHARED RENAMED".into(),
        mcp_config_files: vec![],
        skill_directories: vec![],
        expected_revision: renamed.revision.clone(),
    });
    assert!(matches!(duplicate, Err(ProfileError::Invalid(_))));
    let updated = fixture
        .library
        .save_profile(SaveSessionProfile {
            id: Some(profile.id.clone()),
            name: "Personal".into(),
            group_ids: vec![group.id.clone()],
            expected_revision: renamed.revision,
        })
        .unwrap();
    assert_eq!(updated.profiles[0].id, profile.id);
    let updated = fixture
        .library
        .delete_profile(DeleteSessionProfile {
            id: profile.id,
            expected_revision: updated.revision,
        })
        .unwrap();
    let updated = fixture
        .library
        .delete_group(DeleteProfileGroup {
            id: group.id,
            expected_revision: updated.revision,
        })
        .unwrap();
    assert!(updated.groups.is_empty());
    assert!(updated.profiles.is_empty());
}

#[test]
fn stale_revision_and_concurrent_writers_cannot_lose_an_update() {
    let fixture = Fixture::new();
    let revision = fixture.library.snapshot().unwrap().revision;
    let barrier = Arc::new(Barrier::new(3));
    let mut threads = vec![];
    for name in ["First", "Second"] {
        let library = fixture.library.clone();
        let barrier = barrier.clone();
        let expected_revision = revision.clone();
        threads.push(std::thread::spawn(move || {
            barrier.wait();
            library.save_group(SaveProfileGroup {
                id: None,
                name: name.into(),
                mcp_config_files: vec![],
                skill_directories: vec![],
                expected_revision,
            })
        }));
    }
    barrier.wait();
    let results = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert!(
        results
            .iter()
            .filter_map(|result| result.as_ref().err())
            .all(|error| { matches!(error, ProfileError::Busy | ProfileError::RevisionConflict) })
    );
    assert_eq!(fixture.library.snapshot().unwrap().groups.len(), 1);
    assert!(matches!(
        fixture.library.delete_group(DeleteProfileGroup {
            id: Uuid::new_v4().to_string(),
            expected_revision: revision,
        }),
        Err(ProfileError::RevisionConflict)
    ));
}

#[test]
fn explicit_lock_fails_busy_and_releases_without_deleting_lock_file() {
    let fixture = Fixture::new();
    let path = fixture.library.data_dir.join("profile-library.lock");
    let held = lock(&path).unwrap();
    assert!(matches!(
        fixture.library.snapshot(),
        Err(ProfileError::Busy)
    ));
    drop(held);
    assert!(path.exists());
    assert!(fixture.library.snapshot().is_ok());
}

#[test]
fn ordered_groups_deduplicate_identical_servers_and_replace_entire_conflicting_definition() {
    let fixture = Fixture::new();
    fixture.write("first.json", r#"{"mcpServers":{"same":{"command":"echo","args":["old"],"env":{"TOKEN":"synthetic-secret"}},"identical":{"command":"echo"}}}"#);
    fixture.write("second.json", r#"{"mcpServers":{"same":{"type":"stdio","command":"echo","args":["new"]},"identical":{"type":"local","command":"echo","args":[]}}}"#);
    let first = fixture.group("First", &["first.json"], &[]);
    let second = fixture.group("Second", &["second.json"], &[]);
    let profile = fixture.profile("Ordered", &[&first, &second]);
    let resolved = fixture.resolve(&profile);
    assert_eq!(resolved.group_names, ["First", "Second"]);
    assert_eq!(resolved.mcp_servers.len(), 2);
    let value = serde_json::to_value(&resolved.mcp_servers["same"]).unwrap();
    assert_eq!(value["args"], serde_json::json!(["new"]));
    assert!(value.get("env").is_none());
    assert_eq!(resolved.warnings.len(), 1);
    assert!(resolved.warnings[0].contains("first.json"));
    assert!(resolved.warnings[0].contains("second.json"));
    assert!(
        resolved
            .mcp_sources
            .iter()
            .find(|source| source.name == "same")
            .unwrap()
            .source_file
            .ends_with("second.json")
    );
    assert!(
        resolved
            .mcp_sources
            .iter()
            .find(|source| source.name == "identical")
            .unwrap()
            .source_file
            .ends_with("first.json")
    );
    let reversed = fixture.profile("Reverse", &[&second, &first]);
    let reversed = fixture.resolve(&reversed);
    assert_eq!(
        serde_json::to_value(&reversed.mcp_servers["same"]).unwrap()["args"],
        serde_json::json!(["old"])
    );
}

#[test]
fn relative_and_absolute_references_resolve_and_skill_directories_deduplicate_in_order() {
    let fixture = Fixture::new();
    let mcp = fixture.write(
        "linked.json",
        r#"{"mcpServers":{"one":{"command":"echo"}}}"#,
    );
    fixture.write("skills\\first\\SKILL.md", "never parsed");
    fixture.write("more\\second\\SKILL.md", "never parsed");
    let absolute_skill = display_path(&fixture.directory().join("skills"));
    let first = fixture.group(
        "First",
        &[&display_path(&mcp)],
        &["skills", &absolute_skill],
    );
    let second = fixture.group("Second", &["linked.json"], &["more"]);
    let profile = fixture.profile("Paths", &[&first, &second]);
    let resolved = fixture.resolve(&profile);
    assert_eq!(resolved.skill_directories.len(), 2);
    assert_eq!(
        resolved.skill_directories[0],
        fs::canonicalize(fixture.directory().join("skills")).unwrap()
    );
    assert_eq!(
        resolved.skill_directories[1],
        fs::canonicalize(fixture.directory().join("more")).unwrap()
    );
    assert_eq!(resolved.mcp_servers.len(), 1);
    assert_eq!(resolved.warnings, [SKILL_FINGERPRINT_WARNING]);
}

#[test]
fn skill_directory_name_collisions_are_visible_without_parsing_skill_bodies() {
    let fixture = Fixture::new();
    fixture.write("first\\duplicate\\SKILL.md", "not valid frontmatter");
    fixture.write(
        "second\\duplicate\\SKILL.md",
        "not valid frontmatter either",
    );
    let group = fixture.group("Skills", &[], &["first", "second"]);
    let profile = fixture.profile("Skills", &[&group]);
    let resolved = fixture.resolve(&profile);
    assert_eq!(resolved.skill_directories.len(), 2);
    assert_eq!(resolved.warnings.len(), 2);
    assert!(resolved.warnings[0].contains("duplicate"));
    assert_eq!(resolved.warnings[1], SKILL_FINGERPRINT_WARNING);
}

#[test]
fn same_size_skill_manifest_edit_with_restored_timestamp_invalidates_approval() {
    let fixture = Fixture::new();
    let before = "unparsed synthetic manifest A";
    let after = "unparsed synthetic manifest B";
    assert_eq!(before.len(), after.len());
    let path = fixture.write("skills\\example\\SKILL.md", before);
    let metadata = fs::metadata(&path).unwrap();
    let modified = metadata.modified().unwrap();
    let group = fixture.group("Skills", &[], &["skills"]);
    let profile = fixture.profile("Skills", &[&group]);
    let selection = fixture.resolve(&profile).selection();
    fs::write(&path, after).unwrap();
    OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(modified))
        .unwrap();
    let changed = fs::metadata(&path).unwrap();
    assert_eq!(changed.len(), metadata.len());
    assert_eq!(changed.modified().unwrap(), modified);
    assert!(matches!(
        fixture
            .library
            .resolve_by_revision(Some(&profile.id), &selection.revision),
        Err(ProfileError::SourceRevisionConflict)
    ));
    assert!(matches!(
        resolve_snapshot(&selection),
        Err(ProfileError::SourceRevisionConflict)
    ));
    let saved = serde_json::to_string(&selection).unwrap();
    assert!(!saved.contains(before));
    assert!(!saved.contains(after));
}

#[test]
fn auxiliary_skill_resources_are_explicitly_outside_fingerprint_guarantee() {
    let fixture = Fixture::new();
    fixture.write("skills\\example\\SKILL.md", "unparsed manifest");
    let script = fixture.write("skills\\example\\run.ps1", "before");
    let group = fixture.group("Skills", &[], &["skills"]);
    let profile = fixture.profile("Skills", &[&group]);
    let resolved = fixture.resolve(&profile);
    assert_eq!(resolved.warnings, [SKILL_FINGERPRINT_WARNING]);
    fs::write(script, "changed resource").unwrap();
    assert!(resolve_snapshot(&resolved.selection()).is_ok());
}

#[test]
fn skill_manifest_hashing_is_bounded_per_file_and_across_directories() {
    let fixture = Fixture::new();
    fixture.write(
        "oversized\\example\\SKILL.md",
        &"x".repeat(MAX_SKILL_MANIFEST_BYTES as usize + 1),
    );
    let group = fixture.group("Oversized", &[], &["oversized"]);
    let profile = fixture.profile("Oversized", &[&group]);
    let error = fixture
        .library
        .resolve(Some(&profile.id))
        .err()
        .unwrap()
        .to_string();
    assert!(error.contains("exceeds 1 MiB"));
    let manifest = "x".repeat(MAX_SKILL_MANIFEST_BYTES as usize);
    for index in 0..(MAX_SKILL_MANIFEST_TOTAL_BYTES / MAX_SKILL_MANIFEST_BYTES as usize) {
        fixture.write(
            &format!("bounded{}\\skill{index}\\SKILL.md", index % 2),
            &manifest,
        );
    }
    let group = fixture.group("Aggregate", &[], &["bounded0", "bounded1"]);
    let profile = fixture.profile("Aggregate", &[&group]);
    assert!(fixture.library.resolve(Some(&profile.id)).is_ok());
    fixture.write("bounded1\\over-limit\\SKILL.md", "x");
    let error = fixture
        .library
        .resolve(Some(&profile.id))
        .err()
        .unwrap()
        .to_string();
    assert!(error.contains("exceed 8 MiB in total"));
}

#[cfg(windows)]
#[test]
fn unreadable_skill_manifest_fails_closed_instead_of_using_only_metadata() {
    use std::os::windows::fs::OpenOptionsExt;
    let fixture = Fixture::new();
    let skill = fixture.write("skills\\example\\SKILL.md", "unparsed manifest");
    let group = fixture.group("Skills", &[], &["skills"]);
    let profile = fixture.profile("Skills", &[&group]);
    let held = OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&skill)
        .unwrap();
    assert!(matches!(
        fixture.library.resolve(Some(&profile.id)),
        Err(ProfileError::Io { .. })
    ));
    drop(held);
    assert!(fixture.library.resolve(Some(&profile.id)).is_ok());
}

#[test]
fn saved_selection_stays_in_original_library_and_rejects_changed_sources() {
    let fixture = Fixture::new();
    let source = fixture.write(
        "server.json",
        r#"{"mcpServers":{"one":{"command":"echo"}}}"#,
    );
    let group = fixture.group("Base", &["server.json"], &[]);
    let profile = fixture.profile("Saved", &[&group]);
    let resolved = fixture.resolve(&profile);
    let selection = resolved.selection();
    let alternate = fixture.root.join("alternate");
    fs::create_dir(&alternate).unwrap();
    let switched = fixture
        .library
        .set_directory(SetProfileDirectory {
            directory: display_path(&alternate),
            expected_revision: fixture.library.snapshot().unwrap().revision,
        })
        .unwrap();
    assert!(switched.groups.is_empty());
    assert_eq!(
        fixture
            .library
            .resolve_selection(&selection)
            .unwrap()
            .revision,
        resolved.revision
    );
    fs::write(&source, r#"{"mcpServers":{"one":{"command":"changed"}}}"#).unwrap();
    assert!(matches!(
        fixture.library.resolve_selection(&selection),
        Err(ProfileError::SourceRevisionConflict)
    ));
}

#[test]
fn source_and_selected_group_changes_invalidate_confirmation_but_unrelated_edits_do_not() {
    let fixture = Fixture::new();
    let source = fixture.write(
        "server.json",
        r#"{"mcpServers":{"one":{"command":"echo"}}}"#,
    );
    let group = fixture.group("Base", &["server.json"], &[]);
    let profile = fixture.profile("Saved", &[&group]);
    let revision = fixture.resolve(&profile).revision;
    fixture.group("Unrelated", &[], &[]);
    assert!(
        fixture
            .library
            .resolve_by_revision(Some(&profile.id), &revision)
            .is_ok()
    );
    fs::write(&source, r#"{"mcpServers":{"one":{"command":"different"}}}"#).unwrap();
    assert!(matches!(
        fixture
            .library
            .resolve_by_revision(Some(&profile.id), &revision),
        Err(ProfileError::SourceRevisionConflict)
    ));
    let revision = fixture.resolve(&profile).revision;
    fixture
        .library
        .save_group(SaveProfileGroup {
            id: Some(group.id),
            name: "Renamed".into(),
            mcp_config_files: vec!["server.json".into()],
            skill_directories: vec![],
            expected_revision: fixture.library.snapshot().unwrap().revision,
        })
        .unwrap();
    assert!(matches!(
        fixture
            .library
            .resolve_by_revision(Some(&profile.id), &revision),
        Err(ProfileError::SourceRevisionConflict)
    ));
}

#[test]
fn approved_snapshot_survives_library_edits_and_deleted_records_without_broadening() {
    let fixture = Fixture::new();
    fixture.write(
        "approved.json",
        r#"{"mcpServers":{"approved":{"command":"echo"}}}"#,
    );
    fixture.write(
        "extra.json",
        r#"{"mcpServers":{"extra":{"command":"echo"}}}"#,
    );
    let group = fixture.group("Approved group", &["approved.json"], &[]);
    let profile = fixture.profile("Approved profile", &[&group]);
    let selection = fixture.resolve(&profile).selection();
    assert_eq!(selection.snapshot.as_ref().unwrap().groups, [group.clone()]);
    let snapshot = fixture
        .library
        .save_group(SaveProfileGroup {
            id: Some(group.id.clone()),
            name: "Changed group".into(),
            mcp_config_files: vec!["approved.json".into(), "extra.json".into()],
            skill_directories: vec![],
            expected_revision: fixture.library.snapshot().unwrap().revision,
        })
        .unwrap();
    let approved = resolve_snapshot(&selection).unwrap();
    assert_eq!(
        approved
            .mcp_servers
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        ["approved"]
    );
    assert_eq!(approved.group_names, ["Approved group"]);
    assert_eq!(fixture.resolve(&profile).mcp_servers.len(), 2);
    let snapshot = fixture
        .library
        .delete_profile(DeleteSessionProfile {
            id: profile.id,
            expected_revision: snapshot.revision,
        })
        .unwrap();
    fixture
        .library
        .delete_group(DeleteProfileGroup {
            id: group.id,
            expected_revision: snapshot.revision,
        })
        .unwrap();
    assert_eq!(
        resolve_snapshot(&selection).unwrap().revision,
        selection.revision
    );
    fs::remove_file(fixture.directory().join("profiles.json")).unwrap();
    fs::write(fixture.library.setting_path(), "broken current setting").unwrap();
    assert_eq!(
        resolve_snapshot(&selection).unwrap().revision,
        selection.revision
    );
}

#[test]
fn legacy_selections_without_snapshot_remain_readable_and_fail_closed_after_edit() {
    let fixture = Fixture::new();
    let group = fixture.group("Group", &[], &[]);
    let profile = fixture.profile("Profile", &[&group]);
    let selection = fixture.resolve(&profile).selection();
    let mut json = serde_json::to_value(selection).unwrap();
    json.as_object_mut().unwrap().remove("snapshot");
    let legacy: ProfileSelection = serde_json::from_value(json).unwrap();
    assert!(legacy.snapshot.is_none());
    assert!(resolve_snapshot(&legacy).is_ok());
    fixture
        .library
        .save_group(SaveProfileGroup {
            id: Some(group.id),
            name: "Renamed".into(),
            mcp_config_files: vec![],
            skill_directories: vec![],
            expected_revision: fixture.library.snapshot().unwrap().revision,
        })
        .unwrap();
    assert!(matches!(
        resolve_snapshot(&legacy),
        Err(ProfileError::SourceRevisionConflict)
    ));
}

#[test]
fn tampered_snapshot_or_changed_linked_source_requires_fresh_confirmation() {
    let fixture = Fixture::new();
    let path = fixture.write(
        "source.json",
        r#"{"mcpServers":{"approved":{"command":"echo"}}}"#,
    );
    let group = fixture.group("Group", &["source.json"], &[]);
    let profile = fixture.profile("Profile", &[&group]);
    let selection = fixture.resolve(&profile).selection();
    let mut changed = selection.clone();
    changed.snapshot.as_mut().unwrap().groups[0]
        .mcp_config_files
        .clear();
    assert!(matches!(
        resolve_snapshot(&changed),
        Err(ProfileError::SourceRevisionConflict)
    ));
    let mut changed = selection.clone();
    changed.snapshot.as_mut().unwrap().profile.id = Uuid::new_v4().to_string();
    assert!(matches!(
        resolve_snapshot(&changed),
        Err(ProfileError::Invalid(_))
    ));
    fs::write(
        path,
        r#"{"mcpServers":{"approved":{"command":"different"}}}"#,
    )
    .unwrap();
    assert!(matches!(
        resolve_snapshot(&selection),
        Err(ProfileError::SourceRevisionConflict)
    ));
}

#[test]
fn default_saved_selection_does_not_depend_on_library_existence() {
    let fixture = Fixture::new();
    let selection = fixture.library.resolve(None).unwrap().selection();
    assert!(selection.snapshot.is_none());
    fs::remove_dir_all(fixture.directory()).unwrap();
    let resolved = resolve_snapshot(&selection).unwrap();
    assert!(resolved.mcp_servers.is_empty());
    assert!(resolved.skill_directories.is_empty());
    assert_eq!(resolved.revision, selection.revision);
}

#[test]
fn directory_switch_persists_pointer_and_does_not_move_existing_files() {
    let fixture = Fixture::new();
    fixture.group("Original", &[], &[]);
    let original = fixture.directory();
    let target = fixture.root.join("new-library");
    fs::create_dir(&target).unwrap();
    let snapshot = fixture.library.snapshot().unwrap();
    fixture
        .library
        .set_directory(SetProfileDirectory {
            directory: display_path(&target),
            expected_revision: snapshot.revision,
        })
        .unwrap();
    let reopened = ProfileLibrary::open(fixture.root.join("data")).unwrap();
    assert_eq!(
        path_key(Path::new(&reopened.snapshot().unwrap().directory)),
        path_key(&target)
    );
    assert!(original.join("profiles.json").is_file());
    assert!(reopened.snapshot().unwrap().groups.is_empty());
    reopened
        .set_directory(SetProfileDirectory {
            directory: display_path(&original),
            expected_revision: reopened.snapshot().unwrap().revision,
        })
        .unwrap();
    assert_eq!(reopened.snapshot().unwrap().groups[0].name, "Original");
}

#[test]
fn directory_switch_requires_existing_absolute_path_and_valid_store() {
    let fixture = Fixture::new();
    let original = fixture.library.snapshot().unwrap();
    for path in [
        "relative".to_owned(),
        display_path(&fixture.root.join("missing")),
    ] {
        assert!(
            fixture
                .library
                .set_directory(SetProfileDirectory {
                    directory: path,
                    expected_revision: original.revision.clone(),
                })
                .is_err()
        );
    }
    let corrupt_target = fixture.root.join("bad");
    fs::create_dir(&corrupt_target).unwrap();
    fs::write(corrupt_target.join("profiles.json"), "{bad").unwrap();
    assert!(matches!(
        fixture.library.set_directory(SetProfileDirectory {
            directory: display_path(&corrupt_target),
            expected_revision: original.revision.clone(),
        }),
        Err(ProfileError::Corrupt { .. })
    ));
    assert_eq!(
        fixture.library.snapshot().unwrap().revision,
        original.revision
    );
}

#[test]
fn missing_source_malformed_json_and_wrong_source_types_are_explicit_errors() {
    let fixture = Fixture::new();
    fixture.write("bad.json", r#"{"mcpServers": not-json-secret}"#);
    fs::create_dir(fixture.directory().join("directory.json")).unwrap();
    for (index, reference) in ["missing.json", "bad.json", "directory.json"]
        .iter()
        .enumerate()
    {
        let group = fixture.group(&format!("Group {index}"), &[reference], &[]);
        let profile = fixture.profile(&format!("Profile {index}"), &[&group]);
        let error = fixture
            .library
            .resolve(Some(&profile.id))
            .err()
            .unwrap()
            .to_string();
        assert!(!error.contains("not-json-secret"));
    }
    let group = fixture.group("Wrong skill type", &[], &["bad.json"]);
    let profile = fixture.profile("Wrong skill type", &[&group]);
    assert!(fixture.library.resolve(Some(&profile.id)).is_err());
}

#[cfg(windows)]
#[test]
fn unreadable_source_sharing_violation_is_not_an_empty_configuration() {
    use std::os::windows::fs::OpenOptionsExt;
    let fixture = Fixture::new();
    let source = fixture.write("server.json", r#"{"mcpServers":{}}"#);
    let group = fixture.group("Unreadable", &["server.json"], &[]);
    let profile = fixture.profile("Unreadable", &[&group]);
    let held = OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&source)
        .unwrap();
    assert!(matches!(
        fixture.library.resolve(Some(&profile.id)),
        Err(ProfileError::Io { .. })
    ));
    drop(held);
    assert!(fixture.library.resolve(Some(&profile.id)).is_ok());
}

#[test]
fn unknown_groups_duplicate_references_and_unknown_edit_ids_are_rejected() {
    let fixture = Fixture::new();
    let group = fixture.group("One", &[], &[]);
    for ids in [
        vec![Uuid::new_v4().to_string()],
        vec![group.id.clone(), group.id],
    ] {
        assert!(matches!(
            fixture.library.save_profile(SaveSessionProfile {
                id: None,
                name: "Bad".into(),
                group_ids: ids,
                expected_revision: fixture.library.snapshot().unwrap().revision,
            }),
            Err(ProfileError::Invalid(_))
        ));
    }
    assert!(matches!(
        fixture.library.save_group(SaveProfileGroup {
            id: Some(Uuid::new_v4().to_string()),
            name: "Unknown".into(),
            mcp_config_files: vec![],
            skill_directories: vec![],
            expected_revision: fixture.library.snapshot().unwrap().revision,
        }),
        Err(ProfileError::NotFound(_))
    ));
    assert!(matches!(
        fixture.library.resolve(Some("unknown")),
        Err(ProfileError::NotFound(_))
    ));
}

#[test]
fn explicit_source_creation_never_overwrites_and_refuses_path_traversal() {
    let fixture = Fixture::new();
    let revision = fixture.library.snapshot().unwrap().revision;
    let request = CreateProfileSource {
        kind: ProfileSourceKind::Mcp,
        name: "my-server".into(),
        content: Some(r#"{"mcpServers":{"one":{"command":"echo"}}}"#.into()),
        expected_revision: revision.clone(),
    };
    let source = fixture.library.create_source(request.clone()).unwrap();
    let original = fs::read(&source.path).unwrap();
    assert!(source.path.ends_with("my-server.json"));
    assert!(fixture.library.create_source(request).is_err());
    assert_eq!(fs::read(&source.path).unwrap(), original);
    for name in [
        "..",
        ".",
        "..\\escape",
        "../escape",
        "C:\\escape",
        "CON",
        "NUL.txt",
        "a:b",
        "foo.",
    ] {
        assert!(
            fixture
                .library
                .create_source(CreateProfileSource {
                    kind: ProfileSourceKind::Skills,
                    name: name.into(),
                    content: None,
                    expected_revision: revision.clone(),
                })
                .is_err(),
            "{name}"
        );
    }
    let skill = fixture
        .library
        .create_source(CreateProfileSource {
            kind: ProfileSourceKind::Skills,
            name: "my-skills".into(),
            content: None,
            expected_revision: revision,
        })
        .unwrap();
    assert!(Path::new(&skill.path).is_dir());
    assert_eq!(fs::read_dir(&skill.path).unwrap().count(), 0);
    assert!(fixture.library.snapshot().unwrap().groups.is_empty());
}

#[test]
fn creation_validates_content_and_revision_before_creating_sources() {
    let fixture = Fixture::new();
    let snapshot = fixture.library.snapshot().unwrap();
    for request in [
        CreateProfileSource {
            kind: ProfileSourceKind::Mcp,
            name: "bad".into(),
            content: Some("bad".into()),
            expected_revision: snapshot.revision.clone(),
        },
        CreateProfileSource {
            kind: ProfileSourceKind::Skills,
            name: "bad".into(),
            content: Some("not allowed".into()),
            expected_revision: snapshot.revision,
        },
        CreateProfileSource {
            kind: ProfileSourceKind::Skills,
            name: "bad".into(),
            content: None,
            expected_revision: "stale".into(),
        },
    ] {
        assert!(fixture.library.create_source(request).is_err());
    }
    assert!(!fixture.directory().join("sources").exists());
}

#[test]
fn corrupt_missing_and_unsupported_store_are_never_reset() {
    let fixture = Fixture::new();
    let directory = fixture.directory();
    let path = directory.join("profiles.json");
    let valid = fs::read(&path).unwrap();
    for corrupt in [b"{bad".to_vec(), b"null".to_vec(), b"{}".to_vec(), {
        let mut value: Value = serde_json::from_slice(&valid).unwrap();
        value["version"] = Value::from(999);
        serde_json::to_vec(&value).unwrap()
    }] {
        fs::write(&path, &corrupt).unwrap();
        assert!(matches!(
            fixture.library.snapshot(),
            Err(ProfileError::Corrupt { .. })
        ));
        assert!(ProfileLibrary::open(fixture.root.join("data")).is_err());
        assert_eq!(fs::read(&path).unwrap(), corrupt);
    }
    fs::remove_file(&path).unwrap();
    assert!(fixture.library.snapshot().is_err());
    assert!(ProfileLibrary::open(fixture.root.join("data")).is_err());
    assert!(!path.exists());
}

#[test]
fn corrupt_pointer_is_not_reset_to_default() {
    let fixture = Fixture::new();
    let path = fixture.library.setting_path();
    fs::write(&path, "invalid").unwrap();
    assert!(matches!(
        ProfileLibrary::open(fixture.root.join("data")),
        Err(ProfileError::Corrupt { .. })
    ));
    assert_eq!(fs::read_to_string(&path).unwrap(), "invalid");
}

#[test]
fn templates_unsupported_dialects_and_lossy_sdk_fields_are_rejected_without_leaking_values() {
    for content in [
        r#"{"servers":{}}"#,
        r#"{"mcpServers":{"server":{"command":"__HOME__/tool"}}}"#,
        r#"{"mcpServers":{"server":{"url":"https://example.invalid"}}}"#,
        r#"{"mcpServers":{"server":{"type":"other","command":"echo"}}}"#,
        r#"{"mcpServers":{"server":{"command":"echo","oauth":{"token":"synthetic-secret"}}}}"#,
        r#"{"mcpServers":{"server":{"command":"echo","env":{"TOKEN":123}}}}"#,
    ] {
        let error = parse_mcp(content.as_bytes(), Path::new("synthetic.json"))
            .err()
            .unwrap()
            .to_string();
        assert!(!error.contains("synthetic-secret"));
    }
    let template = parse_mcp(
        br#"{"mcpServers":{"server":{"command":"__HOME__/tool"}}}"#,
        Path::new("template.json"),
    )
    .err()
    .unwrap()
    .to_string();
    assert!(template.contains("generated MCP config"));
}

#[test]
fn all_known_bootstrap_template_markers_are_rejected_with_accurate_guidance() {
    for marker in ["__HOME__", "__LOCALAPPDATA__", "__NPM_GLOBAL__"] {
        let source = serde_json::to_vec(&serde_json::json!({
            "mcpServers": {
                "server": {
                    "command": "node",
                    "args": [format!("{marker}\\synthetic-secret\\server.js")]
                }
            }
        }))
        .unwrap();
        let error = parse_mcp(&source, Path::new("bootstrap-template.json"))
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains(&format!("Unresolved {marker} template")));
        assert!(error.contains("generated MCP config file"));
        assert!(!error.contains("synthetic-secret"));
        let error = validate_reference(&format!("{marker}\\mcp.json"))
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains(marker));
        assert!(error.contains("generated files"));
    }
}

#[test]
fn supported_stdio_http_and_sse_normalize_without_expanding_environment() {
    let bytes = br#"{"mcpServers":{
        "stdio":{"command":"echo","args":["${HOME}"],"env":{"TOKEN":"${env:MY_TOKEN}"},"cwd":"%HOME%"},
        "http":{"type":"http","url":"https://example.invalid/mcp","headers":{"Authorization":"Bearer ${TOKEN}"},"tools":["*"]},
        "sse":{"type":"sse","url":"http://localhost/events","timeout":5000}
    }}"#;
    let (servers, placeholders) = parse_mcp(bytes, Path::new("synthetic.json")).unwrap();
    assert!(placeholders);
    assert_eq!(servers["stdio"]["type"], "stdio");
    assert_eq!(servers["stdio"]["env"]["TOKEN"], "${env:MY_TOKEN}");
    assert_eq!(servers["stdio"]["cwd"], "%HOME%");
    assert_eq!(
        servers["http"]["headers"]["Authorization"],
        "Bearer ${TOKEN}"
    );
    assert_eq!(servers["sse"]["type"], "sse");
}

#[test]
fn snapshots_previews_selections_and_errors_do_not_expose_config_credentials() {
    let fixture = Fixture::new();
    fixture.write("secret.json", r#"{"mcpServers":{"remote":{"type":"http","url":"https://example.invalid/?secret=synthetic-secret","headers":{"Authorization":"synthetic-secret"}}}}"#);
    let group = fixture.group("Safe name", &["secret.json"], &[]);
    let profile = fixture.profile("Safe profile", &[&group]);
    let resolved = fixture.resolve(&profile);
    for output in [
        serde_json::to_string(&fixture.library.snapshot().unwrap()).unwrap(),
        serde_json::to_string(&resolved.preview()).unwrap(),
        serde_json::to_string(&resolved.selection()).unwrap(),
    ] {
        assert!(!output.contains("synthetic-secret"));
        assert!(!output.contains("Authorization"));
        assert!(!output.contains("example.invalid"));
    }
}

#[test]
fn file_sizes_names_and_reference_counts_are_bounded() {
    assert!(validate_name("").is_err());
    assert!(validate_name(&"x".repeat(MAX_NAME + 1)).is_err());
    assert!(validate_reference(&"x".repeat(MAX_PATH + 1)).is_err());
    assert!(validate_reference("__HOME__\\mcp.json").is_err());
    assert!(validate_reference("${HOME}\\mcp.json").is_err());
    assert!(
        parse_mcp(
            &vec![b' '; MAX_SOURCE_BYTES as usize + 1],
            Path::new("too-large.json")
        )
        .is_err()
    );
    let fixture = Fixture::new();
    assert!(
        fixture
            .library
            .save_group(SaveProfileGroup {
                id: None,
                name: "Too many".into(),
                mcp_config_files: vec!["source.json".into(); MAX_REFERENCES + 1],
                skill_directories: vec![],
                expected_revision: fixture.library.snapshot().unwrap().revision,
            })
            .is_err()
    );
}

#[test]
fn repeated_sources_have_a_total_composition_budget() {
    let fixture = Fixture::new();
    fixture.write(
        "server.json",
        r#"{"mcpServers":{"one":{"command":"echo"}}}"#,
    );
    let groups: Vec<_> = (0..5)
        .map(|index| {
            fixture.group(
                &format!("Group {index}"),
                &["server.json"; MAX_REFERENCES],
                &[],
            )
        })
        .collect();
    let profile = fixture.profile("Too many", &groups.iter().collect::<Vec<_>>());
    assert!(matches!(
        fixture.library.resolve(Some(&profile.id)),
        Err(ProfileError::Invalid(_))
    ));
}

#[cfg(windows)]
#[test]
fn atomic_write_failure_keeps_previous_store_and_cleans_staging_file() {
    use std::os::windows::fs::OpenOptionsExt;
    let fixture = Fixture::new();
    let snapshot = fixture.library.snapshot().unwrap();
    let directory = fixture.directory();
    let path = directory.join("profiles.json");
    let original = fs::read(&path).unwrap();
    let held = OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&path)
        .unwrap();
    assert!(matches!(
        fixture.library.save_group(SaveProfileGroup {
            id: None,
            name: "Must not save".into(),
            mcp_config_files: vec![],
            skill_directories: vec![],
            expected_revision: snapshot.revision.clone(),
        }),
        Err(ProfileError::Io { .. })
    ));
    assert_eq!(fs::read(&path).unwrap(), original);
    assert!(!fs::read_dir(&directory).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".writing")
    }));
    drop(held);
    assert_eq!(
        fixture.library.snapshot().unwrap().revision,
        snapshot.revision
    );
}

#[test]
fn source_creation_refuses_linked_owned_directories() {
    let fixture = Fixture::new();
    let outside = fixture.root.join("outside");
    fs::create_dir(&outside).unwrap();
    let link = fixture.directory().join("sources");
    #[cfg(windows)]
    let created = std::os::windows::fs::symlink_dir(&outside, &link);
    #[cfg(unix)]
    let created = std::os::unix::fs::symlink(&outside, &link);
    if created.is_err() {
        // Windows developer mode/elevated symlink permission is not required to run the suite.
        return;
    }
    assert!(
        fixture
            .library
            .create_source(CreateProfileSource {
                kind: ProfileSourceKind::Skills,
                name: "must-not-write".into(),
                content: None,
                expected_revision: fixture.library.snapshot().unwrap().revision,
            })
            .is_err()
    );
    assert_eq!(fs::read_dir(outside).unwrap().count(), 0);
}
