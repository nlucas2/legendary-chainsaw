//! Resolve plugin MCP exclusions by source before applying name-based runtime filters.
use crate::{Result, ServiceError, SessionService, profiles::ResolvedProfile};
use github_copilot_sdk::{Client, types::McpServerConfig};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashMap},
    path::Path,
};

#[cfg(test)]
#[path = "mcp_resolution_tests.rs"]
mod tests;
/// Only source fingerprints and server names are persisted, never MCP credentials.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileMcpState {
    pub revision: String,
    pub disabled: Vec<String>,
    pub owned: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpExclusionDecision {
    pub name: String,
    pub action: &'static str,
    pub reason: String,
}

#[derive(Default)]
pub(crate) struct McpResolution {
    pub disabled: Vec<String>,
    pub global_disabled: Vec<String>,
    pub overrides: IndexMap<String, McpServerConfig>,
    pub decisions: Vec<McpExclusionDecision>,
    pub issues: Vec<String>,
    pub revision: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Source {
    name: String,
    source: String,
    source_plugin: Option<String>,
    enabled: bool,
    #[serde(default)]
    source_plugin_version: Option<String>,
}

impl McpResolution {
    pub fn require_resolved(&self) -> Result<()> {
        if self.issues.is_empty() {
            Ok(())
        } else {
            Err(ServiceError::InvalidArgument(format!(
                "MCP source resolution needs attention: {}",
                self.issues.join(" ")
            )))
        }
    }

    pub fn definitions(&self, profile: &ResolvedProfile) -> IndexMap<String, McpServerConfig> {
        let mut result = self.overrides.clone();
        result.extend(profile.mcp_servers.clone());
        result
    }

    pub fn disabled_with(&self, existing: &[String], previous_owned: &[String]) -> Vec<String> {
        let mut disabled: BTreeSet<_> = existing
            .iter()
            .filter(|name| !previous_owned.contains(name))
            .cloned()
            .collect();
        disabled.extend(self.global_disabled.clone());
        disabled.extend(self.disabled.clone());
        disabled.into_iter().collect()
    }

    pub fn state(&self, existing: &[String], previous_owned: &[String]) -> ProfileMcpState {
        ProfileMcpState {
            revision: self.revision.clone(),
            disabled: self.disabled_with(existing, previous_owned),
            owned: self
                .disabled
                .iter()
                .filter(|name| {
                    !self.global_disabled.contains(name)
                        && (!existing.contains(name) || previous_owned.contains(name))
                })
                .cloned()
                .collect(),
        }
    }
}

pub(crate) async fn resolve(
    client: &Client,
    profile: &ResolvedProfile,
    cwd: &str,
) -> Result<McpResolution> {
    if profile.excluded_mcp_plugins.is_empty() {
        return Ok(McpResolution::default());
    }
    let discovered = client
        .call("mcp.discover", Some(json!({"workingDirectory":cwd})))
        .await?;
    let mut sources: Vec<Source> =
        serde_json::from_value(discovered.get("servers").cloned().ok_or_else(|| {
            ServiceError::CommandFailed("Runtime did not provide MCP source provenance".into())
        })?)
        .map_err(|_| ServiceError::CommandFailed("Invalid runtime MCP source provenance".into()))?;
    sources.sort_by(|a, b| a.name.cmp(&b.name));
    let plugins = client.rpc().plugins().list().await?;
    let included_plugins: Vec<_> = plugins
        .plugins
        .iter()
        .filter(|plugin| plugin.enabled && !profile.excluded_mcp_plugins.contains(&plugin.name))
        .map(|plugin| plugin.name.clone())
        .collect();
    let base = client.call("mcp.config.list", Some(json!({}))).await?;
    let base = base
        .get("servers")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            ServiceError::CommandFailed("Runtime did not provide base MCP configuration".into())
        })?;
    let workspace = workspace_candidates(Path::new(cwd))?;
    resolve_sources(profile, &sources, base, &workspace, &included_plugins)
}

