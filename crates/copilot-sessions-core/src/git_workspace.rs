//! Read-only, local Git inspection. Callers must resolve CWD from the session service.
use std::{
    collections::HashMap,
    path::{Component, Path},
    process::Stdio,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tokio::{io::AsyncReadExt, process::Command};

const LIST_LIMIT: usize = 2 * 1024 * 1024;
const PATCH_LIMIT: usize = 192 * 1024;
const PATCH_LINES: usize = 2500;
const FILE_LIMIT: usize = 4000;
const TIMEOUT: Duration = Duration::from_secs(15);

#[path = "git_untracked.rs"]
mod untracked;
#[path = "git_refs.rs"]
mod refs;
pub use refs::{GitReferences, reference_targets};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GitView {
    Staged,
    Unstaged,
    Compare,
    Untracked,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GitDiffContext {
    #[default]
    Changes,
    Full,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitDiffRequest {
    pub view: GitView,
    pub path: String,
    pub base: Option<String>,
    #[serde(default)]
    pub context: GitDiffContext,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRef {
    pub name: String,
    pub commit: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    pub path: String,
    pub original_path: Option<String>,
    pub status: String,
    pub kind: String,
    pub added: Option<u64>,
    pub deleted: Option<u64>,
    pub binary: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorkspace {
    pub state: String,
    pub repo_root: Option<String>,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub base: Option<String>,
    pub base_commit: Option<String>,
    pub merge_base: Option<String>,
    pub detached: bool,
    pub unborn: bool,
    pub refs: Vec<GitRef>,
    pub refs_has_more: bool,
    pub staged: Vec<GitFile>,
    pub unstaged: Vec<GitFile>,
    pub untracked: Vec<GitFile>,
    pub compare: Vec<GitFile>,
    pub compare_unavailable_reason: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiff {
    pub repo_root: String,
    pub path: String,
    pub original_path: Option<String>,
    pub view: GitView,
    pub context: GitDiffContext,
    /// True only when full context was requested and uncapped text hunks were returned.
    pub full_context_complete: bool,
    pub head: Option<String>,
    pub base: Option<String>,
    pub base_commit: Option<String>,
    pub merge_base: Option<String>,
    pub content_id: String,
    pub patch: String,
    pub truncated: bool,
    pub binary: bool,
    pub kind: String,
    pub added: Option<u64>,
    pub deleted: Option<u64>,
    pub unavailable_reason: Option<String>,
    pub warnings: Vec<String>,
}

struct Output {
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: String,
    truncated: bool,
}

async fn bounded_read<R: tokio::io::AsyncRead + Unpin>(
    mut reader: R,
    limit: usize,
) -> std::io::Result<(Vec<u8>, bool)> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 8192];
    let mut truncated = false;
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        let keep = read.min(limit.saturating_sub(bytes.len()));
        bytes.extend_from_slice(&buffer[..keep]);
        truncated |= keep < read;
    }
    Ok((bytes, truncated))
}

async fn run_git(
    cwd: &str,
    args: &[&str],
    limit: usize,
    filter_keys: &[String],
) -> Result<Output, String> {
    run_git_output(cwd, args, limit, filter_keys, None).await
}

async fn run_git_output(
    cwd: &str,
    args: &[&str],
    limit: usize,
    filter_keys: &[String],
    ref_query: Option<&str>,
) -> Result<Output, String> {
    let mut command = Command::new("git");
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    command
        .current_dir(cwd)
        .args([
            "--no-pager",
            "-c",
            "core.quotePath=false",
            "-c",
            "diff.external=",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
            "-c",
            "color.ui=false",
        ])
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // A daemon's inherited Git environment must not redirect the repository/index,
    // inject config, trace file writes, or enable lazy network object retrieval.
    for (name, _) in std::env::vars_os() {
        if name
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("GIT_")
        {
            command.env_remove(name);
        }
    }
    command
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("LC_ALL", "C");
    command.env("GIT_CONFIG_COUNT", filter_keys.len().to_string());
    for (index, key) in filter_keys.iter().enumerate() {
        command.env(format!("GIT_CONFIG_KEY_{index}"), key);
        command.env(
            format!("GIT_CONFIG_VALUE_{index}"),
            if key.ends_with(".required") {
                "false"
            } else {
                ""
            },
        );
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Cannot run Git: {error}"))?;
    let stdout = child.stdout.take().ok_or("Git stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("Git stderr unavailable")?;
    let execution = async {
        let read_stdout = Box::pin(async {
            match ref_query {
                Some(query) => refs::read_ref_listing(stdout, query).await,
                None => bounded_read(stdout, limit).await,
            }
        });
        let (status, stdout, stderr) = tokio::try_join!(
            child.wait(),
            read_stdout,
            bounded_read(stderr, 32 * 1024)
        )?;
        Ok::<_, std::io::Error>((status, stdout, stderr))
    };
    match tokio::time::timeout(TIMEOUT, execution).await {
        Ok(Ok((status, (stdout, truncated), (stderr, stderr_truncated)))) => {
            let mut stderr = String::from_utf8_lossy(&stderr).trim().to_owned();
            if stderr_truncated {
                stderr.push_str(" [Git diagnostics truncated]");
            }
            Ok(Output {
                code: status.code(),
                stdout,
                stderr,
                truncated,
            })
        }
        Ok(Err(error)) => Err(format!("Cannot read Git output: {error}")),
        Err(_) => {
            let _ = child.kill().await;
            Err("Git inspection timed out after 15 seconds; narrow the workspace and retry.".into())
        }
    }
}

async fn git(cwd: &str, args: &[&str], limit: usize) -> Result<Output, String> {
    let mut filter_keys = vec![];
    let mut diagnostics = String::new();
    if matches!(args.first(), Some(&"status" | &"diff")) {
        // --no-textconv alone does not stop attribute clean/process filters.
        // Ask Git for names only (never values), then disable every configured driver.
        let config = run_git(
            cwd,
            &[
                "config",
                "--null",
                "--name-only",
                "--get-regexp",
                r"^filter\..*\.(clean|smudge|process|required)$",
            ],
            64 * 1024,
            &[],
        )
        .await?;
        if config.code != Some(1) || !config.stderr.is_empty() {
            checked(Output {
                code: config.code,
                stdout: vec![],
                stderr: config.stderr.clone(),
                truncated: false,
            })?;
        }
        if config.truncated {
            return Err("Git filter configuration exceeds the safe inspection limit.".into());
        }
        for key in config
            .stdout
            .split(|byte| *byte == 0)
            .filter(|key| !key.is_empty())
        {
            filter_keys.push(text(key)?.to_owned());
        }
        if filter_keys.len() > 256 {
            return Err("Too many configured Git filters for safe read-only inspection.".into());
        }
        diagnostics = config.stderr;
    }
    let mut output = run_git(cwd, args, limit, &filter_keys).await?;
    if !filter_keys.is_empty() {
        output.stderr.push_str("\nConfigured Git clean/process filters are disabled for safe inspection; previews show unfiltered content.");
    }
    if !diagnostics.is_empty() {
        output.stderr = format!("{diagnostics}\n{}", output.stderr);
    }
    Ok(output)
}

fn checked(output: Output) -> Result<Output, String> {
    if output.code != Some(0) {
        return Err(format!(
            "Git inspection failed (exit {:?}): {}",
            output.code, output.stderr
        ));
    }
    Ok(output)
}

async fn listing(cwd: &str, args: &[&str], warnings: &mut Vec<String>) -> Result<Vec<u8>, String> {
    let output = checked(git(cwd, args, LIST_LIMIT).await?)?;
    if output.truncated {
        return Err(
            "Git metadata exceeds the 2 MiB inspection limit; no partial file list is shown."
                .into(),
        );
    }
    if !output.stderr.is_empty() {
        warnings.push(output.stderr);
    }
    Ok(output.stdout)
}

fn text(bytes: &[u8]) -> Result<&str, String> {
    std::str::from_utf8(bytes)
        .map_err(|_| "Git returned a filename or metadata that is not valid UTF-8; it cannot be addressed safely.".into())
}

fn line(bytes: &[u8]) -> Result<String, String> {
    let text = text(bytes)?;
    Ok(text.strip_suffix('\n').unwrap_or(text).to_owned())
}

fn valid_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_path(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 16 * 1024
        || value.contains('\0')
        || value.starts_with('/')
        || value.split('/').any(|part| {
            part.is_empty() || part == "." || part == ".." || part.eq_ignore_ascii_case(".git")
        })
        || Path::new(value)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        || (cfg!(windows)
            && (value.contains('\\')
                || value.contains(':')
                || value.split('/').any(invalid_windows_component)))
    {
        return Err("Invalid repository-relative Git path.".into());
    }
    Ok(())
}

fn invalid_windows_component(part: &str) -> bool {
    let stem = part
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_uppercase();
    part.ends_with(['.', ' '])
        || matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        )
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(
                    suffix,
                    "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        })
        || part.eq_ignore_ascii_case("git~1")
}

async fn metadata(cwd: &str, requested_base: Option<&str>) -> Result<GitWorkspace, String> {
    let mut workspace = GitWorkspace {
        state: "noRepo".into(),
        repo_root: None,
        branch: None,
        head: None,
        upstream: None,
        base: None,
        base_commit: None,
        merge_base: None,
        detached: false,
        unborn: false,
        refs: vec![],
        refs_has_more: false,
        staged: vec![],
        unstaged: vec![],
        untracked: vec![],
        compare: vec![],
        compare_unavailable_reason: None,
        warnings: vec![],
    };
    let probe = git(cwd, &["rev-parse", "--is-inside-work-tree"], 4096).await?;
    if probe.code != Some(0) {
        if probe.stderr.contains("not a git repository") {
            workspace
                .warnings
                .push("The session directory is not in a Git working tree.".into());
            workspace.warnings.push(probe.stderr);
            return Ok(workspace);
        }
        checked(probe)?;
        unreachable!();
    }
    if !probe.stderr.is_empty() {
        workspace.warnings.push(probe.stderr);
    }
    if line(&probe.stdout)? != "true" {
        workspace.warnings.push(
            "Bare repositories are not supported; select a session in a working tree.".into(),
        );
        return Ok(workspace);
    }
    workspace.state = "repository".into();
    workspace.repo_root = Some(line(
        &listing(
            cwd,
            &["rev-parse", "--show-toplevel"],
            &mut workspace.warnings,
        )
        .await?,
    )?);
    let root = workspace.repo_root.as_deref().unwrap();
    let branch = git(
        root,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
        16 * 1024,
    )
    .await?;
    if branch.truncated {
        return Err("Git branch name exceeds the inspection limit.".into());
    }
    if branch.code == Some(0) && !branch.stderr.is_empty() {
        workspace.warnings.push(branch.stderr.clone());
    }
    match branch.code {
        Some(0) => workspace.branch = Some(line(&branch.stdout)?),
        Some(1) if branch.stderr.is_empty() => workspace.detached = true,
        _ => {
            checked(branch)?;
        }
    }
    let head = git(
        root,
        &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        4096,
    )
    .await?;
    if head.code == Some(0) && !head.stderr.is_empty() {
        workspace.warnings.push(head.stderr.clone());
    }
    match head.code {
        Some(0) => {
            let oid = line(&head.stdout)?;
            if !valid_oid(&oid) {
                return Err("Git returned an invalid HEAD object ID.".into());
            }
            workspace.head = Some(oid);
        }
        Some(1) if head.stderr.is_empty() => workspace.unborn = !workspace.detached,
        _ => {
            checked(head)?;
        }
    }
    let targets = refs::list(root, "").await?;
    workspace.refs = targets.refs;
    workspace.refs_has_more = targets.has_more;
    workspace.warnings.extend(targets.warnings);
    if let Some(branch) = &workspace.branch {
        let full_name = format!("refs/heads/{branch}");
        let upstream = listing(root, &["for-each-ref", "--count=1", "--format=%(upstream)", &full_name],
            &mut workspace.warnings).await?;
        let upstream = line(&upstream)?;
        if !upstream.is_empty() { workspace.upstream = Some(upstream); }
    }
    if let Some(base) = requested_base {
        let reference = refs::resolve(root, base, &mut workspace.warnings).await?
            .ok_or("Choose an existing local branch or locally available remote-tracking ref as the comparison base.")?;
        workspace.base_commit = Some(reference.commit.clone());
        refs::include(&mut workspace.refs, reference);
        workspace.base = Some(base.into());
    } else if let Some(upstream) = &workspace.upstream {
        workspace.base = Some(upstream.clone());
        if let Some(reference) = refs::resolve(root, upstream, &mut workspace.warnings).await? {
            workspace.base_commit = Some(reference.commit.clone());
            refs::include(&mut workspace.refs, reference);
        }
    }
    if let (Some(branch), Some(head)) = (&workspace.branch, &workspace.head) {
        refs::include(&mut workspace.refs, GitRef { name: format!("refs/heads/{branch}"), commit: head.clone() });
    }
    workspace.compare_unavailable_reason = if workspace.head.is_none() {
        Some(
            "This branch has no commit yet. Staged and unstaged changes are still available."
                .into(),
        )
    } else if workspace.base.is_none() {
        Some("No upstream is configured. Choose a locally available comparison target.".into())
    } else if workspace.base_commit.is_none() {
        Some("The configured upstream is not available locally. Choose another target; this panel never fetches.".into())
    } else {
        let output = git(
            root,
            &[
                "merge-base",
                workspace.base_commit.as_deref().unwrap(),
                workspace.head.as_deref().unwrap(),
            ],
            4096,
        )
        .await?;
        match output.code {
            Some(0) => {
                let oid = line(&output.stdout)?;
                if !valid_oid(&oid) {
                    return Err("Git returned an invalid merge-base object ID.".into());
                }
                workspace.merge_base = Some(oid);
                if !output.stderr.is_empty() {
                    workspace.warnings.push(output.stderr);
                }
                None
            }
            Some(1) if output.stderr.is_empty() => {
                Some("The selected target and HEAD have no common ancestor.".into())
            }
            _ => {
                checked(output)?;
                unreachable!()
            }
        }
    };
    Ok(workspace)
}

fn kind(modes: &[&str], submodule: bool) -> String {
    if submodule || modes.contains(&"160000") {
        "submodule"
    } else if modes.contains(&"120000") {
        "symlink"
    } else {
        "file"
    }
    .into()
}

fn file(path: &str, original: Option<&str>, status: &str, kind: String) -> Result<GitFile, String> {
    validate_path(path)?;
    if let Some(original) = original {
        validate_path(original)?;
    }
    Ok(GitFile {
        path: path.into(),
        original_path: original.map(str::to_owned),
        status: status.into(),
        kind,
        added: None,
        deleted: None,
        binary: false,
    })
}

fn parse_status(bytes: &[u8]) -> Result<(Vec<GitFile>, Vec<GitFile>, Vec<GitFile>), String> {
    let mut records = bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty());
    let (mut staged, mut unstaged, mut untracked) = (vec![], vec![], vec![]);
    while let Some(record) = records.next() {
        let record = text(record)?;
        if let Some(path) = record.strip_prefix("? ") {
            let directory = path.ends_with('/');
            untracked.push(file(
                path.trim_end_matches('/'),
                None,
                "?",
                if directory {
                    "untrackedDirectory"
                } else {
                    "untracked"
                }
                .into(),
            )?);
        } else if record.starts_with("1 ") || record.starts_with("2 ") || record.starts_with("u ") {
            let rename = record.starts_with("2 ");
            let conflict = record.starts_with("u ");
            let count = if conflict {
                11
            } else if rename {
                10
            } else {
                9
            };
            let fields: Vec<_> = record.splitn(count, ' ').collect();
            if fields.len() != count || fields[1].len() != 2 {
                return Err("Cannot parse Git working-tree status.".into());
            }
            let original = if rename {
                Some(text(records.next().ok_or("Missing Git rename source")?)?)
            } else {
                None
            };
            let path = fields[count - 1];
            let kind = if conflict {
                "conflict".into()
            } else {
                kind(&fields[3..6], fields[2].starts_with('S'))
            };
            let codes: Vec<_> = fields[1].chars().collect();
            if codes[0] != '.' {
                staged.push(file(
                    path,
                    if matches!(codes[0], 'R' | 'C') {
                        original
                    } else {
                        None
                    },
                    &codes[0].to_string(),
                    kind.clone(),
                )?);
            }
            if codes[1] != '.' {
                unstaged.push(file(
                    path,
                    if matches!(codes[1], 'R' | 'C') {
                        original
                    } else {
                        None
                    },
                    &codes[1].to_string(),
                    kind,
                )?);
            }
        } else {
            return Err("Unexpected record in Git working-tree status.".into());
        }
        if staged.len() + unstaged.len() + untracked.len() > FILE_LIMIT {
            return Err("Workspace exceeds the 4000 changed-file inspection limit; no partial list is shown.".into());
        }
    }
    Ok((staged, unstaged, untracked))
}

fn parse_raw(bytes: &[u8]) -> Result<Vec<GitFile>, String> {
    let mut records = bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty());
    let mut files = vec![];
    while let Some(record) = records.next() {
        let header: Vec<_> = text(record)?.split(' ').collect();
        if header.len() != 5 || !header[0].starts_with(':') {
            return Err("Cannot parse Git comparison status.".into());
        }
        let path = text(records.next().ok_or("Missing Git comparison filename")?)?;
        let status = header[4].get(..1).ok_or("Missing Git change status")?;
        let (path, original) = if status == "R" || status == "C" {
            (
                text(records.next().ok_or("Missing Git rename destination")?)?,
                Some(path),
            )
        } else {
            (path, None)
        };
        files.push(file(
            path,
            original,
            status,
            kind(&[&header[0][1..], header[1]], false),
        )?);
        if files.len() > FILE_LIMIT {
            return Err("Comparison exceeds the 4000 changed-file inspection limit.".into());
        }
    }
    Ok(files)
}

fn diff_args(view: GitView, metadata: &GitWorkspace) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--ignore-submodules=dirty",
        "--submodule=short",
        "--find-renames",
        "--no-color",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    match view {
        GitView::Staged => {
            args.push("--cached".into());
            if let Some(head) = &metadata.head {
                args.push(head.clone());
            }
        }
        GitView::Unstaged => {}
        GitView::Compare => {
            args.push(metadata.merge_base.clone().ok_or_else(|| {
                metadata
                    .compare_unavailable_reason
                    .clone()
                    .unwrap_or("Comparison target unavailable.".into())
            })?);
            args.push(metadata.head.clone().ok_or("HEAD is unavailable.")?);
        }
        GitView::Untracked => return Err("Untracked files have no index or committed diff.".into()),
    }
    Ok(args)
}

async fn diff_listing(
    root: &str,
    metadata: &GitWorkspace,
    view: GitView,
    format: &str,
    warnings: &mut Vec<String>,
) -> Result<Vec<u8>, String> {
    let mut args = diff_args(view, metadata)?;
    args.extend([format.into(), "-z".into(), "--".into()]);
    listing(
        root,
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
        warnings,
    )
    .await
}

fn apply_numstat(files: &mut [GitFile], bytes: &[u8]) -> Result<(), String> {
    let mut records = bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty());
    let mut stats = HashMap::new();
    while let Some(record) = records.next() {
        let fields: Vec<_> = text(record)?.splitn(3, '\t').collect();
        if fields.len() != 3 {
            return Err("Cannot parse Git line counts.".into());
        }
        let path = if fields[2].is_empty() {
            records.next().ok_or("Missing numstat rename source")?;
            text(records.next().ok_or("Missing numstat rename destination")?)?
        } else {
            fields[2]
        };
        let binary = fields[0] == "-" || fields[1] == "-";
        let numbers = if binary {
            (None, None)
        } else {
            (
                Some(
                    fields[0]
                        .parse::<u64>()
                        .map_err(|_| "Invalid Git added-line count")?,
                ),
                Some(
                    fields[1]
                        .parse::<u64>()
                        .map_err(|_| "Invalid Git deleted-line count")?,
                ),
            )
        };
        stats.insert(path.to_owned(), (numbers.0, numbers.1, binary));
    }
    for file in files {
        if let Some((added, deleted, binary)) = stats.get(&file.path) {
            file.added = *added;
            file.deleted = *deleted;
            file.binary = *binary;
        }
    }
    Ok(())
}

/// Inspect the repository discovered from the authoritative session CWD.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepository {
    pub is_repository: bool,
    pub repo_root: Option<String>,
}

