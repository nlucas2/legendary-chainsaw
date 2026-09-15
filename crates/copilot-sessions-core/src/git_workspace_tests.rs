use super::*;
use std::{
    fs,
    path::PathBuf,
    process::Command as SyncCommand,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Repo(PathBuf);

impl Repo {
    fn empty() -> Self {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/git-workspace-fixtures")
            .join(format!(
                "{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir_all(&path).unwrap();
        Self(path.canonicalize().unwrap())
    }
    fn new() -> Self {
        let repo = Self::empty();
        repo.git(&["init", "--quiet", "--initial-branch=main"]);
        repo.git(&["config", "user.name", "Git Workspace Fixture"]);
        repo.git(&["config", "user.email", "fixture@example.invalid"]);
        repo.git(&["config", "core.autocrlf", "false"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        repo
    }
    fn cwd(&self) -> &str {
        self.0.to_str().unwrap()
    }
    fn git(&self, args: &[&str]) -> String {
        let mut command = SyncCommand::new("git");
        for (key, _) in std::env::vars_os() {
            if key
                .to_string_lossy()
                .to_ascii_uppercase()
                .starts_with("GIT_")
            {
                command.env_remove(key);
            }
        }
        let output = command
            .current_dir(&self.0)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                if cfg!(windows) { "NUL" } else { "/dev/null" },
            )
            .args(["-c", "core.hooksPath=", "-c", "core.fsmonitor=false"])
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }
    fn write(&self, path: &str, contents: impl AsRef<[u8]>) {
        let path = self.0.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }
    fn commit(&self) -> String {
        self.git(&["add", "--all"]);
        self.git(&["commit", "--quiet", "-m", "isolated test fixture"]);
        self.git(&["rev-parse", "HEAD"]).trim().into()
    }
    async fn diff(&self, view: GitView, path: &str, base: Option<&str>) -> GitDiff {
        diff(
            self.cwd(),
            GitDiffRequest {
                view,
                path: path.into(),
                base: base.map(str::to_owned),
            },
        )
        .await
        .unwrap()
    }
}

impl Drop for Repo {
    fn drop(&mut self) {
        // Git objects can be read-only on Windows.
        fn writable(path: &Path) {
            if let Ok(entries) = fs::read_dir(path) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if let Ok(metadata) = fs::symlink_metadata(&path) {
                        if metadata.is_dir() && !metadata.file_type().is_symlink() {
                            writable(&path);
                        } else if metadata.is_file() {
                            #[cfg(windows)]
                            {
                                let mut permissions = metadata.permissions();
                                permissions.set_readonly(false);
                                let _ = fs::set_permissions(&path, permissions);
                            }
                        }
                    }
                }
            }
        }
        writable(&self.0);
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[tokio::test]
async fn no_repository_unborn_and_detached_are_explicit() {
    let not_repo = Repo::empty();
    not_repo.write(".git", "gitdir: nonexistent-fixture-git-directory\n");
    let result = workspace(not_repo.cwd(), None).await.unwrap();
    assert_eq!(result.state, "noRepo");
    assert!(result.repo_root.is_none());
    let repo = Repo::new();
    repo.write("first.txt", "first\n");
    repo.git(&["add", "--", "first.txt"]);
    let unborn = workspace(repo.cwd(), None).await.unwrap();
    assert!(unborn.unborn);
    assert_eq!(unborn.branch.as_deref(), Some("main"));
    assert_eq!(unborn.staged.len(), 1);
    assert!(
        repo.diff(GitView::Staged, "first.txt", None)
            .await
            .patch
            .contains("+first")
    );
    repo.commit();
    repo.git(&["checkout", "--quiet", "--detach"]);
    let detached = workspace(repo.cwd(), None).await.unwrap();
    assert!(detached.detached);
    assert!(!detached.unborn);
    assert!(detached.head.is_some());
    assert!(
        detached
            .compare_unavailable_reason
            .unwrap()
            .contains("No upstream")
    );
}

#[tokio::test]
async fn staged_unstaged_and_pr_comparison_are_distinct_and_read_only() {
    let repo = Repo::new();
    repo.write("space directory/change file.txt", "baseline\n");
    let base = repo.commit();
    repo.git(&["checkout", "--quiet", "-b", "feature"]);
    repo.git(&["branch", "--set-upstream-to=main"]);
    repo.write("space directory/change file.txt", "committed\n");
    let head = repo.commit();
    repo.write("space directory/change file.txt", "staged\n");
    repo.git(&["add", "--all"]);
    repo.write("space directory/change file.txt", "working\n");
    repo.write("untracked.txt", "not staged\n");
    let before_index = fs::read(repo.0.join(".git/index")).unwrap();
    let before_config = fs::read(repo.0.join(".git/config")).unwrap();
    let before_worktree = fs::read(repo.0.join("space directory/change file.txt")).unwrap();
    let state = workspace(repo.0.join("space directory").to_str().unwrap(), None)
        .await
        .unwrap();
    assert_eq!(state.head.as_deref(), Some(head.as_str()));
    assert_eq!(state.merge_base.as_deref(), Some(base.as_str()));
    assert_eq!(state.upstream.as_deref(), Some("refs/heads/main"));
    assert_eq!(state.base.as_deref(), Some("refs/heads/main"));
    assert_eq!(state.staged[0].added, Some(1));
    assert_eq!(state.unstaged[0].deleted, Some(1));
    assert_eq!(state.untracked[0].path, "untracked.txt");
    let staged = repo
        .diff(GitView::Staged, "space directory/change file.txt", None)
        .await;
    assert!(staged.patch.contains("-committed\n+staged"));
    assert!(!staged.patch.contains("+working"));
    let unstaged = repo
        .diff(GitView::Unstaged, "space directory/change file.txt", None)
        .await;
    assert!(unstaged.patch.contains("-staged\n+working"));
    let compare = repo
        .diff(GitView::Compare, "space directory/change file.txt", None)
        .await;
    assert!(compare.patch.contains("-baseline\n+committed"));
    assert!(!compare.patch.contains("working"));
    assert!(!compare.patch.contains("+staged"));
    let untracked = repo.diff(GitView::Untracked, "untracked.txt", None).await;
    assert!(
        untracked
            .unavailable_reason
            .unwrap()
            .contains("listed only")
    );
    assert!(untracked.patch.is_empty());
    assert_eq!(repo.git(&["rev-parse", "HEAD"]).trim(), head);
    assert_eq!(fs::read(repo.0.join(".git/index")).unwrap(), before_index);
    assert_eq!(fs::read(repo.0.join(".git/config")).unwrap(), before_config);
    assert_eq!(
        fs::read(repo.0.join("space directory/change file.txt")).unwrap(),
        before_worktree
    );
    assert!(!repo.0.join(".git/index.lock").exists());
}

#[tokio::test]
async fn comparison_uses_merge_base_not_tip_and_allows_local_remote_tracking_refs() {
    let repo = Repo::new();
    repo.write("feature.txt", "base\n");
    let base = repo.commit();
    repo.git(&["checkout", "--quiet", "-b", "feature"]);
    repo.write("feature.txt", "feature\n");
    let head = repo.commit();
    repo.git(&["checkout", "--quiet", "main"]);
    repo.write("target-only.txt", "must not appear in feature PR\n");
    let target = repo.commit();
    repo.git(&["update-ref", "refs/remotes/origin/target", &target]);
    repo.git(&["checkout", "--quiet", "feature"]);
    let state = workspace(repo.cwd(), Some("refs/remotes/origin/target"))
        .await
        .unwrap();
    assert_eq!(state.merge_base.as_deref(), Some(base.as_str()));
    assert_eq!(state.head.as_deref(), Some(head.as_str()));
    assert_eq!(state.base_commit.as_deref(), Some(target.as_str()));
    assert_eq!(state.compare.len(), 1);
    assert_eq!(state.compare[0].path, "feature.txt");
}

#[tokio::test]
async fn missing_upstream_and_unrelated_target_have_actionable_states() {
    let repo = Repo::new();
    repo.write("a", "a\n");
    repo.commit();
    repo.git(&["config", "branch.main.remote", "origin"]);
    repo.git(&["config", "branch.main.merge", "refs/heads/missing"]);
    repo.git(&[
        "config",
        "remote.origin.fetch",
        "+refs/heads/*:refs/remotes/origin/*",
    ]);
    let missing = workspace(repo.cwd(), None).await.unwrap();
    assert_eq!(
        missing.upstream.as_deref(),
        Some("refs/remotes/origin/missing")
    );
    assert!(
        missing
            .compare_unavailable_reason
            .unwrap()
            .contains("not available locally")
    );
    repo.git(&["checkout", "--quiet", "--orphan", "unrelated"]);
    repo.git(&["rm", "--quiet", "-rf", "."]);
    repo.write("b", "b\n");
    repo.commit();
    let unrelated = workspace(repo.cwd(), Some("refs/heads/main"))
        .await
        .unwrap();
    assert!(
        unrelated
            .compare_unavailable_reason
            .unwrap()
            .contains("no common ancestor")
    );
}

#[tokio::test]
async fn rename_and_literal_pathspec_names_remain_single_addressable_files() {
    let repo = Repo::new();
    repo.write("old name.txt", "one\ntwo\nthree\nfour\n");
    repo.write("[literal].txt", "literal\n");
    repo.commit();
    repo.git(&["mv", "--", "old name.txt", "new name.txt"]);
    repo.write("new name.txt", "one\ntwo\nthree\nfour\nfive\n");
    repo.git(&["add", "--all"]);
    let state = workspace(repo.cwd(), None).await.unwrap();
    let renamed = state
        .staged
        .iter()
        .find(|file| file.path == "new name.txt")
        .unwrap();
    assert_eq!(renamed.original_path.as_deref(), Some("old name.txt"));
    assert_eq!(renamed.added, Some(1));
    let preview = repo.diff(GitView::Staged, "new name.txt", None).await;
    assert!(preview.patch.contains("rename from old name.txt"));
    assert!(preview.patch.contains("rename to new name.txt"));
}

#[cfg(not(windows))]
#[tokio::test]
async fn newline_tab_and_pathspec_filenames_are_not_split_or_interpreted() {
    let repo = Repo::new();
    for name in ["line\nname.txt", "tab\tname.txt", ":(glob)*", "-option"] {
        repo.write(name, "old\n");
    }
    repo.commit();
    for name in ["line\nname.txt", "tab\tname.txt", ":(glob)*", "-option"] {
        repo.write(name, "new\n");
    }
    let state = workspace(repo.cwd(), None).await.unwrap();
    assert_eq!(state.unstaged.len(), 4);
    for name in ["line\nname.txt", "tab\tname.txt", ":(glob)*", "-option"] {
        assert!(state.unstaged.iter().any(|file| file.path == name));
        let preview = repo.diff(GitView::Unstaged, name, None).await;
        assert_eq!(preview.patch.matches("diff --git").count(), 1);
    }
}

#[test]
fn nul_parsers_cover_newlines_tabs_renames_submodules_and_conflicts() {
    let oid = "a".repeat(40);
    let status = format!(
        "2 R. N... 100644 100644 100644 {oid} {oid} R100 line\nnew\t.txt\0old\nname.txt\0\
        1 .M S.M. 160000 160000 160000 {oid} {oid} nested\0\
        u UU N... 100644 100644 100644 100644 {oid} {oid} {oid} conflict\0? untracked\nfile\0"
    );
    let (mut staged, unstaged, untracked) = parse_status(status.as_bytes()).unwrap();
    assert_eq!(staged[0].path, "line\nnew\t.txt");
    assert_eq!(staged[0].original_path.as_deref(), Some("old\nname.txt"));
    assert_eq!(unstaged[0].kind, "submodule");
    assert_eq!(unstaged[1].kind, "conflict");
    assert_eq!(untracked[0].path, "untracked\nfile");
    apply_numstat(&mut staged, b"3\t2\t\0old\nname.txt\0line\nnew\t.txt\0").unwrap();
    assert_eq!(staged[0].added, Some(3));
    let raw = format!(
        ":100644 100644 {oid} {oid} R100\0old\nname\0new\nname\0:160000 160000 {oid} {oid} M\0nested\0"
    );
    let parsed = parse_raw(raw.as_bytes()).unwrap();
    assert_eq!(parsed[0].original_path.as_deref(), Some("old\nname"));
    assert_eq!(parsed[1].kind, "submodule");
}

#[tokio::test]
async fn binary_and_large_patches_are_explicit_and_bounded() {
    let repo = Repo::new();
    repo.write("binary.dat", [0, 1, 2]);
    repo.write("large.txt", "initial\n");
    repo.write("long-line.txt", "initial\n");
    repo.commit();
    repo.write("binary.dat", [0, 4, 5]);
    repo.write("large.txt", "changed\n".repeat(PATCH_LINES + 100));
    repo.write(
        "long-line.txt",
        format!("{}\n", "x".repeat(PATCH_LIMIT + 1000)),
    );
    let binary = repo.diff(GitView::Unstaged, "binary.dat", None).await;
    assert!(binary.binary);
    assert!(binary.patch.is_empty());
    assert!(binary.unavailable_reason.unwrap().contains("Binary"));
    for file in ["large.txt", "long-line.txt"] {
        let preview = repo.diff(GitView::Unstaged, file, None).await;
        assert!(preview.truncated);
        assert!(preview.patch.len() <= PATCH_LIMIT);
        assert!(preview.patch.lines().count() <= PATCH_LINES);
        assert!(!preview.warnings.is_empty());
    }
}

#[tokio::test]
async fn injection_and_unchanged_paths_are_rejected() {
    let repo = Repo::new();
    repo.write("safe", "safe\n");
    repo.commit();
    for path in [
        "../outside",
        "/absolute",
        ".git/config",
        "safe/../outside",
        "safe\0bad",
        "",
    ] {
        assert!(
            diff(
                repo.cwd(),
                GitDiffRequest {
                    view: GitView::Unstaged,
                    path: path.into(),
                    base: None
                }
            )
            .await
            .is_err(),
            "{path:?}"
        );
    }
    for base in [
        "--output=bad",
        "HEAD^{tree}",
        "refs/heads/main:path",
        "main",
        "../main",
    ] {
        assert!(workspace(repo.cwd(), Some(base)).await.is_err(), "{base}");
    }
    assert!(
        diff(
            repo.cwd(),
            GitDiffRequest {
                view: GitView::Unstaged,
                path: "safe".into(),
                base: None
            }
        )
        .await
        .unwrap_err()
        .contains("no longer changed")
    );
}

#[tokio::test]
async fn external_diff_and_textconv_are_never_executed() {
    let repo = Repo::new();
    repo.write("safe.txt", "old\n");
    repo.write(".gitattributes", "*.txt diff=unsafe\n");
    repo.commit();
    repo.git(&["config", "diff.external", "THIS_MUST_NEVER_RUN"]);
    repo.git(&["config", "diff.unsafe.command", "THIS_MUST_NEVER_RUN"]);
    repo.git(&["config", "diff.unsafe.textconv", "THIS_MUST_NEVER_RUN"]);
    repo.git(&["config", "core.fsmonitor", "THIS_MUST_NEVER_RUN"]);
    repo.write(".gitattributes", "*.txt diff=unsafe filter=unsafe\n");
    repo.git(&["config", "filter.unsafe.clean", "THIS_MUST_NEVER_RUN"]);
    repo.git(&["config", "filter.unsafe.process", "THIS_MUST_NEVER_RUN"]);
    repo.git(&["config", "filter.unsafe.required", "true"]);
    repo.write("safe.txt", "new\n");
    let preview = repo.diff(GitView::Unstaged, "safe.txt", None).await;
    assert!(preview.patch.contains("+new"));
    let state = workspace(repo.cwd(), None).await.unwrap();
    assert_eq!(state.unstaged.len(), 2);
}

#[tokio::test]
async fn changed_content_gets_a_different_comment_identity() {
    let repo = Repo::new();
    repo.write("a", "baseline\n");
    repo.commit();
    repo.write("a", "first\n");
    let first = repo.diff(GitView::Unstaged, "a", None).await;
    repo.write("a", "second\n");
    let second = repo.diff(GitView::Unstaged, "a", None).await;
    assert_eq!(first.head, second.head);
    assert_ne!(first.content_id, second.content_id);
}

#[tokio::test]
async fn staged_symlinks_and_committed_submodules_are_explicit_without_target_reads() {
    let repo = Repo::new();
    repo.write("target-text", "unopened-target\n");
    let base = repo.commit();
    repo.git(&["checkout", "--quiet", "-b", "feature"]);
    let blob = repo.git(&["hash-object", "-w", "--", "target-text"]);
    repo.git(&[
        "update-index",
        "--add",
        "--cacheinfo",
        "120000",
        blob.trim(),
        "link",
    ]);
    let symlink = repo.diff(GitView::Staged, "link", None).await;
    assert_eq!(symlink.kind, "symlink");
    assert!(symlink.patch.contains("+unopened-target"));
    repo.git(&[
        "update-index",
        "--add",
        "--cacheinfo",
        "160000",
        &base,
        "nested",
    ]);
    let submodule = repo.diff(GitView::Staged, "nested", None).await;
    assert_eq!(submodule.kind, "submodule");
    assert!(submodule.patch.is_empty());
    assert!(
        submodule
            .unavailable_reason
            .unwrap()
            .contains("nested repository content")
    );
    repo.git(&["commit", "--quiet", "-m", "fixture gitlink and symlink"]);
    let state = workspace(repo.cwd(), Some("refs/heads/main"))
        .await
        .unwrap();
    assert!(
        state
            .compare
            .iter()
            .any(|file| file.path == "nested" && file.kind == "submodule")
    );
}

#[tokio::test]
async fn bounded_read_and_file_limit_never_return_unmarked_partial_data() {
    let bytes = vec![b'x'; 100];
    let (kept, truncated) = bounded_read(&bytes[..], 20).await.unwrap();
    assert_eq!(kept.len(), 20);
    assert!(truncated);
    let (kept, truncated) = bounded_read(&bytes[..], 100).await.unwrap();
    assert_eq!(kept.len(), 100);
    assert!(!truncated);
    let status = (0..=FILE_LIMIT)
        .map(|index| format!("? file-{index}\0"))
        .collect::<String>();
    assert!(
        parse_status(status.as_bytes())
            .unwrap_err()
            .contains("4000")
    );
}

#[tokio::test]
async fn successful_command_stderr_is_not_silently_discarded_and_bad_cwd_is_error() {
    let repo = Repo::new();
    assert!(
        workspace(repo.0.join("nonexistent").to_str().unwrap(), None)
            .await
            .unwrap_err()
            .contains("Cannot run Git")
    );
    let mut warnings = vec![];
    assert!(
        listing(repo.cwd(), &["not-a-real-git-command"], &mut warnings)
            .await
            .unwrap_err()
            .contains("Git inspection failed")
    );
}

#[cfg(unix)]
#[tokio::test]
async fn symlinks_show_link_changes_without_opening_the_target() {
    use std::os::unix::fs::symlink;
    let repo = Repo::new();
    symlink("outside-secret", repo.0.join("link")).unwrap();
    repo.commit();
    fs::remove_file(repo.0.join("link")).unwrap();
    symlink("another-target", repo.0.join("link")).unwrap();
    let preview = repo.diff(GitView::Unstaged, "link", None).await;
    assert_eq!(preview.kind, "symlink");
    assert!(preview.patch.contains("+another-target"));
    assert!(!preview.patch.contains("secret content"));
}