fn resolve_sources(
    profile: &ResolvedProfile,
    sources: &[Source],
    base: &serde_json::Map<String, Value>,
    workspace: &HashMap<String, Vec<String>>,
    included_plugins: &[String],
) -> Result<McpResolution> {
    let mut result = McpResolution::default();
    let mut seen = BTreeSet::new();
    let mut hash = Sha256::new();
    for source in sources {
        if !seen.insert(source.name.clone()) {
            result.issues.push(format!(
                "Multiple native winners reported for '{}'.",
                source.name
            ));
            continue;
        }
        if !source.enabled {
            result.global_disabled.push(source.name.clone());
        }
        hash.update(serde_json::to_vec(source).map_err(crate::runtime_api::invalid_argument)?);
        let excluded = source
            .source_plugin
            .as_ref()
            .is_some_and(|plugin| profile.excluded_mcp_plugins.contains(plugin));
        if !matches!(
            source.source.as_str(),
            "user" | "workspace" | "builtin" | "plugin"
        ) {
            result.issues.push(format!(
                "Source '{}' for '{}' is not understood.",
                source.source, source.name
            ));
        } else if source.source == "plugin" && source.source_plugin.is_none() {
            result
                .issues
                .push(format!("Plugin owner for '{}' is unknown.", source.name));
        }
        if !excluded {
            result.decisions.push(McpExclusionDecision {
                name: source.name.clone(),
                action: "keep",
                reason: format!(
                    "Independent {} source{}.",
                    source.source,
                    source
                        .source_plugin
                        .as_ref()
                        .map(|name| format!(" ({name})"))
                        .unwrap_or_default()
                ),
            });
            continue;
        }
        let (action, reason) = if profile.mcp_servers.contains_key(&source.name) {
            (
                "keep",
                "Explicitly configured by an included profile group.".to_owned(),
            )
        } else if source.source == "workspace"
            || source.source == "user"
            || source.source == "builtin"
        {
            (
                "keep",
                format!(
                    "Runtime selects an independent {} definition.",
                    source.source
                ),
            )
        } else if let Some(paths) = workspace.get(&source.name) {
            // The pinned discovery API returns only winners. It does not expose
            // shadowed repository definitions or their precedence reliably.
            let reason = format!(
                "Repository also defines '{}' in {}. Link the intended file in a profile group to establish precedence.",
                source.name,
                paths.join(", ")
            );
            result.issues.push(reason.clone());
            ("unresolved", reason)
        } else if source.source == "plugin" && !included_plugins.is_empty() {
            let reason = format!(
                "The runtime hides shadowed definitions: '{}' could also be supplied by an included plugin ({}). Link its intended definition in a profile group to establish fallback precedence.",
                source.name,
                included_plugins.join(", ")
            );
            result.issues.push(reason.clone());
            ("unresolved", reason)
        } else if let Some(definition) = base.get(&source.name) {
            let encoded = serde_json::to_vec(&json!({"mcpServers":{&source.name:definition}}))
                .map_err(crate::runtime_api::invalid_argument)?;
            let (parsed, _) =
                crate::profiles::parse_mcp(&encoded, Path::new("base MCP configuration"))?;
            let typed = serde_json::from_value(parsed[&source.name].clone())
                .map_err(crate::runtime_api::invalid_argument)?;
            result.overrides.insert(source.name.clone(), typed);
            hash.update(encoded);
            ("keep", "Independently configured in the base MCP config; its definition overrides the excluded plugin.".to_owned())
        } else if source.source == "plugin" {
            result.disabled.push(source.name.clone());
            (
                "exclude",
                format!(
                    "Runtime selects excluded plugin '{}'; no independent base or profile definition exists.",
                    source.source_plugin.as_deref().unwrap()
                ),
            )
        } else {
            result.issues.push(format!(
                "Source '{}' for '{}' is not understood.",
                source.source, source.name
            ));
            ("unresolved", "Unknown source precedence.".to_owned())
        };
        result.decisions.push(McpExclusionDecision {
            name: source.name.clone(),
            action,
            reason,
        });
    }
    for plugin in &profile.excluded_mcp_plugins {
        if !sources
            .iter()
            .any(|source| source.source_plugin.as_ref() == Some(plugin))
        {
            result.decisions.push(McpExclusionDecision { name: plugin.clone(), action: "no-match",
                reason: "No effective MCP definitions attributed to this plugin; no server names disabled.".into() });
        }
    }
    result.disabled.sort();
    result.global_disabled.sort();
    result.decisions.sort_by(|a, b| a.name.cmp(&b.name));
    hash.update(
        serde_json::to_vec(&result.decisions).map_err(crate::runtime_api::invalid_argument)?,
    );
    result.revision = format!("{:x}", hash.finalize());
    Ok(result)
}