pub async fn repository(cwd: &str) -> Result<GitRepository, String> {
    let probe = git(cwd, &["rev-parse", "--is-inside-work-tree"], 4096).await?;
    if probe.code != Some(0) && probe.stderr.contains("not a git repository") {
        return Ok(GitRepository {
            is_repository: false,
            repo_root: None,
        });
    }
    let probe = checked(probe)?;
    if line(&probe.stdout)? != "true" {
        return Ok(GitRepository {
            is_repository: false,
            repo_root: None,
        });
    }
    let root = checked(git(cwd, &["rev-parse", "--show-toplevel"], 16 * 1024).await?)?;
    if root.truncated {
        return Err("Repository root exceeds the inspection limit.".into());
    }
    Ok(GitRepository {
        is_repository: true,
        repo_root: Some(line(&root.stdout)?),
    })
}

pub async fn workspace(cwd: &str, base: Option<&str>) -> Result<GitWorkspace, String> {
    let mut metadata = metadata(cwd, base).await?;
    let Some(root) = metadata.repo_root.clone() else {
        return Ok(metadata);
    };
    let status = listing(
        &root,
        &[
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=dirty",
        ],
        &mut metadata.warnings,
    )
    .await?;
    (metadata.staged, metadata.unstaged, metadata.untracked) = parse_status(&status)?;
    let mut warnings = vec![];
    let staged = diff_listing(
        &root,
        &metadata,
        GitView::Staged,
        "--numstat",
        &mut warnings,
    )
    .await?;
    let unstaged = diff_listing(
        &root,
        &metadata,
        GitView::Unstaged,
        "--numstat",
        &mut warnings,
    )
    .await?;
    apply_numstat(&mut metadata.staged, &staged)?;
    apply_numstat(&mut metadata.unstaged, &unstaged)?;
    if metadata.merge_base.is_some() {
        metadata.compare = parse_raw(
            &diff_listing(&root, &metadata, GitView::Compare, "--raw", &mut warnings).await?,
        )?;
        let stats = diff_listing(
            &root,
            &metadata,
            GitView::Compare,
            "--numstat",
            &mut warnings,
        )
        .await?;
        apply_numstat(&mut metadata.compare, &stats)?;
    }
    metadata.warnings.extend(warnings);
    let mut seen = std::collections::HashSet::new();
    metadata
        .warnings
        .retain(|warning| seen.insert(warning.clone()));
    Ok(metadata)
}

