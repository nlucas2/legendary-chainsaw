//! App-owned profile composition. Linked CLI sources are read, never regenerated or rewritten.
//!
//! This module does not perform automatic CLI discovery, start MCP processes, expand environment
//! variables, or interpret skill bodies. Skill manifests are read only for bounded content hashing;
//! auxiliary scripts/resources are not pinned, so this is not a hermetic skill snapshot. A resolved
//! profile is private runtime input; only its preview and selection are safe to persist or return to
//! a UI.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use cap_fs_ext::DirExt;
use cap_std::fs::Dir;
use github_copilot_sdk::types::McpServerConfig;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

const STORE_VERSION: u32 = 1;
const MAX_LIBRARY_BYTES: u64 = 4 * 1024 * 1024;
const MAX_SOURCE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_COMPILED_BYTES: usize = 16 * 1024 * 1024;
const MAX_RECORDS: usize = 256;
const MAX_REFERENCES: usize = 128;
const MAX_SERVERS: usize = 512;
const MAX_COMPILED_SOURCES: usize = 512;
const MAX_COMPILED_DEFINITIONS: usize = 4096;
const MAX_SKILL_ENTRIES: usize = 4096;
const MAX_SKILL_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_SKILL_MANIFEST_TOTAL_BYTES: usize = 8 * 1024 * 1024;
const MAX_NAME: usize = 128;
const MAX_PATH: usize = 4096;
const TEMPLATE_MARKERS: [&str; 3] = ["__HOME__", "__LOCALAPPDATA__", "__NPM_GLOBAL__"];
const SKILL_FINGERPRINT_WARNING: &str = "SKILL.md manifest contents are fingerprinted, but auxiliary skill scripts/resources are not \
     pinned. This is not a hermetic skill snapshot.";

#[derive(Debug, thiserror::Error)]
pub enum ProfileError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    NotFound(String),
    #[error("Profile library changed. Reload it and retry the operation.")]
    RevisionConflict,
    #[error("Profile sources changed since confirmation. Preview and confirm the profile again.")]
    SourceRevisionConflict,
    #[error("Profile library is busy in another operation. Retry shortly.")]
    Busy,
    #[error("Cannot {operation} '{path}' ({kind:?}).")]
    Io {
        operation: &'static str,
        path: String,
        kind: std::io::ErrorKind,
    },
    #[error("Invalid profile library '{path}': {reason}. The existing file was not reset.")]
    Corrupt { path: String, reason: String },
}

