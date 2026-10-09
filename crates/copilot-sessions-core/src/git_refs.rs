//! Bounded ref suggestions and substring search, independent of changed-file inspection.
use super::{GitRef, LIST_LIMIT, checked, git, line, run_git_output, text, valid_oid};
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt};

const REF_LIMIT: usize = 200;
const RECORD_LIMIT: usize = 16 * 1024;
const SCAN_LIMIT: usize = 128 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitReferences {
    pub refs: Vec<GitRef>,
    pub has_more: bool,
    pub warnings: Vec<String>,
}

fn priority(name: &str) -> bool {
    // Keep common comparison targets visible even when thousands of user branches
    // precede them. Selection of an exact target never depends on this sample.
    matches!(
        name.rsplit('/').next(),
        Some("HEAD" | "main" | "master" | "dev" | "trunk")
    )
}

pub(super) async fn read_ref_listing<R: AsyncRead + Unpin>(
    mut reader: R,
    query: &str,
) -> std::io::Result<(Vec<u8>, bool)> {
    let query = query.to_lowercase();
    let mut kept: Vec<(bool, Vec<u8>)> = Vec::new();
    let mut retained_bytes = 0;
    let mut total_bytes = 0;
    let mut has_more = false;
    let mut record = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        let size = reader.read(&mut chunk).await?;
        if size == 0 {
            break;
        }
        total_bytes += size;
        if total_bytes > SCAN_LIMIT {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Git ref scan exceeds 128 MiB.",
            ));
        }
        for byte in &chunk[..size] {
            if *byte != b'\n' {
                if record.len() == RECORD_LIMIT {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "Git ref record exceeds 16 KiB.",
                    ));
                }
                record.push(*byte);
                continue;
            }
            let name = record.split(|byte| *byte == 0).next().unwrap_or_default();
            let name = std::str::from_utf8(name)
                .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
            if name.to_lowercase().contains(&query) {
                let preferred = query.is_empty() && priority(name);
                // Once full, only priority targets can displace earlier suggestions.
                if kept.len() < REF_LIMIT
                    || (preferred && kept.iter().any(|(priority, _)| !priority))
                {
                    record.push(b'\n');
                    retained_bytes += record.len();
                    kept.push((preferred, std::mem::take(&mut record)));
                    while kept.len() > REF_LIMIT || retained_bytes > LIST_LIMIT {
                        let index = kept
                            .iter()
                            .rposition(|(priority, _)| !priority)
                            .unwrap_or(kept.len() - 1);
                        retained_bytes -= kept.remove(index).1.len();
                        has_more = true;
                    }
                } else {
                    has_more = true;
                }
            }
            record.clear();
        }
    }
    if !record.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Incomplete Git ref record.",
        ));
    }
    let output = kept.into_iter().flat_map(|(_, bytes)| bytes).collect();
    Ok((output, has_more))
}

pub(super) async fn list(root: &str, query: &str) -> Result<GitReferences, String> {
    if query.len() > 256 || query.chars().any(char::is_control) {
        return Err("Ref search must be at most 256 bytes without control characters.".into());
    }
    let output = checked(
        run_git_output(
            root,
            &[
                "for-each-ref",
                "--format=%(refname)%00%(objectname)",
                "refs/heads/",
                "refs/remotes/",
            ],
            LIST_LIMIT,
            &[],
            Some(query),
        )
        .await?,
    )?;
    let mut refs = Vec::new();
    for entry in text(&output.stdout)?.split_terminator('\n') {
        let (name, commit) = entry
            .split_once('\0')
            .ok_or("Cannot parse Git ref metadata.")?;
        if !valid_oid(commit) {
            return Err("Git returned an invalid ref object ID.".into());
        }
        refs.push(GitRef {
            name: name.into(),
            commit: commit.into(),
        });
    }
    Ok(GitReferences {
        refs,
        has_more: output.truncated,
        warnings: if output.stderr.is_empty() {
            vec![]
        } else {
            vec![output.stderr]
        },
    })
}

pub async fn reference_targets(cwd: &str, query: &str) -> Result<GitReferences, String> {
    let repo = super::repository(cwd).await?;
    let root = repo
        .repo_root
        .ok_or("This session is not in a Git working tree.")?;
    list(&root, query.trim()).await
}

pub(super) fn include(refs: &mut Vec<GitRef>, reference: GitRef) {
    if !refs.iter().any(|entry| entry.name == reference.name) {
        refs.push(reference);
    }
}

pub(super) async fn resolve(
    root: &str,
    name: &str,
    warnings: &mut Vec<String>,
) -> Result<Option<GitRef>, String> {
    if name.len() > RECORD_LIMIT
        || !(name.starts_with("refs/heads/") || name.starts_with("refs/remotes/"))
        || name.chars().any(char::is_control)
    {
        return Err("Choose an existing local branch or locally available remote-tracking ref as the comparison base.".into());
    }
    let syntax = git(root, &["check-ref-format", name], 4096).await?;
    if syntax.code != Some(0) {
        return Err("Invalid comparison ref name.".into());
    }
    let output = git(
        root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            &format!("{name}^{{commit}}"),
        ],
        4096,
    )
    .await?;
    if output.code == Some(1) && output.stderr.is_empty() {
        return Ok(None);
    }
    let output = checked(output)?;
    if output.truncated {
        return Err("Git ref object ID exceeds the inspection limit.".into());
    }
    if !output.stderr.is_empty() {
        warnings.push(output.stderr);
    }
    let commit = line(&output.stdout)?;
    if !valid_oid(&commit) {
        return Err("Git returned an invalid comparison object ID.".into());
    }
    Ok(Some(GitRef {
        name: name.into(),
        commit,
    }))
}
