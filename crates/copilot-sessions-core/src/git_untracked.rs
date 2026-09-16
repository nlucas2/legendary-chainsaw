//! Bounded new-file snapshots. Every untrusted component is opened relative to
//! a held directory handle, without following links; pathname checks alone race.
use std::io::{self, Read};

#[cfg(unix)]
use cap_fs_ext::OpenOptionsSyncExt;
use cap_fs_ext::{DirExt, FollowSymlinks, MetadataExt, OpenOptionsFollowExt};
use cap_std::fs::{Dir, File, Metadata, OpenOptions};

use super::{GitDiff, GitDiffContext, PATCH_LIMIT, PATCH_LINES, validate_path};

const CHANGED: &str =
    "The untracked file or its directories changed during inspection. Refresh and retry.";

fn failure(error: io::Error) -> String {
    format!(
        "Untracked preview unavailable: the path vanished, is inaccessible, or contains an unsupported link/reparse point: {error}"
    )
}

fn reject_link(metadata: &Metadata) -> Result<(), String> {
    #[cfg(windows)]
    let reparse = {
        use cap_std::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
    };
    #[cfg(not(windows))]
    let reparse = false;
    if metadata.is_symlink() || reparse {
        return Err(
            "Symlinks, junctions and reparse points are not opened for untracked previews.".into(),
        );
    }
    Ok(())
}

fn reject_nested_repository(dir: &Dir) -> Result<(), String> {
    match dir.symlink_metadata(".git") {
        Ok(_) => Err("Nested repository content is not inspected.".into()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(failure(error)),
    }
}

fn same_file(left: &Metadata, right: &Metadata) -> bool {
    left.dev() == right.dev() && left.ino() == right.ino()
}

fn same_version(left: &Metadata, right: &Metadata) -> bool {
    #[cfg(unix)]
    let same_change_time = {
        use cap_std::fs::MetadataExt;
        left.ctime() == right.ctime() && left.ctime_nsec() == right.ctime_nsec()
    };
    #[cfg(not(unix))]
    let same_change_time = true;
    same_file(left, right)
        && left.len() == right.len()
        && left.modified().ok() == right.modified().ok()
        && left.created().ok() == right.created().ok()
        && left.nlink() == right.nlink()
        && same_change_time
}

fn file_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    // A FIFO swapped in before open must not block before its type is checked.
    #[cfg(unix)]
    options.nonblock(true);
    #[cfg(windows)]
    {
        use cap_std::fs::OpenOptionsExt;
        // Deny writers and deletion for the lifetime of the snapshot.
        options.share_mode(1); // FILE_SHARE_READ
    }
    options
}

fn open_file(parent: &Dir, name: &str) -> Result<(File, Metadata), String> {
    let file = parent.open_with(name, &file_options()).map_err(failure)?;
    let metadata = file.metadata().map_err(failure)?;
    reject_link(&metadata)?;
    if !metadata.is_file() {
        return Err("Only regular untracked files have content previews.".into());
    }
    if metadata.nlink() != 1 {
        return Err("Hard-linked untracked files are not opened for content previews.".into());
    }
    Ok((file, metadata))
}

fn read_prefix(reader: &mut impl Read) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 8192];
    let mut lines = 0;
    // Unlike the subprocess pipe drainer, stop reading at the byte/line
    // budget; enormous local files are never drained to EOF.
    while bytes.len() <= PATCH_LIMIT && lines <= PATCH_LINES {
        let capacity = buffer.len().min(PATCH_LIMIT + 1 - bytes.len());
        if capacity == 0 {
            break;
        }
        let count = match reader.read(&mut buffer[..capacity]) {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => result?,
        };
        if count == 0 {
            break;
        }
        lines += buffer[..count]
            .iter()
            .filter(|byte| **byte == b'\n')
            .count();
        bytes.extend_from_slice(&buffer[..count]);
    }
    Ok(bytes)
}

pub(super) struct Snapshot {
    root_path: String,
    path: String,
    // Keep the entire capability chain alive through Git's second status check.
    directories: Vec<Dir>,
    file: File,
    metadata: Metadata,
    bytes: Vec<u8>,
    truncated: bool,
}