type Result<T> = std::result::Result<T, ProfileError>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileGroup {
    pub id: String,
    pub name: String,
    pub mcp_config_files: Vec<String>,
    pub skill_directories: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionProfile {
    pub id: String,
    pub name: String,
    pub group_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileLibrarySnapshot {
    pub directory: String,
    pub revision: String,
    pub groups: Vec<ProfileGroup>,
    pub profiles: Vec<SessionProfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveProfileGroup {
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub mcp_config_files: Vec<String>,
    #[serde(default)]
    pub skill_directories: Vec<String>,
    pub expected_revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveSessionProfile {
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub group_ids: Vec<String>,
    pub expected_revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteProfileGroup {
    pub id: String,
    pub expected_revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteSessionProfile {
    pub id: String,
    pub expected_revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetProfileDirectory {
    pub directory: String,
    pub expected_revision: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProfileSourceKind {
    Mcp,
    Skills,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateProfileSource {
    pub kind: ProfileSourceKind,
    pub name: String,
    pub content: Option<String>,
    pub expected_revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedProfileSource {
    pub path: String,
    pub kind: ProfileSourceKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileMcpSource {
    pub name: String,
    pub source_file: String,
}

/// Approved composition, containing only library records and linked paths, never source contents.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileResolutionSnapshot {
    pub profile: SessionProfile,
    pub groups: Vec<ProfileGroup>,
}

/// A secret-free assignment. New selections retain the approved composition independently of
/// mutable library records. Live linked inputs must still match the approved fingerprint.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileSelection {
    pub directory: String,
    pub profile_id: Option<String>,
    pub name: String,
    pub revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<ProfileResolutionSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedProfilePreview {
    pub profile_id: Option<String>,
    pub profile_name: String,
    pub revision: String,
    pub group_names: Vec<String>,
    pub mcp_servers: Vec<ProfileMcpSource>,
    pub skill_directories: Vec<String>,
    pub warnings: Vec<String>,
}

// Deliberately neither Serialize nor Debug: MCP definitions can contain credentials.
#[derive(Clone)]
pub struct ResolvedProfile {
    pub directory: String,
    pub profile_id: Option<String>,
    pub name: String,
    pub revision: String,
    pub group_names: Vec<String>,
    pub mcp_servers: IndexMap<String, McpServerConfig>,
    pub skill_directories: Vec<PathBuf>,
    pub warnings: Vec<String>,
    pub mcp_sources: Vec<ProfileMcpSource>,
    resolution_snapshot: Option<ProfileResolutionSnapshot>,
}

impl ResolvedProfile {
    pub fn selection(&self) -> ProfileSelection {
        ProfileSelection {
            directory: self.directory.clone(),
            profile_id: self.profile_id.clone(),
            name: self.name.clone(),
            revision: self.revision.clone(),
            snapshot: self.resolution_snapshot.clone(),
        }
    }

    pub fn preview(&self) -> ResolvedProfilePreview {
        ResolvedProfilePreview {
            profile_id: self.profile_id.clone(),
            profile_name: self.name.clone(),
            revision: self.revision.clone(),
            group_names: self.group_names.clone(),
            mcp_servers: self.mcp_sources.clone(),
            skill_directories: self
                .skill_directories
                .iter()
                .map(|path| display_path(path))
                .collect(),
            warnings: self.warnings.clone(),
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Store {
    version: u32,
    revision: String,
    groups: Vec<ProfileGroup>,
    profiles: Vec<SessionProfile>,
}

impl Store {
    fn empty() -> Self {
        Self {
            version: STORE_VERSION,
            revision: Uuid::new_v4().to_string(),
            groups: vec![],
            profiles: vec![],
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DirectorySetting {
    version: u32,
    directory: String,
}

/// All operations are synchronous filesystem operations. Async callers should use spawn_blocking.
/// OS advisory locks serialize cooperating writers, including other app processes; the lock files
/// are persistent, but their locks automatically release on process exit.
#[derive(Debug, Clone)]
pub struct ProfileLibrary {
    data_dir: PathBuf,
}

impl ProfileLibrary {
    pub fn open(data_dir: impl AsRef<Path>) -> Result<Self> {
        let data_dir = data_dir.as_ref();
        fs::create_dir_all(data_dir).map_err(|e| io_error("create data directory", data_dir, e))?;
        let library = Self {
            data_dir: canonical_directory(data_dir)?,
        };
        let _setting_lock = lock(&library.data_dir.join("profile-library.lock"))?;
        let setting_path = library.setting_path();
        if optional_bytes(&setting_path, MAX_LIBRARY_BYTES)?.is_none() {
            let directory = library.data_dir.join("profiles");
            fs::create_dir_all(&directory)
                .map_err(|e| io_error("create default library directory", &directory, e))?;
            let directory = canonical_directory(&directory)?;
            let _library_lock = lock(&directory.join(".profiles.lock"))?;
            initialize_store(&directory)?;
            library.write_setting(&directory)?;
        } else {
            let directory = library.directory()?;
            let _library_lock = lock(&directory.join(".profiles.lock"))?;
            read_store(&directory)?;
        }
        Ok(library)
    }

    pub fn snapshot(&self) -> Result<ProfileLibrarySnapshot> {
        let _setting_lock = lock(&self.data_dir.join("profile-library.lock"))?;
        let directory = self.directory()?;
        let _library_lock = lock(&directory.join(".profiles.lock"))?;
        let (store, revision) = read_store(&directory)?;
        Ok(snapshot(&directory, store, revision))
    }

    pub fn save_group(&self, request: SaveProfileGroup) -> Result<ProfileLibrarySnapshot> {
        self.mutate(&request.expected_revision, |store| {
            let group = ProfileGroup {
                id: record_id(
                    request.id.as_deref(),
                    store.groups.iter().map(|g| g.id.as_str()),
                )?,
                name: request.name.trim().to_owned(),
                mcp_config_files: request.mcp_config_files,
                skill_directories: request.skill_directories,
            };
            if let Some(existing) = store.groups.iter_mut().find(|g| g.id == group.id) {
                *existing = group;
            } else {
                store.groups.push(group);
            }
            Ok(())
        })
    }

    pub fn delete_group(&self, request: DeleteProfileGroup) -> Result<ProfileLibrarySnapshot> {
        self.mutate(&request.expected_revision, |store| {
            if store
                .profiles
                .iter()
                .any(|p| p.group_ids.contains(&request.id))
            {
                return Err(ProfileError::Invalid(
                    "This group is referenced by a profile. Remove those references first.".into(),
                ));
            }
            let index = store
                .groups
                .iter()
                .position(|g| g.id == request.id)
                .ok_or_else(|| ProfileError::NotFound("Profile group not found.".into()))?;
            store.groups.remove(index);
            Ok(())
        })
    }

    pub fn save_profile(&self, request: SaveSessionProfile) -> Result<ProfileLibrarySnapshot> {
        self.mutate(&request.expected_revision, |store| {
            let profile = SessionProfile {
                id: record_id(
                    request.id.as_deref(),
                    store.profiles.iter().map(|p| p.id.as_str()),
                )?,
                name: request.name.trim().to_owned(),
                group_ids: request.group_ids,
            };
            if let Some(existing) = store.profiles.iter_mut().find(|p| p.id == profile.id) {
                *existing = profile;
            } else {
                store.profiles.push(profile);
            }
            Ok(())
        })
    }

    pub fn delete_profile(&self, request: DeleteSessionProfile) -> Result<ProfileLibrarySnapshot> {
        self.mutate(&request.expected_revision, |store| {
            let index = store
                .profiles
                .iter()
                .position(|p| p.id == request.id)
                .ok_or_else(|| ProfileError::NotFound("Session profile not found.".into()))?;
            store.profiles.remove(index);
            Ok(())
        })
    }

    pub fn set_directory(&self, request: SetProfileDirectory) -> Result<ProfileLibrarySnapshot> {
        validate_reference(&request.directory)?;
        let requested = Path::new(&request.directory);
        if !requested.is_absolute() {
            return Err(ProfileError::Invalid(
                "Library directory must be an absolute host path; shell expressions are not expanded."
                    .into(),
            ));
        }
        // Do not create arbitrary directories for a setting change. An existing empty directory
        // is accepted and initialized only after its old expected revision has been checked.
        let target = canonical_directory(requested)?;
        let _setting_lock = lock(&self.data_dir.join("profile-library.lock"))?;
        let current = self.directory()?;
        let current_lock = lock(&current.join(".profiles.lock"))?;
        let (_, revision) = read_store(&current)?;
        check_revision(&revision, &request.expected_revision)?;
        if path_key(&current) == path_key(&target) {
            let (store, revision) = read_store(&current)?;
            return Ok(snapshot(&current, store, revision));
        }
        // Release the current library before locking the target to avoid cross-library deadlocks.
        drop(current_lock);
        let _target_lock = lock(&target.join(".profiles.lock"))?;
        initialize_store(&target)?;
        let (store, revision) = read_store(&target)?;
        self.write_setting(&target)?;
        Ok(snapshot(&target, store, revision))
    }

    pub fn create_source(&self, request: CreateProfileSource) -> Result<CreatedProfileSource> {
        validate_source_name(&request.name)?;
        let content = match request.kind {
            ProfileSourceKind::Mcp => {
                let content = request
                    .content
                    .unwrap_or_else(|| "{\"mcpServers\":{}}\n".into());
                parse_mcp(content.as_bytes(), Path::new("new MCP source"))?;
                Some(content)
            }
            ProfileSourceKind::Skills => {
                if request.content.is_some() {
                    return Err(ProfileError::Invalid(
                        "Skill source creation only creates an empty directory; omit content."
                            .into(),
                    ));
                }
                None
            }
        };
        let _setting_lock = lock(&self.data_dir.join("profile-library.lock"))?;
        let directory = self.directory()?;
        let _library_lock = lock(&directory.join(".profiles.lock"))?;
        let (_, revision) = read_store(&directory)?;
        check_revision(&revision, &request.expected_revision)?;
        let root = Dir::open_ambient_dir(&directory, cap_std::ambient_authority())
            .map_err(|e| io_error("open library source root", &directory, e))?;
        let sources_path = directory.join("sources");
        let sources = owned_directory(&root, &sources_path, "sources")?;
        let category = match request.kind {
            ProfileSourceKind::Mcp => "mcp",
            ProfileSourceKind::Skills => "skills",
        };
        let parent_path = sources_path.join(category);
        let parent = owned_directory(&sources, &parent_path, category)?;
        let name = match request.kind {
            ProfileSourceKind::Mcp => format!("{}.json", request.name),
            ProfileSourceKind::Skills => request.name,
        };
        let path = parent_path.join(&name);
        if let Some(content) = content {
            let mut options = cap_std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use cap_std::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = parent
                .open_with(&name, &options)
                .map_err(|e| io_error("create new file without overwriting", &path, e))?;
            if let Err(error) = file
                .write_all(content.as_bytes())
                .and_then(|_| file.sync_all())
            {
                drop(file);
                let _ = parent.remove_file(&name);
                return Err(io_error("write new source", &path, error));
            }
        } else {
            parent
                .create_dir(&name)
                .map_err(|e| io_error("create new skill source", &path, e))?;
        }
        Ok(CreatedProfileSource {
            path: display_path(&path),
            kind: request.kind,
        })
    }

    pub fn resolve(&self, profile_id: Option<&str>) -> Result<ResolvedProfile> {
        let _setting_lock = lock(&self.data_dir.join("profile-library.lock"))?;
        self.resolve_directory(&self.directory()?, profile_id)
    }

    pub fn resolve_by_revision(
        &self,
        profile_id: Option<&str>,
        expected_revision: &str,
    ) -> Result<ResolvedProfile> {
        let resolved = self.resolve(profile_id)?;
        if resolved.revision != expected_revision {
            return Err(ProfileError::SourceRevisionConflict);
        }
        Ok(resolved)
    }

    pub fn resolve_selection(&self, selection: &ProfileSelection) -> Result<ResolvedProfile> {
        resolve_snapshot(selection)
    }

    pub fn resolve_snapshot(&self, selection: &ProfileSelection) -> Result<ResolvedProfile> {
        resolve_snapshot(selection)
    }

    fn resolve_directory(
        &self,
        directory: &Path,
        profile_id: Option<&str>,
    ) -> Result<ResolvedProfile> {
        let _library_lock = lock(&directory.join(".profiles.lock"))?;
        let (store, _) = read_store(directory)?;
        compile(directory, &store, profile_id)
    }

    fn mutate(
        &self,
        expected_revision: &str,
        edit: impl FnOnce(&mut Store) -> Result<()>,
    ) -> Result<ProfileLibrarySnapshot> {
        let _setting_lock = lock(&self.data_dir.join("profile-library.lock"))?;
        let directory = self.directory()?;
        let _library_lock = lock(&directory.join(".profiles.lock"))?;
        let (mut store, revision) = read_store(&directory)?;
        check_revision(&revision, expected_revision)?;
        edit(&mut store)?;
        validate_store(&store)?;
        store.revision = Uuid::new_v4().to_string();
        atomic_json(&directory.join("profiles.json"), &store)?;
        let (store, revision) = read_store(&directory)?;
        Ok(snapshot(&directory, store, revision))
    }

    fn setting_path(&self) -> PathBuf {
        self.data_dir.join("profile-library.json")
    }

    fn directory(&self) -> Result<PathBuf> {
        let path = self.setting_path();
        let bytes = read_bytes(&path, MAX_LIBRARY_BYTES)?;
        let setting: DirectorySetting = parse_store_json(&bytes, &path)?;
        if setting.version != STORE_VERSION || !Path::new(&setting.directory).is_absolute() {
            return Err(corrupt(
                &path,
                "unsupported version or non-absolute directory",
            ));
        }
        canonical_directory(Path::new(&setting.directory))
    }

    fn write_setting(&self, directory: &Path) -> Result<()> {
        atomic_json(
            &self.setting_path(),
            &DirectorySetting {
                version: STORE_VERSION,
                directory: display_path(directory),
            },
        )
    }
}

/// Resolve an approved assignment without opening the current Settings library or consulting its
/// pointer. This is the restart/apply primitive; a different or broken current library is irrelevant.
/// Legacy assignments without a snapshot still use the original library and reject changed inputs.
pub fn resolve_snapshot(selection: &ProfileSelection) -> Result<ResolvedProfile> {
    validate_reference(&selection.directory)?;
    let directory = Path::new(&selection.directory);
    if !directory.is_absolute() {
        return Err(ProfileError::Invalid(
            "Saved profile library directory must be absolute.".into(),
        ));
    }
    let resolved = if selection.profile_id.is_none() {
        if selection.snapshot.is_some() {
            return Err(ProfileError::Invalid(
                "A default selection cannot contain an explicit profile snapshot.".into(),
            ));
        }
        // Default has no linked inputs and must not depend on an old library still existing.
        compile(directory, &Store::empty(), None)?
    } else if let Some(snapshot) = &selection.snapshot {
        if selection.profile_id.as_deref() != Some(snapshot.profile.id.as_str()) {
            return Err(ProfileError::Invalid(
                "Saved profile ID does not match its approved snapshot.".into(),
            ));
        }
        if json_bytes(snapshot)?.len() as u64 > MAX_LIBRARY_BYTES {
            return Err(ProfileError::Invalid(
                "Saved profile snapshot exceeds 4 MiB.".into(),
            ));
        }
        let store = Store {
            groups: snapshot.groups.clone(),
            profiles: vec![snapshot.profile.clone()],
            ..Store::empty()
        };
        validate_store(&store)?;
        let directory = canonical_directory(directory)?;
        compile(&directory, &store, selection.profile_id.as_deref())?
    } else {
        let directory = canonical_directory(directory)?;
        let _library_lock = lock(&directory.join(".profiles.lock"))?;
        let (store, _) = read_store(&directory)?;
        compile(&directory, &store, selection.profile_id.as_deref())?
    };
    if resolved.revision != selection.revision || resolved.name != selection.name {
        return Err(ProfileError::SourceRevisionConflict);
    }
    Ok(resolved)
}

fn compile(directory: &Path, store: &Store, profile_id: Option<&str>) -> Result<ResolvedProfile> {
    let mut resolved = ResolvedProfile {
        directory: display_path(directory),
        profile_id: profile_id.map(str::to_owned),
        name: "Default".into(),
        revision: String::new(),
        group_names: vec![],
        mcp_servers: IndexMap::new(),
        skill_directories: vec![],
        warnings: vec![],
        mcp_sources: vec![],
        resolution_snapshot: None,
    };
    let mut fingerprint = Sha256::new();
    hash_part(&mut fingerprint, b"copilot-sessions-profile-v2");
    let Some(profile_id) = profile_id else {
        hash_part(&mut fingerprint, b"automatic-discovery-only");
        resolved.revision = format!("{:x}", fingerprint.finalize());
        return Ok(resolved);
    };
    let profile = store
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| ProfileError::NotFound("Session profile not found.".into()))?;
    resolved.name = profile.name.clone();
    hash_part(&mut fingerprint, path_key(directory).as_bytes());
    hash_part(&mut fingerprint, &json_bytes(profile)?);
    let mut definitions: IndexMap<String, (Value, String)> = IndexMap::new();
    let mut directory_keys = HashSet::new();
    let mut skill_names = HashMap::new();
    let mut source_cache: HashMap<String, Vec<u8>> = HashMap::new();
    let mut compiled_bytes = 0usize;
    let mut compiled_sources = 0usize;
    let mut compiled_definitions = 0usize;
    let mut skills = SkillInspection::default();
    let mut approved_groups = Vec::with_capacity(profile.group_ids.len());
    for group_id in &profile.group_ids {
        let group = store
            .groups
            .iter()
            .find(|group| &group.id == group_id)
            .ok_or_else(|| ProfileError::Invalid("Profile references an unknown group.".into()))?;
        resolved.group_names.push(group.name.clone());
        approved_groups.push(group.clone());
        hash_part(&mut fingerprint, &json_bytes(group)?);
        for reference in &group.mcp_config_files {
            compiled_sources += 1;
            if compiled_sources > MAX_COMPILED_SOURCES {
                return Err(ProfileError::Invalid(
                    "Profile exceeds 512 MCP source references.".into(),
                ));
            }
            let path = resolve_reference(directory, reference, false)?;
            let key = path_key(&path);
            let bytes = if let Some(bytes) = source_cache.get(&key) {
                bytes.clone()
            } else {
                let bytes = read_bytes(&path, MAX_SOURCE_BYTES)?;
                compiled_bytes += bytes.len();
                if compiled_bytes > MAX_COMPILED_BYTES {
                    return Err(ProfileError::Invalid(
                        "Combined MCP sources exceed 16 MiB.".into(),
                    ));
                }
                source_cache.insert(key.clone(), bytes.clone());
                bytes
            };
            hash_part(&mut fingerprint, key.as_bytes());
            hash_part(&mut fingerprint, &bytes);
            let source_file = display_path(&path);
            let (servers, placeholders) = parse_mcp(&bytes, &path)?;
            compiled_definitions += servers.len();
            if compiled_definitions > MAX_COMPILED_DEFINITIONS {
                return Err(ProfileError::Invalid(
                    "Profile exceeds 4096 MCP definitions across its sources.".into(),
                ));
            }
            if placeholders {
                let warning = format!(
                    "Environment placeholders in '{source_file}' are passed through unchanged. \
                     This app does not expand them; stdio env values are literal in the pinned SDK."
                );
                if !resolved.warnings.contains(&warning) {
                    resolved.warnings.push(warning);
                }
            }
            for (name, definition) in servers {
                if let Some((previous, source)) = definitions.get(&name) {
                    if previous == &definition {
                        continue;
                    }
                    resolved.warnings.push(format!(
                        "MCP server '{name}' from '{source_file}' replaces the entire definition \
                         from '{source}' (later group/source wins)."
                    ));
                    definitions.shift_remove(&name);
                }
                definitions.insert(name, (definition, source_file.clone()));
                if definitions.len() > MAX_SERVERS {
                    return Err(ProfileError::Invalid(
                        "Profile exceeds 512 MCP servers.".into(),
                    ));
                }
            }
        }
        for reference in &group.skill_directories {
            let path = resolve_reference(directory, reference, true)?;
            let key = path_key(&path);
            if directory_keys.insert(key.clone()) {
                if directory_keys.len() > MAX_REFERENCES {
                    return Err(ProfileError::Invalid(
                        "Profile exceeds 128 skill directories.".into(),
                    ));
                }
                hash_part(&mut fingerprint, key.as_bytes());
                inspect_skills(
                    &path,
                    &mut fingerprint,
                    &mut skill_names,
                    &mut resolved.warnings,
                    &mut skills,
                )?;
                resolved.skill_directories.push(path);
            }
        }
    }
    // Detect a source edited while compiling instead of returning a mixed read of those sources.
    for (key, bytes) in source_cache {
        if read_bytes(Path::new(&key), MAX_SOURCE_BYTES)? != bytes {
            return Err(ProfileError::SourceRevisionConflict);
        }
    }
    for (path, digest) in skills.manifests {
        let bytes = read_bytes(&path, MAX_SKILL_MANIFEST_BYTES)?;
        if <[u8; 32]>::from(Sha256::digest(&bytes)) != digest {
            return Err(ProfileError::SourceRevisionConflict);
        }
    }
    if !resolved.skill_directories.is_empty() {
        resolved.warnings.push(SKILL_FINGERPRINT_WARNING.into());
    }
    for (name, (definition, source_file)) in definitions {
        let config = serde_json::from_value(definition).map_err(|_| {
            ProfileError::Invalid(
                "MCP configuration cannot be represented by the pinned SDK.".into(),
            )
        })?;
        resolved.mcp_sources.push(ProfileMcpSource {
            name: name.clone(),
            source_file,
        });
        resolved.mcp_servers.insert(name, config);
    }
    resolved.revision = format!("{:x}", fingerprint.finalize());
    resolved.resolution_snapshot = Some(ProfileResolutionSnapshot {
        profile: profile.clone(),
        groups: approved_groups,
    });
    Ok(resolved)
}

fn parse_mcp(bytes: &[u8], path: &Path) -> Result<(IndexMap<String, Value>, bool)> {
    if bytes.len() as u64 > MAX_SOURCE_BYTES {
        return Err(ProfileError::Invalid("MCP source exceeds 2 MiB.".into()));
    }
    let value: Value = serde_json::from_slice(strip_bom(bytes)).map_err(|error| {
        ProfileError::Invalid(format!(
            "Malformed MCP JSON in '{}' at line {}, column {}.",
            display_path(path),
            error.line(),
            error.column()
        ))
    })?;
    let root = value.as_object().ok_or_else(|| {
        ProfileError::Invalid("MCP source must be a CLI JSON object with mcpServers.".into())
    })?;
    if root
        .keys()
        .any(|key| key != "mcpServers" && key != "$schema")
    {
        return Err(ProfileError::Invalid(format!(
            "Unsupported MCP dialect in '{}': expected only mcpServers (and optional $schema), \
             not VS Code servers/inputs or an executable template.",
            display_path(path)
        )));
    }
    let servers = root
        .get("mcpServers")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            ProfileError::Invalid(format!(
                "MCP source '{}' requires a CLI-shaped mcpServers object.",
                display_path(path)
            ))
        })?;
    if servers.len() > MAX_SERVERS {
        return Err(ProfileError::Invalid(
            "MCP source exceeds 512 servers.".into(),
        ));
    }
    let mut normalized = IndexMap::new();
    let mut placeholders = false;
    for (name, raw) in servers {
        validate_name(name)?;
        if let Some(marker) = unresolved_template_marker(raw) {
            return Err(ProfileError::Invalid(format!(
                "Unresolved {marker} template in '{}'. Link the generated MCP config file, \
                 not its template; this app never expands templates.",
                display_path(path)
            )));
        }
        placeholders |= contains_environment_placeholder(raw);
        let mut entry = raw.as_object().cloned().ok_or_else(|| {
            ProfileError::Invalid(format!("MCP server '{name}' must be a JSON object."))
        })?;
        let transport = match entry.get("type").and_then(Value::as_str) {
            Some("stdio" | "local") => "stdio",
            Some("http") => "http",
            Some("sse") => "sse",
            None if !entry.contains_key("type") && entry.contains_key("command") => "stdio",
            None if !entry.contains_key("type") && entry.contains_key("url") => {
                return Err(ProfileError::Invalid(format!(
                    "MCP server '{name}' with a URL must explicitly specify type http or sse."
                )));
            }
            _ => {
                return Err(ProfileError::Invalid(format!(
                    "Unsupported MCP transport for '{name}'."
                )));
            }
        };
        let supported: &[&str] = if transport == "stdio" {
            &["type", "command", "args", "env", "cwd", "tools", "timeout"]
        } else {
            &["type", "url", "headers", "tools", "timeout"]
        };
        if entry.keys().any(|key| !supported.contains(&key.as_str())) {
            return Err(ProfileError::Invalid(format!(
                "MCP server '{name}' in '{}' has fields unsupported by the pinned SDK. \
                 No fields were discarded; supported {transport} fields: {}.",
                display_path(path),
                supported.join(", ")
            )));
        }
        entry.insert("type".into(), Value::String(transport.into()));
        let required = if transport == "stdio" {
            "command"
        } else {
            "url"
        };
        if entry
            .get(required)
            .and_then(Value::as_str)
            .is_none_or(|value| value.trim().is_empty())
        {
            return Err(ProfileError::Invalid(format!(
                "MCP server '{name}' requires a nonempty {required}."
            )));
        }
        if transport != "stdio" {
            let url = entry["url"].as_str().unwrap();
            if !url.starts_with("http://") && !url.starts_with("https://") {
                return Err(ProfileError::Invalid(format!(
                    "MCP server '{name}' requires an HTTP(S) URL."
                )));
            }
        }
        let config: McpServerConfig = serde_json::from_value(Value::Object(entry)).map_err(|_| {
            ProfileError::Invalid(format!(
                "Invalid MCP server '{name}' in '{}': check field types against the pinned SDK.",
                display_path(path)
            ))
        })?;
        // Normalize omitted defaults and local/stdio aliases before duplicate comparison.
        let definition = serde_json::to_value(config).map_err(|_| {
            ProfileError::Invalid("Cannot normalize MCP server configuration.".into())
        })?;
        normalized.insert(name.clone(), definition);
    }
    Ok((normalized, placeholders))
}

fn unresolved_template_marker(value: &Value) -> Option<&'static str> {
    TEMPLATE_MARKERS
        .into_iter()
        .find(|marker| walk_strings(value, &|text| text.contains(marker)))
}

fn contains_environment_placeholder(value: &Value) -> bool {
    walk_strings(value, &|text| {
        text.contains("${")
            || text.contains("$env:")
            || text.contains("$(")
            || (text.matches('%').count() >= 2)
    })
}

fn walk_strings(value: &Value, predicate: &impl Fn(&str) -> bool) -> bool {
    match value {
        Value::String(text) => predicate(text),
        Value::Array(values) => values.iter().any(|value| walk_strings(value, predicate)),
        Value::Object(values) => values
            .iter()
            .any(|(key, value)| predicate(key) || walk_strings(value, predicate)),
        _ => false,
    }
}

#[derive(Default)]
struct SkillInspection {
    entries: usize,
    bytes: usize,
    manifests: Vec<(PathBuf, [u8; 32])>,
}

fn inspect_skills(
    directory: &Path,
    fingerprint: &mut Sha256,
    names: &mut HashMap<String, String>,
    warnings: &mut Vec<String>,
    inspection: &mut SkillInspection,
) -> Result<()> {
    let entries =
        fs::read_dir(directory).map_err(|e| io_error("list skill directory", directory, e))?;
    let mut entries = entries
        .take(MAX_SKILL_ENTRIES + 1)
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(|e| io_error("list skill directory", directory, e))?;
    inspection.entries += entries.len();
    if inspection.entries > MAX_SKILL_ENTRIES {
        return Err(ProfileError::Invalid(
            "Profile skill directories exceed 4096 entries in total.".into(),
        ));
    }
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let metadata =
            fs::metadata(&path).map_err(|e| io_error("inspect skill entry", &path, e))?;
        if !metadata.is_dir() {
            continue;
        }
        let skill = path.join("SKILL.md");
        let skill_metadata = match fs::metadata(&skill) {
            Ok(metadata) if metadata.is_file() => metadata,
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(io_error("inspect skill metadata", &skill, error)),
        };
        if skill_metadata.len() > MAX_SKILL_MANIFEST_BYTES {
            return Err(ProfileError::Invalid(format!(
                "Skill manifest '{}' exceeds 1 MiB.",
                display_path(&skill)
            )));
        }
        let remaining = MAX_SKILL_MANIFEST_TOTAL_BYTES - inspection.bytes;
        if skill_metadata.len() > remaining as u64 {
            return Err(ProfileError::Invalid(
                "Profile skill manifests exceed 8 MiB in total.".into(),
            ));
        }
        let bytes = read_bytes(&skill, MAX_SKILL_MANIFEST_BYTES.min(remaining as u64))?;
        inspection.bytes += bytes.len();
        let digest: [u8; 32] = Sha256::digest(&bytes).into();
        inspection.manifests.push((skill, digest));
        let name = entry.file_name().to_string_lossy().into_owned();
        let source = display_path(&path);
        if let Some(previous) = names.get(&name.to_lowercase()) {
            warnings.push(format!(
                "Skill directory name '{name}' occurs in '{previous}' and '{source}'. \
                 Directories keep profile order; native discovery determines the selected skill."
            ));
        } else {
            names.insert(name.to_lowercase(), source);
        }
        hash_part(fingerprint, name.as_bytes());
        hash_part(fingerprint, &digest);
    }
    Ok(())
}

fn validate_store(store: &Store) -> Result<()> {
    if store.version != STORE_VERSION {
        return Err(ProfileError::Invalid(
            "Unsupported profile library version.".into(),
        ));
    }
    validate_id(&store.revision)?;
    if store.groups.len() > MAX_RECORDS || store.profiles.len() > MAX_RECORDS {
        return Err(ProfileError::Invalid(
            "Library exceeds 256 groups or profiles.".into(),
        ));
    }
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    for group in &store.groups {
        validate_id(&group.id)?;
        validate_name(&group.name)?;
        if !ids.insert(&group.id) || !names.insert(group.name.to_lowercase()) {
            return Err(ProfileError::Invalid(
                "Group IDs and names must be unique (names ignore case).".into(),
            ));
        }
        if group.mcp_config_files.len() > MAX_REFERENCES
            || group.skill_directories.len() > MAX_REFERENCES
        {
            return Err(ProfileError::Invalid(
                "A group may have at most 128 sources of each kind.".into(),
            ));
        }
        for reference in group
            .mcp_config_files
            .iter()
            .chain(&group.skill_directories)
        {
            validate_reference(reference)?;
        }
    }
    let group_ids = ids;
    let mut ids = HashSet::new();
    names.clear();
    for profile in &store.profiles {
        validate_id(&profile.id)?;
        validate_name(&profile.name)?;
        if !ids.insert(&profile.id) || !names.insert(profile.name.to_lowercase()) {
            return Err(ProfileError::Invalid(
                "Profile IDs and names must be unique (names ignore case).".into(),
            ));
        }
        if profile.group_ids.len() > MAX_REFERENCES {
            return Err(ProfileError::Invalid(
                "A profile may reference at most 128 groups.".into(),
            ));
        }
        let mut selected = HashSet::new();
        for group_id in &profile.group_ids {
            if !group_ids.contains(group_id) {
                return Err(ProfileError::Invalid(
                    "Profile references an unknown group.".into(),
                ));
            }
            if !selected.insert(group_id) {
                return Err(ProfileError::Invalid(
                    "A profile cannot repeat a group reference.".into(),
                ));
            }
        }
    }
    Ok(())
}

fn validate_id(id: &str) -> Result<()> {
    Uuid::parse_str(id)
        .map_err(|_| ProfileError::Invalid("Invalid profile library UUID.".into()))?;
    Ok(())
}

fn record_id<'a>(id: Option<&str>, ids: impl Iterator<Item = &'a str>) -> Result<String> {
    match id {
        None => Ok(Uuid::new_v4().to_string()),
        Some(id) => {
            validate_id(id)?;
            if !ids.into_iter().any(|existing| existing == id) {
                return Err(ProfileError::NotFound(
                    "Profile library record not found.".into(),
                ));
            }
            Ok(id.to_owned())
        }
    }
}

fn validate_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > MAX_NAME
        || name.trim() != name
        || name.chars().any(char::is_control)
    {
        return Err(ProfileError::Invalid(
            "Names must be 1–128 bytes without surrounding whitespace or control characters."
                .into(),
        ));
    }
    Ok(())
}

fn validate_reference(reference: &str) -> Result<()> {
    if reference.is_empty() || reference.len() > MAX_PATH || reference.chars().any(char::is_control)
    {
        return Err(ProfileError::Invalid(
            "Source paths must be 1–4096 bytes without control characters.".into(),
        ));
    }
    if TEMPLATE_MARKERS
        .iter()
        .any(|marker| reference.contains(marker))
        || reference.starts_with('~')
        || reference.contains("${")
        || reference.contains("$(")
        || reference.contains("$env:")
        || reference.matches('%').count() >= 2
    {
        return Err(ProfileError::Invalid(
            "Source paths must be literal host paths. Link generated files rather than bootstrap \
             templates (__HOME__, __LOCALAPPDATA__, __NPM_GLOBAL__); shell/environment expressions \
             are not expanded."
                .into(),
        ));
    }
    Ok(())
}

fn validate_source_name(name: &str) -> Result<()> {
    validate_name(name)?;
    if name == "."
        || name == ".."
        || name.ends_with('.')
        || name.ends_with(' ')
        || !name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        return Err(ProfileError::Invalid("Source name must be a single filename using letters, numbers, dots, hyphens or underscores.".into()));
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    {
        return Err(ProfileError::Invalid(
            "Source name is reserved by Windows.".into(),
        ));
    }
    Ok(())
}

fn resolve_reference(directory: &Path, reference: &str, is_directory: bool) -> Result<PathBuf> {
    validate_reference(reference)?;
    let reference = Path::new(reference);
    // Reject drive-relative and root-relative Windows paths: neither is relative to the library.
    if !reference.is_absolute()
        && reference.components().any(|component| {
            matches!(
                component,
                std::path::Component::Prefix(_) | std::path::Component::RootDir
            )
        })
    {
        return Err(ProfileError::Invalid(
            "Source path must be fully absolute or relative to the library.".into(),
        ));
    }
    let path = directory.join(reference);
    let path = fs::canonicalize(&path).map_err(|e| io_error("resolve linked source", &path, e))?;
    let metadata = fs::metadata(&path).map_err(|e| io_error("inspect linked source", &path, e))?;
    if (is_directory && !metadata.is_dir()) || (!is_directory && !metadata.is_file()) {
        return Err(ProfileError::Invalid(format!(
            "Linked source '{}' is not a {}.",
            display_path(&path),
            if is_directory { "directory" } else { "file" }
        )));
    }
    Ok(path)
}

fn canonical_directory(path: &Path) -> Result<PathBuf> {
    let canonical =
        fs::canonicalize(path).map_err(|e| io_error("open library directory", path, e))?;
    if !fs::metadata(&canonical)
        .map_err(|e| io_error("inspect library directory", path, e))?
        .is_dir()
    {
        return Err(ProfileError::Invalid(
            "Profile library path is not a directory.".into(),
        ));
    }
    Ok(canonical)
}

fn owned_directory(parent: &Dir, path: &Path, name: &str) -> Result<Dir> {
    match parent.create_dir(name) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(io_error("create owned source directory", &path, error)),
    }
    // A pathname check alone races with another process replacing a parent with a junction.
    let directory = parent.open_dir_nofollow(name).map_err(|e| {
        io_error(
            "open owned source directory without following links",
            path,
            e,
        )
    })?;
    let metadata = directory
        .dir_metadata()
        .map_err(|e| io_error("inspect owned directory", path, e))?;
    #[cfg(windows)]
    let linked = {
        use cap_std::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let linked = metadata.is_symlink();
    if linked || !metadata.is_dir() {
        return Err(ProfileError::Invalid(
            "Library-owned source directories must be real directories, not links.".into(),
        ));
    }
    Ok(directory)
}

fn lock(path: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|e| io_error("open library lock", path, e))?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(std::fs::TryLockError::WouldBlock) => Err(ProfileError::Busy),
        Err(std::fs::TryLockError::Error(error)) => {
            Err(io_error("lock profile library", path, error))
        }
    }
}

fn initialize_store(directory: &Path) -> Result<()> {
    let path = directory.join("profiles.json");
    if optional_bytes(&path, MAX_LIBRARY_BYTES)?.is_some() {
        read_store(directory)?;
    } else {
        atomic_json(&path, &Store::empty())?;
    }
    Ok(())
}

fn read_store(directory: &Path) -> Result<(Store, String)> {
    let path = directory.join("profiles.json");
    let bytes = read_bytes(&path, MAX_LIBRARY_BYTES)?;
    let store: Store = parse_store_json(&bytes, &path)?;
    validate_store(&store).map_err(|error| corrupt(&path, &error.to_string()))?;
    let mut fingerprint = Sha256::new();
    hash_part(&mut fingerprint, path_key(directory).as_bytes());
    hash_part(&mut fingerprint, &bytes);
    Ok((store, format!("{:x}", fingerprint.finalize())))
}

fn parse_store_json<T: for<'de> Deserialize<'de>>(bytes: &[u8], path: &Path) -> Result<T> {
    serde_json::from_slice(strip_bom(bytes)).map_err(|error| {
        corrupt(
            path,
            &format!(
                "JSON/schema error at line {}, column {}",
                error.line(),
                error.column()
            ),
        )
    })
}

fn strip_bom(bytes: &[u8]) -> &[u8] {
    bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes)
}

fn snapshot(directory: &Path, store: Store, revision: String) -> ProfileLibrarySnapshot {
    ProfileLibrarySnapshot {
        directory: display_path(directory),
        revision,
        groups: store.groups,
        profiles: store.profiles,
    }
}

fn check_revision(actual: &str, expected: &str) -> Result<()> {
    if actual != expected {
        return Err(ProfileError::RevisionConflict);
    }
    Ok(())
}

fn hash_part(hash: &mut Sha256, bytes: &[u8]) {
    hash.update((bytes.len() as u64).to_le_bytes());
    hash.update(bytes);
}

fn json_bytes(value: &impl Serialize) -> Result<Vec<u8>> {
    serde_json::to_vec(value)
        .map_err(|_| ProfileError::Invalid("Cannot encode profile data.".into()))
}

fn atomic_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let bytes = json_bytes(value)?;
    if bytes.len() as u64 > MAX_LIBRARY_BYTES {
        return Err(ProfileError::Invalid(
            "Profile library exceeds 4 MiB.".into(),
        ));
    }
    let staging = path.with_file_name(format!(".profiles-{}.writing", Uuid::new_v4()));
    let result = (|| {
        let mut file = create_new_file(&staging)?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| io_error("write library", path, e))?;
        drop(file);
        fs::rename(&staging, path).map_err(|e| io_error("atomically replace library", path, e))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staging);
    }
    result
}

fn create_new_file(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|e| io_error("create new file without overwriting", path, e))
}

fn optional_bytes(path: &Path, limit: u64) -> Result<Option<Vec<u8>>> {
    match File::open(path) {
        Ok(file) => bounded_read(file, path, limit).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_error("read profile file", path, error)),
    }
}

fn read_bytes(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let file = File::open(path).map_err(|e| io_error("read profile file", path, e))?;
    bounded_read(file, path, limit)
}

fn bounded_read(file: File, path: &Path, limit: u64) -> Result<Vec<u8>> {
    let metadata = file
        .metadata()
        .map_err(|e| io_error("inspect profile file", path, e))?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err(ProfileError::Invalid(format!(
            "Profile source '{}' must be a regular file no larger than {limit} bytes.",
            display_path(path)
        )));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| io_error("read profile file", path, e))?;
    if bytes.len() as u64 > limit {
        return Err(ProfileError::Invalid(
            "Profile source grew beyond its size limit.".into(),
        ));
    }
    Ok(bytes)
}

fn io_error(operation: &'static str, path: &Path, error: std::io::Error) -> ProfileError {
    ProfileError::Io {
        operation,
        path: display_path(path),
        kind: error.kind(),
    }
}

fn corrupt(path: &Path, reason: &str) -> ProfileError {
    ProfileError::Corrupt {
        path: display_path(path),
        reason: reason.to_owned(),
    }
}

fn display_path(path: &Path) -> String {
    let path = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(unc) = path.strip_prefix("\\\\?\\UNC\\") {
            return format!("\\\\{unc}");
        }
        if let Some(disk) = path.strip_prefix("\\\\?\\") {
            return disk.to_owned();
        }
    }
    path.into_owned()
}

fn path_key(path: &Path) -> String {
    let path = display_path(path);
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path
    }
}

#[cfg(test)]
#[path = "profiles/tests.rs"]
mod tests;