async fn reject_linked_parents(root: &str, path: &str) -> Result<(), String> {
    let mut current = Path::new(root).to_owned();
    let parts: Vec<_> = path.split('/').collect();
    for part in &parts[..parts.len().saturating_sub(1)] {
        current.push(part);
        match tokio::fs::symlink_metadata(&current).await {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(
                    "A parent directory is a symlink; worktree content is not inspected.".into(),
                );
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(format!("Cannot validate worktree path: {error}")),
        }
    }
    Ok(())
}

/// Return only a currently changed, explicitly selected file.
pub async fn diff(cwd: &str, request: GitDiffRequest) -> Result<GitDiff, String> {
    validate_path(&request.path)?;
    let mut metadata = metadata(cwd, request.base.as_deref()).await?;
    let root = metadata
        .repo_root
        .clone()
        .ok_or("The session is not in a Git working tree.")?;
    let mut warnings = vec![];
    let mut files = if request.view == GitView::Compare {
        parse_raw(&diff_listing(&root, &metadata, request.view, "--raw", &mut warnings).await?)?
    } else {
        let status = listing(
            &root,
            &[
                "status",
                "--porcelain=v2",
                "-z",
                "--untracked-files=all",
                "--ignore-submodules=dirty",
            ],
            &mut warnings,
        )
        .await?;
        let (staged, unstaged, untracked) = parse_status(&status)?;
        match request.view {
            GitView::Staged => staged,
            GitView::Unstaged => unstaged,
            _ => untracked,
        }
    };
    let missing = !files.iter().any(|file| file.path == request.path);
    if missing && request.view == GitView::Untracked {
        files.push(GitFile {
            path: request.path.clone(),
            original_path: None,
            status: "?".into(),
            kind: "untracked".into(),
            added: None,
            deleted: None,
            binary: false,
        });
    }
    let file = files
        .iter_mut()
        .find(|file| file.path == request.path)
        .ok_or("This file is no longer changed in the selected view. Refresh the workspace.")?;
    let unavailable = if missing {
        Some("This path is no longer a Git-listed, nonignored untracked file. Refresh the workspace.".into())
    } else {
        match file.kind.as_str() {
        "submodule" => Some("Submodule change: nested repository content is not inspected.".to_owned()),
        "conflict" => Some("Unmerged file: resolve the conflict outside this read-only panel to view a normal diff.".to_owned()),
        "untrackedDirectory" => Some("Untracked directory or nested repository: contents are not inspected.".to_owned()),
        _ => None,
    }
    };
    let mut result = GitDiff {
        repo_root: root.clone(),
        path: file.path.clone(),
        original_path: file.original_path.clone(),
        view: request.view,
        context: request.context,
        full_context_complete: false,
        head: metadata.head.clone(),
        base: metadata.base.clone(),
        base_commit: metadata.base_commit.clone(),
        merge_base: metadata.merge_base.clone(),
        content_id: String::new(),
        patch: String::new(),
        truncated: false,
        binary: false,
        kind: file.kind.clone(),
        added: None,
        deleted: None,
        unavailable_reason: unavailable,
        warnings: vec![],
    };
    if result.unavailable_reason.is_none() && request.view == GitView::Untracked {
        match untracked_preview(&root, &request.path, &mut warnings).await {
            Ok(snapshot) => snapshot.render(&mut result),
            Err(reason) => result.unavailable_reason = Some(reason),
        }
    } else if result.unavailable_reason.is_none() {
        if request.view == GitView::Unstaged {
            reject_linked_parents(&root, &request.path).await?;
        }
        let mut args = diff_args(request.view, &metadata)?;
        // Git's maximum signed context includes the file without separate blob/worktree
        // reads; the existing output byte/line caps and process timeout still apply.
        let unified = match request.context {
            GitDiffContext::Changes => "--unified=3",
            GitDiffContext::Full => "--unified=2147483647",
        };
        args.extend([
            "--patch".into(),
            unified.into(),
            "--src-prefix=a/".into(),
            "--dst-prefix=b/".into(),
            "--".into(),
        ]);
        if let Some(original) = &file.original_path {
            args.push(original.clone());
        }
        args.push(file.path.clone());
        let output = checked(
            git(
                &root,
                &args.iter().map(String::as_str).collect::<Vec<_>>(),
                PATCH_LIMIT,
            )
            .await?,
        )?;
        if !output.stderr.is_empty() {
            warnings.push(output.stderr);
        }
        result.truncated = output.truncated;
        let patch = match std::str::from_utf8(&output.stdout) {
            Ok(patch) => patch,
            Err(error) if output.truncated && error.error_len().is_none() => {
                std::str::from_utf8(&output.stdout[..error.valid_up_to()])
                    .map_err(|_| "Cannot decode Git patch")?
            }
            Err(_) => {
                result.binary = true;
                result.unavailable_reason =
                    Some("The selected diff is not UTF-8 text; no text preview is shown.".into());
                ""
            }
        };
        result.binary |= patch
            .lines()
            .any(|line| line.starts_with("Binary files ") || line == "GIT binary patch");
        if result.binary {
            result
                .unavailable_reason
                .get_or_insert("Binary file changed; no text diff is available.".into());
        } else {
            let mut count = 0;
            for line in patch.split_inclusive('\n') {
                if count >= PATCH_LINES {
                    result.truncated = true;
                    break;
                }
                result.patch.push_str(line);
                count += 1;
            }
            if result.truncated {
                if let Some(end) = result.patch.rfind('\n') {
                    result.patch.truncate(end + 1);
                }
            }
        }
        if result.truncated {
            warnings.push("Diff preview truncated at 192 KiB or 2500 lines. The rest is not loaded or sent to the model.".into());
        }
        let mut stat_args = diff_args(request.view, &metadata)?;
        stat_args.extend(["--numstat".into(), "-z".into(), "--".into()]);
        if let Some(original) = &file.original_path {
            stat_args.push(original.clone());
        }
        stat_args.push(file.path.clone());
        let stats = listing(
            &root,
            &stat_args.iter().map(String::as_str).collect::<Vec<_>>(),
            &mut warnings,
        )
        .await?;
        apply_numstat(std::slice::from_mut(file), &stats)?;
        result.added = file.added;
        result.deleted = file.deleted;
        result.binary |= file.binary;
        if request.context == GitDiffContext::Full
            && !result.truncated
            && !result.binary
            && result.unavailable_reason.is_none()
        {
            result.full_context_complete = result.patch.lines().any(|line| line.starts_with("@@ "));
            if !result.full_context_complete {
                warnings.push("Git emitted no text hunks (for example, a pure rename, mode-only change, or empty file); full-file contents are not displayed.".into());
            }
        }
    }
    // Content identity invalidates local line comments when index/worktree text changes,
    // even when HEAD and the selected base remain unchanged. Not a security hash.
    let mut identity = 0xcbf29ce484222325_u64;
    for byte in result
        .patch
        .bytes()
        .chain(result.unavailable_reason.as_deref().unwrap_or("").bytes())
        .chain(result.content_id.bytes())
    {
        identity = (identity ^ u64::from(byte)).wrapping_mul(0x100000001b3);
    }
    result.content_id = format!("{identity:016x}");
    metadata.warnings.extend(warnings);
    let mut seen = std::collections::HashSet::new();
    metadata
        .warnings
        .retain(|warning| seen.insert(warning.clone()));
    result.warnings.extend(metadata.warnings);
    Ok(result)
}

async fn untracked_preview(
    root: &str,
    path: &str,
    warnings: &mut Vec<String>,
) -> Result<untracked::Snapshot, String> {
    let owned_root = root.to_owned();
    let owned_path = path.to_owned();
    let snapshot =
        tokio::task::spawn_blocking(move || untracked::Snapshot::read(owned_root, owned_path))
            .await
            .map_err(|error| format!("Cannot read untracked snapshot: {error}"))??;
    // Revalidate the exact literal path after reading as well: it may have been
    // staged, ignored, removed, or replaced by a nested repository meanwhile.
    let status = listing(
        root,
        &[
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=dirty",
            "--",
            path,
        ],
        warnings,
    )
    .await?;
    let (_, _, files) = parse_status(&status)?;
    if !files
        .iter()
        .any(|file| file.path == path && file.kind == "untracked")
    {
        return Err("This path is no longer a Git-listed, nonignored untracked file. Refresh the workspace.".into());
    }
    tokio::task::spawn_blocking(move || {
        snapshot.validate()?;
        Ok(snapshot)
    })
    .await
    .map_err(|error| format!("Cannot validate untracked snapshot: {error}"))?
}

#[cfg(test)]
#[path = "git_workspace_tests.rs"]
mod tests;