pub(crate) async fn disabled_servers(client: &Client, session_id: &str) -> Result<Vec<String>> {
    let inventory = client
        .call("session.mcp.list", Some(json!({"sessionId":session_id})))
        .await?;
    let mut disabled: Vec<String> = serde_json::from_value(inventory.pointer("/host/disabledServers").cloned().ok_or_else(||
        ServiceError::CapabilityUnavailable("Runtime does not expose existing disabled MCP names; exclusions were not changed.".into()))?)
        .map_err(|_| ServiceError::CommandFailed("Invalid disabled MCP inventory".into()))?;
    disabled.sort();
    disabled.dedup();
    Ok(disabled)
}

pub(crate) async fn verify_disabled(
    client: &Client,
    session_id: &str,
    expected: &[String],
) -> Result<()> {
    let inventory = client
        .call("session.mcp.list", Some(json!({"sessionId":session_id})))
        .await?;
    let actual: Vec<String> = serde_json::from_value(
        inventory
            .pointer("/host/disabledServers")
            .cloned()
            .ok_or_else(|| ServiceError::CommandFailed("Missing disabled MCP inventory".into()))?,
    )
    .map_err(crate::runtime_api::invalid_argument)?;
    let servers = inventory["servers"]
        .as_array()
        .ok_or_else(|| ServiceError::CommandFailed("Missing MCP inventory".into()))?;
    for name in expected {
        if !actual.contains(name)
            || servers
                .iter()
                .any(|server| server["name"] == *name && server["status"] != "disabled")
        {
            return Err(ServiceError::CommandFailed(format!(
                "MCP exclusion for '{name}' was not applied."
            )));
        }
    }
    Ok(())
}

impl SessionService {
    pub(crate) async fn resolve_profile_mcps(
        &self,
        profile: &ResolvedProfile,
        cwd: &str,
    ) -> Result<McpResolution> {
        if profile.excluded_mcp_plugins.is_empty() {
            return Ok(McpResolution::default());
        }
        resolve(&self.client().await?, profile, cwd).await
    }

    pub(crate) async fn verify_profile_mcps(&self, session_id: &str) -> Result<()> {
        let meta = self.metadata.read().await.get(session_id).cloned();
        let Some(meta) = meta else {
            return Ok(());
        };
        let Some(state) = meta.profile_mcps else {
            return Ok(());
        };
        let result = async {
            let mut expected = state.owned.clone();
            if !state.revision.is_empty() {
                let selection = meta.profile.as_ref().ok_or_else(|| {
                    ServiceError::CommandFailed("Missing approved MCP profile".into())
                })?;
                let profile = crate::profiles::resolve_snapshot(selection)?;
                let cwd = meta.cwd.as_deref().ok_or_else(|| {
                    ServiceError::InvalidArgument(
                        "Set a session directory before resolving MCP sources".into(),
                    )
                })?;
                let resolution = self.resolve_profile_mcps(&profile, cwd).await?;
                resolution.require_resolved()?;
                if resolution.revision != state.revision {
                    return Err(ServiceError::InvalidArgument(
                        "MCP sources changed. Preview and reapply the profile.".into(),
                    ));
                }
                expected = resolution.disabled;
            }
            verify_disabled(&self.client().await?, session_id, &expected).await
        }
        .await;
        if let Err(error) = &result {
            self.profile_configuration.lock().await.insert(
                session_id.into(),
                crate::session_profiles::ProfileConfigurationState {
                    blocked: true,
                    error: Some(format!("MCP exclusions need attention. {error}")),
                    ..Default::default()
                },
            );
        }
        result
    }
}

fn workspace_candidates(cwd: &Path) -> Result<HashMap<String, Vec<String>>> {
    use std::io::Read;
    let cwd = std::fs::canonicalize(cwd)
        .map_err(|_| ServiceError::InvalidWorkingDirectory(cwd.to_string_lossy().into()))?;
    let mut result: HashMap<String, Vec<String>> = HashMap::new();
    for directory in cwd.ancestors().take(64) {
        for file in [
            directory.join(".mcp.json"),
            directory.join(".github").join("mcp.json"),
        ] {
            let file_handle = match std::fs::File::open(&file) {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => {
                    return Err(ServiceError::InvalidArgument(format!(
                        "Cannot inspect repository MCP source {}",
                        file.display()
                    )));
                }
            };
            let mut bytes = Vec::new();
            file_handle
                .take(2 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| {
                    ServiceError::InvalidArgument("Cannot read repository MCP source".into())
                })?;
            let (servers, _) = crate::profiles::parse_mcp(&bytes, &file)?;
            for name in servers.keys() {
                result
                    .entry(name.clone())
                    .or_default()
                    .push(file.to_string_lossy().into());
            }
        }
        if directory.join(".git").exists() {
            break;
        }
    }
    Ok(result)
}