impl Snapshot {
    pub(super) fn read(root: String, path: String) -> Result<Self, String> {
        validate_path(&path)?;
        let root_dir =
            Dir::open_ambient_dir(&root, cap_std::ambient_authority()).map_err(failure)?;
        reject_link(&root_dir.dir_metadata().map_err(failure)?)?;
        let mut directories = vec![root_dir];
        let parts: Vec<_> = path.split('/').collect();
        for part in &parts[..parts.len() - 1] {
            let dir = directories
                .last()
                .unwrap()
                .open_dir_nofollow(part)
                .map_err(failure)?;
            reject_link(&dir.dir_metadata().map_err(failure)?)?;
            reject_nested_repository(&dir)?;
            directories.push(dir);
        }
        let (mut file, metadata) = open_file(directories.last().unwrap(), parts.last().unwrap())?;
        let bytes = read_prefix(&mut file).map_err(failure)?;
        let truncated = (bytes.len() as u64) < metadata.len();
        if !same_version(&metadata, &file.metadata().map_err(failure)?)
            || (bytes.len() as u64) > metadata.len()
        {
            return Err(CHANGED.into());
        }
        let snapshot = Self {
            root_path: root,
            path,
            directories,
            file,
            metadata,
            bytes,
            truncated,
        };
        snapshot.validate()?;
        Ok(snapshot)
    }

    pub(super) fn validate(&self) -> Result<(), String> {
        let current_root = Dir::open_ambient_dir(&self.root_path, cap_std::ambient_authority())
            .map_err(failure)?;
        if !same_file(
            &current_root.dir_metadata().map_err(failure)?,
            &self.directories[0].dir_metadata().map_err(failure)?,
        ) {
            return Err(CHANGED.into());
        }
        let parts: Vec<_> = self.path.split('/').collect();
        for (index, part) in parts[..parts.len() - 1].iter().enumerate() {
            let current = self.directories[index]
                .open_dir_nofollow(part)
                .map_err(failure)?;
            let current_metadata = current.dir_metadata().map_err(failure)?;
            reject_link(&current_metadata)?;
            reject_nested_repository(&current)?;
            if !same_file(
                &current_metadata,
                &self.directories[index + 1]
                    .dir_metadata()
                    .map_err(failure)?,
            ) {
                return Err(CHANGED.into());
            }
        }
        let (_, current) = open_file(self.directories.last().unwrap(), parts.last().unwrap())?;
        if !same_version(&self.metadata, &current)
            || !same_version(&self.metadata, &self.file.metadata().map_err(failure)?)
        {
            return Err(CHANGED.into());
        }
        Ok(())
    }

