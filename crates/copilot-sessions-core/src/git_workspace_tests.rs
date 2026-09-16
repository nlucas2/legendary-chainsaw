use super::*;
use std::{
    fs,
    path::PathBuf,
    process::Command as SyncCommand,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

#[tokio::test]
async fn untracked_text_previews_preserve_contents_and_response_contract() {
    let repo = Repo::new();
    repo.write("tracked", "baseline\n");
    let head = repo.commit();
    let before_index = fs::read(repo.0.join(".git/index")).unwrap();
    for (path, contents, body, count) in [
        (
            "nested/new file.txt",
            "first\nsecond\n",
            "+first\n+second\n",
            2,
        ),
        (
            "unicode-漢字-🦀.txt",
            "héllo 漢字 🦀\n",
            "+héllo 漢字 🦀\n",
            1,
        ),
        ("-option [literal].txt", "literal\n", "+literal\n", 1),
        (
            "no-final-newline.txt",
            "last",
            "+last\n\\ No newline at end of file\n",
            1,
        ),
        (
            "windows-lines.txt",
            "first\r\nsecond\r\n",
            "+first\r\n+second\r\n",
            2,
        ),
    ] {
        repo.write(path, contents);
        for context in [GitDiffContext::Changes, GitDiffContext::Full] {
            let preview = repo
                .diff_with_context(GitView::Untracked, path, None, context)
                .await;
            assert!(preview.unavailable_reason.is_none(), "{preview:?}");
            assert_eq!(preview.path, path);
            assert_eq!(preview.view, GitView::Untracked);
            assert_eq!(preview.context, context);
            assert_eq!(preview.kind, "untracked");
            assert_eq!(preview.head.as_deref(), Some(head.as_str()));
            assert!(!preview.repo_root.is_empty());
            assert!(preview.original_path.is_none());
            assert_eq!(preview.added, Some(count));
            assert_eq!(preview.deleted, Some(0));
            assert!(!preview.binary);
            assert!(!preview.truncated);
            assert_eq!(
                preview.full_context_complete,
                context == GitDiffContext::Full
            );
            assert!(preview.patch.contains("--- /dev/null\n"));
            assert!(
                preview
                    .patch
                    .contains(&format!("@@ -0,0 +1,{count} @@\n{body}")),
                "{preview:?}"
            );
            assert!(!preview.content_id.is_empty());
        }
        assert_eq!(fs::read(repo.0.join(path)).unwrap(), contents.as_bytes());
    }
    assert_eq!(fs::read(repo.0.join(".git/index")).unwrap(), before_index);
    let state = workspace(repo.cwd(), None).await.unwrap();
    assert!(state.unstaged.is_empty());
    assert_eq!(state.untracked.len(), 5);
}

#[tokio::test]
async fn untracked_empty_file_has_an_explicit_complete_zero_line_preview() {
    let repo = Repo::new();
    repo.write("empty", "");
    let preview = repo
        .diff_with_context(GitView::Untracked, "empty", None, GitDiffContext::Full)
        .await;
    assert!(preview.head.is_none());
    assert!(preview.unavailable_reason.is_none(), "{preview:?}");
    assert!(preview.patch.ends_with("@@ -0,0 +0,0 @@\n"));
    assert!(
        preview
            .warnings
            .iter()
            .any(|warning| warning.contains("Empty untracked file"))
    );
    assert_eq!(preview.added, Some(0));
    assert_eq!(preview.deleted, Some(0));
    assert!(preview.full_context_complete);
    assert!(!preview.truncated);
}

#[tokio::test]
async fn untracked_identity_tracks_changes_including_unread_tail_and_is_stable() {
    let repo = Repo::new();
    repo.write("new.txt", "first\n");
    let first = repo.diff(GitView::Untracked, "new.txt", None).await;
    let repeat = repo.diff(GitView::Untracked, "new.txt", None).await;
    assert_eq!(first.content_id, repeat.content_id);
    repo.write("new.txt", "next!\n");
    let second = repo.diff(GitView::Untracked, "new.txt", None).await;
    assert_eq!(first.head, second.head);
    assert_ne!(first.content_id, second.content_id);
    repo.write("large.txt", "line\n".repeat(PATCH_LINES * 20));
    let large = repo.diff(GitView::Untracked, "large.txt", None).await;
    {
        use std::io::Write;
        fs::OpenOptions::new()
            .append(true)
            .open(repo.0.join("large.txt"))
            .unwrap()
            .write_all(b"unread tail changed\n")
            .unwrap();
    }
    let larger = repo.diff(GitView::Untracked, "large.txt", None).await;
    assert!(large.truncated && larger.truncated);
    assert_eq!(large.patch, larger.patch);
    assert_ne!(large.content_id, larger.content_id);
}

#[tokio::test]
async fn untracked_caps_bound_lines_bytes_and_keep_utf8_characters_whole() {
    let repo = Repo::new();
    for (path, contents) in [
        ("many-lines", "line\n".repeat(PATCH_LINES * 30)),
        (
            "many-bytes",
            format!("{}\n", "漢".repeat(300)).repeat(PATCH_LINES),
        ),
        ("huge-first-line", "x".repeat(PATCH_LIMIT * 2)),
    ] {
        repo.write(path, contents);
        let preview = repo
            .diff_with_context(GitView::Untracked, path, None, GitDiffContext::Full)
            .await;
        assert!(preview.unavailable_reason.is_none(), "{preview:?}");
        assert!(preview.truncated);
        assert!(!preview.binary);
        assert!(!preview.full_context_complete);
        assert!(preview.patch.len() <= PATCH_LIMIT);
        assert!(preview.patch.lines().count() <= PATCH_LINES);
        assert!(preview.patch.ends_with('\n'));
        assert!(preview.added.is_none());
        assert!(
            preview
                .warnings
                .iter()
                .any(|warning| warning.contains("truncated at 192 KiB or 2500 lines"))
        );
        assert!(!preview.patch.contains("\\ No newline at end of file"));
    }
    repo.write(
        "utf8-boundary",
        format!("{}€\n", "x".repeat(PATCH_LIMIT - 1)),
    );
    let boundary = repo.diff(GitView::Untracked, "utf8-boundary", None).await;
    assert!(boundary.truncated);
    assert!(!boundary.binary, "{boundary:?}");
    assert!(boundary.unavailable_reason.is_none());
}

#[tokio::test]
async fn untracked_binary_and_non_utf8_have_no_text_preview() {
    let repo = Repo::new();
    for (path, contents) in [
        ("binary", b"prefix\0binary\n".as_slice()),
        ("invalid", b"\xffnot utf8\n".as_slice()),
        ("unfinished-utf8", b"text\xe2\x82".as_slice()),
    ] {
        repo.write(path, contents);
        let preview = repo
            .diff_with_context(GitView::Untracked, path, None, GitDiffContext::Full)
            .await;
        assert!(preview.binary);
        assert!(preview.patch.is_empty());
        assert!(!preview.full_context_complete);
        assert!(
            preview
                .unavailable_reason
                .unwrap()
                .contains("binary or not UTF-8")
        );
    }
}

#[tokio::test]
async fn untracked_exact_patch_budgets_and_missing_newline_are_not_falsely_complete() {
    let repo = Repo::new();
    repo.write("lines", "line\n".repeat(PATCH_LINES - 5));
    let exact_lines = repo
        .diff_with_context(GitView::Untracked, "lines", None, GitDiffContext::Full)
        .await;
    assert_eq!(exact_lines.patch.lines().count(), PATCH_LINES);
    assert!(exact_lines.full_context_complete);
    repo.write("lines", format!("{}last", "line\n".repeat(PATCH_LINES - 6)));
    let newline_marker = repo
        .diff_with_context(GitView::Untracked, "lines", None, GitDiffContext::Full)
        .await;
    assert!(newline_marker.truncated);
    assert!(!newline_marker.full_context_complete);
    assert!(
        !newline_marker
            .patch
            .contains("\\ No newline at end of file")
    );
    let header = "diff --git a/bytes b/bytes\nnew file mode 100644\n--- /dev/null\n+++ b/bytes\n@@ -0,0 +1,1 @@\n";
    repo.write(
        "bytes",
        format!("{}\n", "x".repeat(PATCH_LIMIT - header.len() - 2)),
    );
    let exact_bytes = repo
        .diff_with_context(GitView::Untracked, "bytes", None, GitDiffContext::Full)
        .await;
    assert_eq!(exact_bytes.patch.len(), PATCH_LIMIT);
    assert!(exact_bytes.full_context_complete);
    repo.write(
        "bytes",
        format!("{}\n", "x".repeat(PATCH_LIMIT - header.len() - 1)),
    );
    let over_bytes = repo
        .diff_with_context(GitView::Untracked, "bytes", None, GitDiffContext::Full)
        .await;
    assert!(over_bytes.truncated);
    assert!(!over_bytes.full_context_complete);
    assert_eq!(over_bytes.added, Some(1));
}

#[tokio::test]
async fn untracked_requires_exact_current_nonignored_git_membership() {
    let repo = Repo::new();
    repo.write("tracked", "baseline\n");
    repo.write(".gitignore", "ignored\n");
    repo.commit();
    repo.write("ignored", "MUST NOT APPEAR\n");
    repo.write("new.txt", "new text\n");
    for path in ["tracked", "ignored", "vanished", "NEW.txt", "folder"] {
        let preview = repo.diff(GitView::Untracked, path, None).await;
        assert!(preview.patch.is_empty(), "{preview:?}");
        assert!(
            preview
                .unavailable_reason
                .unwrap()
                .contains("no longer a Git-listed")
        );
    }
    repo.git(&["add", "--", "new.txt"]);
    let staged = repo.diff(GitView::Untracked, "new.txt", None).await;
    assert!(staged.patch.is_empty());
    assert!(staged.unavailable_reason.is_some());
    let nested = repo.0.join("nested");
    fs::create_dir(&nested).unwrap();
    let nested_repo = Repo(nested);
    nested_repo.git(&["init", "--quiet", "--initial-branch=main"]);
    nested_repo.git(&["config", "user.name", "Git Workspace Fixture"]);
    nested_repo.git(&["config", "user.email", "fixture@example.invalid"]);
    nested_repo.git(&["config", "commit.gpgsign", "false"]);
    nested_repo.write("inner", "NESTED MUST NOT APPEAR\n");
    nested_repo.commit();
    let directory = repo.diff(GitView::Untracked, "nested", None).await;
    assert!(directory.patch.is_empty());
    assert!(
        directory
            .unavailable_reason
            .as_deref()
            .unwrap()
            .contains("nested repository"),
        "{directory:?}"
    );
    let inner = repo.diff(GitView::Untracked, "nested/inner", None).await;
    assert!(inner.patch.is_empty());
    assert!(inner.unavailable_reason.is_some());
    assert!(untracked::Snapshot::read(repo.cwd().into(), "nested/inner".into()).is_err());
}

#[test]
fn untracked_rejects_metadata_traversal_and_windows_device_aliases() {
    let repo = Repo::new();
    for path in [
        "../outside",
        "/outside",
        "a/../../outside",
        "a//b",
        ".git/config",
        "a/.GiT/config",
        "a/./b",
    ] {
        assert!(
            untracked::Snapshot::read(repo.cwd().into(), path.into()).is_err(),
            "{path}"
        );
    }
    #[cfg(windows)]
    for path in [
        "C:/outside",
        "C:outside",
        r"\\server\share\file",
        r"\\?\C:\outside",
        r"\\.\NUL",
        "new.txt:stream",
        r"parent\outside",
        "NUL",
        "nul.txt",
        "CON",
        "CONOUT$",
        "aux.log",
        "COM1.txt",
        "LPT¹",
        "parent/PRN.txt",
        "parent./file",
        "parent /file",
        ".git /config",
        "GIT~1/config",
    ] {
        assert!(
            untracked::Snapshot::read(repo.cwd().into(), path.into()).is_err(),
            "{path}"
        );
    }
}

#[test]
fn untracked_snapshot_prevents_or_detects_updates_and_replacements() {
    let repo = Repo::new();
    repo.write("parent/new", "snapshot\n");
    let snapshot = untracked::Snapshot::read(repo.cwd().into(), "parent/new".into()).unwrap();
    #[cfg(windows)]
    {
        assert!(fs::write(repo.0.join("parent/new"), "changed!\n").is_err());
        assert!(fs::remove_file(repo.0.join("parent/new")).is_err());
        assert!(fs::rename(repo.0.join("parent"), repo.0.join("moved")).is_err());
        assert!(snapshot.validate().is_ok());
    }
    #[cfg(unix)]
    {
        fs::write(repo.0.join("parent/new"), "changed!\n").unwrap();
        assert!(snapshot.validate().is_err());
        fs::remove_file(repo.0.join("parent/new")).unwrap();
        repo.write("parent/new", "snapshot\n");
        assert!(snapshot.validate().is_err());
    }
    drop(snapshot);
    fs::write(repo.0.join("parent/new"), "writable after inspection\n").unwrap();
    #[cfg(unix)]
    {
        let snapshot = untracked::Snapshot::read(repo.cwd().into(), "parent/new".into()).unwrap();
        fs::rename(repo.0.join("parent"), repo.0.join("moved")).unwrap();
        fs::create_dir(repo.0.join("parent")).unwrap();
        repo.write("parent/new", "replacement directory\n");
        assert!(snapshot.validate().is_err());
    }
}

#[test]
fn untracked_hard_links_are_not_opened() {
    let repo = Repo::new();
    let outside = Repo::empty();
    outside.write("secret", "OUTSIDE SECRET\n");
    fs::hard_link(outside.0.join("secret"), repo.0.join("link")).unwrap();
    let error = untracked::Snapshot::read(repo.cwd().into(), "link".into())
        .err()
        .unwrap();
    assert!(error.contains("Hard-linked"), "{error}");
}

#[cfg(windows)]
#[tokio::test]
async fn untracked_windows_junctions_and_ancestor_junctions_never_read_targets() {
    let repo = Repo::new();
    let outside = Repo::empty();
    outside.write("secret", "OUTSIDE SECRET\n");
    let junction = repo.0.join("junction");
    let status = SyncCommand::new(std::env::var_os("ComSpec").unwrap())
        .args(["/c", "mklink", "/J"])
        .arg(&junction)
        .arg(&outside.0)
        .stdout(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "Cannot create isolated junction fixture");
    for path in ["junction", "junction/secret"] {
        assert!(
            untracked::Snapshot::read(repo.cwd().into(), path.into()).is_err(),
            "{path}"
        );
        let preview = repo.diff(GitView::Untracked, path, None).await;
        assert!(preview.patch.is_empty(), "{preview:?}");
        assert!(preview.unavailable_reason.is_some());
    }
    fs::remove_dir(&junction).unwrap();
    assert_eq!(
        fs::read(outside.0.join("secret")).unwrap(),
        b"OUTSIDE SECRET\n"
    );
}

#[cfg(any(unix, windows))]
#[tokio::test]
async fn untracked_file_and_directory_symlinks_never_read_targets() {
    let repo = Repo::new();
    let outside = Repo::empty();
    outside.write("secret", "OUTSIDE SECRET\n");
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(outside.0.join("secret"), repo.0.join("link")).unwrap();
        std::os::unix::fs::symlink(&outside.0, repo.0.join("parent")).unwrap();
    }
    #[cfg(windows)]
    {
        if let Err(error) =
            std::os::windows::fs::symlink_file(outside.0.join("secret"), repo.0.join("link"))
        {
            if error.raw_os_error() == Some(1314) {
                eprintln!(
                    "Windows symlink privilege unavailable; junction safety is tested separately."
                );
                return;
            }
            panic!("Cannot create symlink fixture: {error}");
        }
        std::os::windows::fs::symlink_dir(&outside.0, repo.0.join("parent")).unwrap();
    }
    for path in ["link", "parent/secret"] {
        assert!(
            untracked::Snapshot::read(repo.cwd().into(), path.into()).is_err(),
            "{path}"
        );
        let preview = repo.diff(GitView::Untracked, path, None).await;
        assert!(preview.patch.is_empty(), "{preview:?}");
        assert!(preview.unavailable_reason.is_some());
    }
    fs::remove_file(repo.0.join("link")).unwrap();
    #[cfg(windows)]
    fs::remove_dir(repo.0.join("parent")).unwrap();
    #[cfg(unix)]
    fs::remove_file(repo.0.join("parent")).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn untracked_unix_unusual_paths_are_literal_and_headers_are_quoted() {
    let repo = Repo::new();
    for path in [
        "line\nname",
        "tab\tname",
        "quote\"name",
        "back\\slash",
        ":(glob)*",
    ] {
        repo.write(path, "literal\n");
        let preview = repo.diff(GitView::Untracked, path, None).await;
        assert!(preview.unavailable_reason.is_none(), "{preview:?}");
        assert_eq!(preview.path, path);
        assert!(preview.patch.ends_with("@@ -0,0 +1,1 @@\n+literal\n"));
        assert_eq!(preview.patch.lines().count(), 6);
    }
    {
        use std::os::unix::fs::PermissionsExt;
        repo.write("executable", "#!/bin/sh\n");
        fs::set_permissions(repo.0.join("executable"), fs::Permissions::from_mode(0o755)).unwrap();
        let preview = repo.diff(GitView::Untracked, "executable", None).await;
        assert!(preview.patch.contains("new file mode 100755\n"));
    }
}

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
        self.diff_with_context(view, path, base, GitDiffContext::Changes)
            .await
    }
    async fn diff_with_context(
        &self,
        view: GitView,
        path: &str,
        base: Option<&str>,
        context: GitDiffContext,
    ) -> GitDiff {
        diff(
            self.cwd(),
            GitDiffRequest {
                view,
                path: path.into(),
                base: base.map(str::to_owned),
                context,
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

#[test]
fn diff_context_defaults_to_changes_and_rejects_invalid_values() {
    let request: GitDiffRequest =
        serde_json::from_value(serde_json::json!({"view": "unstaged", "path": "a"})).unwrap();
    assert_eq!(request.context, GitDiffContext::Changes);
    for (value, context) in [
        ("changes", GitDiffContext::Changes),
        ("full", GitDiffContext::Full),
    ] {
        let request: GitDiffRequest = serde_json::from_value(serde_json::json!({
            "view": "staged", "path": "a", "context": value
        }))
        .unwrap();
        assert_eq!(request.context, context);
        assert_eq!(serde_json::to_value(context).unwrap(), value);
    }
    for value in [
        serde_json::json!("FULL"),
        serde_json::json!("all"),
        serde_json::json!("--output=unsafe"),
        serde_json::json!(2147483647),
        serde_json::Value::Null,
    ] {
        assert!(
            serde_json::from_value::<GitDiffRequest>(serde_json::json!({
                "view": "unstaged", "path": "a", "context": value
            }))
            .is_err(),
            "{value}"
        );
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
    let full = repo
        .diff_with_context(GitView::Staged, "first.txt", None, GitDiffContext::Full)
        .await;
    assert!(full.full_context_complete);
    assert!(full.patch.contains("+first"));
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
    for context in [GitDiffContext::Changes, GitDiffContext::Full] {
        let untracked = repo
            .diff_with_context(GitView::Untracked, "untracked.txt", None, context)
            .await;
        assert!(untracked.unavailable_reason.is_none(), "{untracked:?}");
        assert!(untracked.patch.contains("@@ -0,0 +1,1 @@\n+not staged\n"));
        assert_eq!(untracked.kind, "untracked");
        assert_eq!(
            untracked.full_context_complete,
            context == GitDiffContext::Full
        );
    }
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
async fn full_context_includes_unchanged_lines_and_preserves_each_read_only_view() {
    let repo = Repo::new();
    let path = "space directory/change file.txt";
    let contents = |version| {
        format!(
            "distant-prefix\n{}first-{version}\n{}second-{version}\n{}distant-suffix\n",
            "unchanged-prefix\n".repeat(20),
            "unchanged-middle\n".repeat(20),
            "unchanged-suffix\n".repeat(20)
        )
    };
    repo.write(path, contents("baseline"));
    repo.commit();
    repo.git(&["checkout", "--quiet", "-b", "feature"]);
    repo.git(&["branch", "--set-upstream-to=main"]);
    repo.write(path, contents("committed"));
    let head = repo.commit();
    repo.write(path, contents("staged"));
    repo.git(&["add", "--all"]);
    repo.write(path, contents("working"));
    repo.git(&["config", "diff.context", "100"]);
    let before_index = fs::read(repo.0.join(".git/index")).unwrap();
    let before_config = fs::read(repo.0.join(".git/config")).unwrap();
    let before_worktree = fs::read(repo.0.join(path)).unwrap();
    let before_refs = repo.git(&["show-ref"]);
    for (view, old, new) in [
        (GitView::Staged, "committed", "staged"),
        (GitView::Unstaged, "staged", "working"),
        (GitView::Compare, "baseline", "committed"),
    ] {
        let changes = repo.diff(view, path, None).await;
        assert_eq!(changes.context, GitDiffContext::Changes);
        assert!(!changes.full_context_complete);
        assert!(!changes.patch.contains("distant-prefix"));
        assert!(!changes.patch.contains("distant-suffix"));
        assert_eq!(
            changes
                .patch
                .lines()
                .filter(|line| line.starts_with("@@ "))
                .count(),
            2
        );
        let full = repo
            .diff_with_context(view, path, None, GitDiffContext::Full)
            .await;
        assert_eq!(full.context, GitDiffContext::Full);
        assert!(full.full_context_complete);
        assert!(!full.truncated);
        assert!(full.patch.contains("\n distant-prefix\n"));
        assert!(full.patch.ends_with(" distant-suffix\n"));
        assert!(full.patch.contains("@@ -1,64 +1,64 @@"));
        for edit in ["first", "second"] {
            let expected = format!("-{edit}-{old}\n+{edit}-{new}\n");
            assert!(changes.patch.contains(&expected), "{}", changes.patch);
            assert!(full.patch.contains(&expected), "{}", full.patch);
        }
        for other in ["baseline", "committed", "staged", "working"] {
            if other != old && other != new {
                assert!(!full.patch.contains(&format!("first-{other}")));
            }
        }
        assert_eq!((full.added, full.deleted), (Some(2), Some(2)));
        assert_eq!((full.added, full.deleted), (changes.added, changes.deleted));
        assert_eq!(full.head, changes.head);
        assert_eq!(full.merge_base, changes.merge_base);
        assert_ne!(full.content_id, changes.content_id);
        let serialized = serde_json::to_value(&full).unwrap();
        assert_eq!(serialized["context"], "full");
        assert_eq!(serialized["fullContextComplete"], true);
    }
    assert_eq!(fs::read(repo.0.join(".git/index")).unwrap(), before_index);
    assert_eq!(fs::read(repo.0.join(".git/config")).unwrap(), before_config);
    assert_eq!(fs::read(repo.0.join(path)).unwrap(), before_worktree);
    assert_eq!(repo.git(&["rev-parse", "HEAD"]).trim(), head);
    assert_eq!(repo.git(&["show-ref"]), before_refs);
    assert!(!repo.0.join(".git/index.lock").exists());
}

#[tokio::test]
async fn full_context_handles_added_and_deleted_files_using_index_and_commits() {
    let repo = Repo::new();
    let deleted = format!(
        "deleted-prefix\n{}deleted-suffix\n",
        "removed line\n".repeat(20)
    );
    let added = format!("added-prefix\n{}added-suffix\n", "new line\n".repeat(20));
    repo.write("deleted.txt", &deleted);
    repo.commit();
    repo.git(&["checkout", "--quiet", "-b", "feature"]);
    repo.git(&["branch", "--set-upstream-to=main"]);
    fs::remove_file(repo.0.join("deleted.txt")).unwrap();
    let unstaged = repo
        .diff_with_context(GitView::Unstaged, "deleted.txt", None, GitDiffContext::Full)
        .await;
    assert!(unstaged.full_context_complete);
    assert!(
        unstaged
            .patch
            .contains("--- a/deleted.txt\n+++ /dev/null\n")
    );
    assert!(unstaged.patch.contains("-deleted-prefix\n"));
    assert!(unstaged.patch.ends_with("-deleted-suffix\n"));
    repo.write("added.txt", &added);
    repo.git(&["add", "--all"]);
    repo.write("added.txt", "unstaged text must not appear\n");
    repo.write("deleted.txt", "recreated untracked text must not appear\n");
    for view in [GitView::Staged, GitView::Compare] {
        if view == GitView::Compare {
            repo.git(&["commit", "--quiet", "-m", "commit index only"]);
        }
        for (path, prefix, suffix, counts) in [
            (
                "added.txt",
                "+added-prefix\n",
                "+added-suffix\n",
                (Some(22), Some(0)),
            ),
            (
                "deleted.txt",
                "-deleted-prefix\n",
                "-deleted-suffix\n",
                (Some(0), Some(22)),
            ),
        ] {
            let full = repo
                .diff_with_context(view, path, None, GitDiffContext::Full)
                .await;
            assert!(full.full_context_complete, "{}", full.patch);
            assert!(full.patch.contains(prefix));
            assert!(full.patch.ends_with(suffix));
            assert!(!full.patch.contains("must not appear"));
            assert_eq!((full.added, full.deleted), counts);
            assert!(!full.truncated);
        }
    }
}

#[tokio::test]
async fn full_context_is_explicitly_incomplete_for_metadata_only_changes() {
    let repo = Repo::new();
    repo.write("old-name.txt", "unchanged rename contents\n");
    repo.write("mode.txt", "unchanged mode contents\n");
    repo.commit();
    repo.git(&["mv", "--", "old-name.txt", "new-name.txt"]);
    repo.git(&["update-index", "--chmod=+x", "--", "mode.txt"]);
    repo.write("empty.txt", "");
    repo.git(&["add", "--", "empty.txt"]);
    for (path, metadata) in [
        ("new-name.txt", "rename to new-name.txt"),
        ("mode.txt", "new mode 100755"),
        ("empty.txt", "new file mode"),
    ] {
        let full = repo
            .diff_with_context(GitView::Staged, path, None, GitDiffContext::Full)
            .await;
        assert!(!full.full_context_complete);
        assert!(!full.truncated);
        assert!(full.unavailable_reason.is_none());
        assert!(full.patch.contains(metadata), "{}", full.patch);
        assert!(!full.patch.contains("@@ "));
        assert!(!full.patch.contains("unchanged"));
        assert!(
            full.warnings
                .iter()
                .any(|warning| warning.contains("full-file contents are not displayed"))
        );
    }
}

#[tokio::test]
async fn full_context_unchanged_contents_obey_byte_and_line_caps() {
    let repo = Repo::new();
    let lines = format!(
        "old\n{}distant-suffix\n",
        "unchanged\n".repeat(PATCH_LINES + 100)
    );
    let bytes = format!(
        "old\n{}{}\ndistant-suffix\n",
        "unchanged\n".repeat(20),
        "😀".repeat(PATCH_LIMIT / 4 + 100)
    );
    repo.write("lines.txt", &lines);
    repo.write("bytes.txt", &bytes);
    repo.commit();
    repo.write("lines.txt", lines.replacen("old\n", "new\n", 1));
    repo.write("bytes.txt", bytes.replacen("old\n", "new\n", 1));
    for path in ["lines.txt", "bytes.txt"] {
        let changes = repo.diff(GitView::Unstaged, path, None).await;
        assert!(!changes.truncated);
        assert!(changes.patch.len() < 1000);
        let full = repo
            .diff_with_context(GitView::Unstaged, path, None, GitDiffContext::Full)
            .await;
        assert!(full.truncated);
        assert!(!full.full_context_complete);
        assert!(!full.binary);
        assert!(full.unavailable_reason.is_none());
        assert!(full.patch.contains("-old\n+new\n"));
        assert!(!full.patch.contains("distant-suffix"));
        assert!(full.patch.len() <= PATCH_LIMIT);
        assert!(full.patch.lines().count() <= PATCH_LINES);
        assert!(full.patch.ends_with('\n'));
        assert!(
            full.warnings
                .iter()
                .any(|warning| warning.contains("truncated at 192 KiB or 2500 lines"))
        );
    }
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
    let full = repo
        .diff_with_context(GitView::Staged, "new name.txt", None, GitDiffContext::Full)
        .await;
    assert!(full.full_context_complete);
    assert!(full.patch.contains("rename from old name.txt"));
    assert!(full.patch.contains("\n one\n"));
    assert!(full.patch.contains("+five\n"));
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
    for context in [GitDiffContext::Changes, GitDiffContext::Full] {
        let binary = repo
            .diff_with_context(GitView::Unstaged, "binary.dat", None, context)
            .await;
        assert!(binary.binary);
        assert!(binary.patch.is_empty());
        assert!(binary.unavailable_reason.unwrap().contains("Binary"));
        assert!(!binary.full_context_complete);
    }
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
    for context in [GitDiffContext::Changes, GitDiffContext::Full] {
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
                        base: None,
                        context,
                    }
                )
                .await
                .is_err(),
                "{path:?}"
            );
        }
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
    repo.write("untracked.txt", "not a tracked change\n");
    for context in [GitDiffContext::Changes, GitDiffContext::Full] {
        for path in ["safe", "untracked.txt"] {
            assert!(
                diff(
                    repo.cwd(),
                    GitDiffRequest {
                        view: GitView::Unstaged,
                        path: path.into(),
                        base: None,
                        context,
                    }
                )
                .await
                .unwrap_err()
                .contains("no longer changed")
            );
        }
    }
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
    repo.write("untracked.txt", "unfiltered new text\n");
    for context in [GitDiffContext::Changes, GitDiffContext::Full] {
        let preview = repo
            .diff_with_context(GitView::Unstaged, "safe.txt", None, context)
            .await;
        assert!(preview.patch.contains("+new"));
        let untracked = repo
            .diff_with_context(GitView::Untracked, "untracked.txt", None, context)
            .await;
        assert!(
            untracked.patch.contains("+unfiltered new text"),
            "{untracked:?}"
        );
    }
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
    for context in [GitDiffContext::Changes, GitDiffContext::Full] {
        let symlink = repo
            .diff_with_context(GitView::Staged, "link", None, context)
            .await;
        assert_eq!(symlink.kind, "symlink");
        assert!(symlink.patch.contains("+unopened-target"));
    }
    repo.git(&[
        "update-index",
        "--add",
        "--cacheinfo",
        "160000",
        &base,
        "nested",
    ]);
    for context in [GitDiffContext::Changes, GitDiffContext::Full] {
        let submodule = repo
            .diff_with_context(GitView::Staged, "nested", None, context)
            .await;
        assert_eq!(submodule.kind, "submodule");
        assert!(submodule.patch.is_empty());
        assert!(!submodule.full_context_complete);
        assert!(
            submodule
                .unavailable_reason
                .unwrap()
                .contains("nested repository content")
        );
    }
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