    pub(super) fn render(self, result: &mut GitDiff) {
        result.content_id = format!(
            "{}:{}:{}:{:?}:{:?}",
            self.metadata.dev(),
            self.metadata.ino(),
            self.metadata.len(),
            self.metadata.modified().ok(),
            self.metadata.created().ok(),
        );
        #[cfg(unix)]
        {
            use cap_std::fs::MetadataExt;
            result.content_id.push_str(&format!(
                ":{}:{}",
                self.metadata.ctime(),
                self.metadata.ctime_nsec()
            ));
        }
        result.truncated = self.truncated || self.bytes.len() > PATCH_LIMIT;
        let text = match std::str::from_utf8(&self.bytes) {
            Ok(text) if !self.bytes.contains(&0) => text,
            Err(error)
                if self.truncated && error.error_len().is_none() && !self.bytes.contains(&0) =>
            {
                // A bounded read may split a UTF-8 character, not the source file.
                std::str::from_utf8(&self.bytes[..error.valid_up_to()]).unwrap()
            }
            _ => {
                result.binary = true;
                result.unavailable_reason = Some(
                    "The untracked file is binary or not UTF-8 text; no text preview is shown."
                        .into(),
                );
                if result.truncated {
                    result.warnings.push(
                        "Only a bounded prefix was inspected; remaining content was not read."
                            .into(),
                    );
                }
                return;
            }
        };
        let source = quote_path(&format!("a/{}", result.path));
        let destination = quote_path(&format!("b/{}", result.path));
        #[cfg(unix)]
        let mode = {
            use cap_std::fs::MetadataExt;
            if self.metadata.mode() & 0o111 != 0 {
                "100755"
            } else {
                "100644"
            }
        };
        #[cfg(not(unix))]
        let mode = "100644";
        result.patch = format!(
            "diff --git {source} {destination}\nnew file mode {mode}\n--- /dev/null\n+++ {destination}\n"
        );
        if result.patch.len() + 32 > PATCH_LIMIT {
            result.patch.clear();
            result.unavailable_reason =
                Some("The encoded path exceeds the patch preview budget.".into());
            return;
        }
        if self.metadata.len() == 0 {
            result.patch.push_str("@@ -0,0 +0,0 @@\n");
            result
                .warnings
                .push("Empty untracked file (0 bytes).".into());
            result.added = Some(0);
        } else {
            let total = text.split_inclusive('\n').count();
            // A capped read cannot know the total source line count. Describe
            // just the complete displayed prefix in that case, never invent it.
            let mut body = String::new();
            let mut lines = 5;
            let mut added = 0;
            for line in text.split_inclusive('\n') {
                let has_newline = line.ends_with('\n');
                if !has_newline && result.truncated {
                    break;
                }
                let extra = if has_newline {
                    ""
                } else {
                    "\n\\ No newline at end of file\n"
                };
                let header_length = format!("@@ -0,0 +1,{} @@\n", added + 1).len();
                if result.patch.len() + header_length + body.len() + 1 + line.len() + extra.len()
                    > PATCH_LIMIT
                    || lines + 1 + usize::from(!has_newline) > PATCH_LINES
                {
                    break;
                }
                body.push('+');
                body.push_str(line);
                body.push_str(extra);
                lines += 1 + usize::from(!has_newline);
                added += 1;
            }
            result.truncated |= added < total;
            if added > 0 {
                result.patch.push_str(&format!("@@ -0,0 +1,{added} @@\n"));
                result.patch.push_str(&body);
            } else {
                result.warnings.push(
                    "The first source line exceeds the preview budget; no complete text lines are displayed.".into(),
                );
            }
            result.added = (!self.truncated).then_some(total as u64);
        }
        result.deleted = Some(0);
        result.full_context_complete = result.context == GitDiffContext::Full && !result.truncated;
        if result.truncated {
            result.warnings.push(
                "Diff preview truncated at 192 KiB or 2500 lines. Only a bounded prefix is displayed; remaining content was not returned.".into(),
            );
        }
    }
}

fn quote_path(path: &str) -> String {
    if !path
        .chars()
        .any(|character| character.is_control() || matches!(character, '"' | '\\'))
    {
        return path.into();
    }

    let mut quoted = String::from("\"");
    for byte in path.bytes() {
        match byte {
            b'"' => quoted.push_str("\\\""),
            b'\\' => quoted.push_str("\\\\"),
            b'\n' => quoted.push_str("\\n"),
            b'\r' => quoted.push_str("\\r"),
            b'\t' => quoted.push_str("\\t"),
            0..=31 | 127..=255 => quoted.push_str(&format!("\\{byte:03o}")),
            _ => quoted.push(char::from(byte)),
        }
    }
    quoted.push('"');
    quoted
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn untracked_reader_never_drains_unbounded_content() {
        assert_eq!(
            read_prefix(&mut io::repeat(b'x')).unwrap().len(),
            PATCH_LIMIT + 1
        );
        assert_eq!(read_prefix(&mut io::repeat(b'\n')).unwrap().len(), 8192);
    }

    #[test]
    fn untracked_diff_headers_escape_special_names_without_extra_lines() {
        assert_eq!(quote_path("b/normal 漢字 name"), "b/normal 漢字 name");
        assert_eq!(
            quote_path("b/line\nname\t\"\\"),
            "\"b/line\\nname\\t\\\"\\\\\""
        );
        assert_eq!(quote_path("b/漢\n"), "\"b/\\346\\274\\242\\n\"");
    }
}
