use std::collections::{BTreeMap, HashMap, HashSet};

use github_copilot_sdk::rpc::{
    CurrentToolMetadata, OptionsUpdateToolFilterPrecedence, SessionUpdateOptionsParams,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{Result, ServiceError, SessionService};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolSource {
    Builtin,
    Mcp,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlledTool {
    pub id: String,
    pub name: String,
    /// Model-facing name from current SDK metadata, absent for inventory-only rows.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_name: Option<String>,
    pub description: String,
    pub source: ToolSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_name: Option<String>,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deferred: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlledServer {
    pub name: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolControls {
    pub tools: Vec<ControlledTool>,
    pub servers: Vec<ControlledServer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available_tools: Option<Vec<String>>,
    pub excluded_tools: Vec<String>,
    pub filter_ownership: &'static str,
    pub can_edit_tools: bool,
    pub requires_adoption: bool,
    /// Complete external/runtime filter state is not readable in the pinned SDK.
    pub filter_state_known: bool,
    pub inventory_loading: bool,
    pub metadata_available: bool,
    pub metadata_loading: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetToolEnabled {
    pub session_id: String,
    pub tool_id: String,
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetMcpEnabled {
    pub session_id: String,
    pub server_name: String,
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdoptToolControls {
    pub session_id: String,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct SessionToolState {
    inventory: BTreeMap<String, ControlledTool>,
    adopted_for_attachment: bool,
}

impl SessionService {
    pub async fn tool_controls(&self, session_id: &str) -> Result<ToolControls> {
        let session = self.session(session_id).await?;
        let client = self.client().await?;
        let params = Some(json!({"sessionId":session_id}));
        let (current, catalog, servers) = tokio::join!(
            client.call("session.tools.getCurrentMetadata", params.clone()),
            client.call("tools.list", Some(json!({}))),
            client.call("session.mcp.list", params),
        );
        let current =
            current.map_err(|error| capability("session.tools.getCurrentMetadata", error))?;
        let current: Option<Vec<CurrentToolMetadata>> =
            serde_json::from_value(current.get("tools").cloned().unwrap_or(Value::Null))
                .map_err(crate::runtime_api::invalid_argument)?;
        let metadata_available = current.is_some();
        let (metadata_loading, initialization_error) = if metadata_available {
            (false, None)
        } else {
            self.tool_catalog
                .initialize_metadata(session.clone(), self.events.clone())
                .await
        };
        let catalog = catalog.map_err(|error| capability("tools.list", error))?;
        let catalog: Vec<github_copilot_sdk::rpc::Tool> =
            serde_json::from_value(catalog.get("tools").cloned().unwrap_or(json!([])))
                .map_err(crate::runtime_api::invalid_argument)?;
        let servers = servers.map_err(|error| capability("session.mcp.list", error))?;
        let servers: Vec<ControlledServer> =
            serde_json::from_value(servers.get("servers").cloned().unwrap_or(json!([])))
                .map_err(crate::runtime_api::invalid_argument)?;
        let inventory = self
            .tool_catalog
            .snapshot(session, client, &servers, self.events.clone())
            .await;
        let mut warnings = inventory.warnings;
        if let Some(error) = initialization_error {
            warnings.push(error);
        }
        let metadata = self
            .metadata
            .read()
            .await
            .get(session_id)
            .cloned()
            .unwrap_or_default();
        let mut states = self.tool_state.write().await;
        let state = states.entry(session_id.into()).or_default();
        let created = metadata.tool_controls_managed && metadata.tool_controls_created;
        let managed = created || state.adopted_for_attachment;
        let excluded_tools = if managed {
            metadata.tool_exclusions
        } else {
            Vec::new()
        };
        let mut controls = build_controls(
            state,
            current.unwrap_or_default(),
            catalog,
            servers,
            inventory.catalogs,
            excluded_tools,
        );
        controls.can_edit_tools = managed && metadata_available;
        controls.inventory_loading = inventory.loading;
        controls.metadata_available = metadata_available;
        controls.metadata_loading = metadata_loading;
        controls.requires_adoption = !managed;
        controls.filter_ownership = if managed { "app" } else { "unknown" };
        controls.available_tools = if managed {
            metadata.tool_available_tools
        } else {
            None
        };
        if managed {
            warnings.push("Selection settings shown here are owned and persisted by this app, not read back from the runtime. External policy remains unreadable; allowing a tool may not make it available.".into());
            if !created {
                warnings.push("Existing-session adoption applies only to this attachment. Saved selection settings are not automatically replayed on reattach; fresh consent will be required.".into());
            }
        } else {
            warnings.push("Existing tool filters are unknown. Manage this session's tool selection explicitly replaces this session's native selection with a captured effective allowlist and empty exclusions; it does not change global configuration. Consent applies only to this attachment. While managed, future tools remain off until explicitly enabled.".into());
        }
        controls.warnings = warnings;
        Ok(controls)
    }

    pub async fn refresh_tool_inventory(&self, session_id: &str) -> Result<ToolControls> {
        self.session(session_id).await?;
        self.tool_catalog.invalidate(session_id).await;
        self.tool_controls(session_id).await
    }

    pub async fn set_tool_enabled(&self, request: SetToolEnabled) -> Result<ToolControls> {
        let _lifecycle = self.lifecycle_gate.read().await;
        self.require_accepting_work()?;
        let gate = self.turn_gate(&request.session_id).await;
        let _guard = gate.lock().await;
        self.require_accepting_work()?;
        let mut controls = self.tool_controls(&request.session_id).await?;
        if !controls.metadata_available {
            return Err(ServiceError::CapabilityUnavailable(
                "The runtime has not exposed current tool metadata; tool selection was not changed.".into(),
            ));
        }
        if !controls.can_edit_tools {
            return Err(ServiceError::CapabilityUnavailable(
                "Tool selection is not managed by this app. Explicitly adopt it with Manage this session's tool selection before changing tools; unknown filters were not modified.".into(),
            ));
        }
        if !controls.tools.iter().any(|tool| tool.id == request.tool_id) {
            return Err(ServiceError::InvalidArgument(format!(
                "unknown canonical tool id {}",
                request.tool_id
            )));
        }
        let next =
            toggle_app_exclusion(&controls.excluded_tools, &request.tool_id, request.enabled);
        let created = self
            .metadata
            .read()
            .await
            .get(&request.session_id)
            .is_some_and(|meta| meta.tool_controls_managed && meta.tool_controls_created);
        let mut available = controls.available_tools.clone();
        if !created {
            let baseline = available.as_ref().ok_or_else(|| ServiceError::CapabilityUnavailable(
                "adopted selection baseline is unavailable; reattach and explicitly adopt again".into(),
            ))?;
            let session = self.session(&request.session_id).await?;
            let current = session
                .rpc()
                .tools()
                .get_current_metadata()
                .await?
                .tools
                .ok_or_else(|| {
                    ServiceError::CapabilityUnavailable(
                        "current tool metadata is unavailable; selection was not changed".into(),
                    )
                })?;
            let mut clamped = effective_selection(&controls, &current)
                .into_iter()
                .filter(|id| baseline.contains(id) && !next.contains(id))
                .collect::<Vec<_>>();
            if request.enabled && !clamped.contains(&request.tool_id) {
                clamped.push(request.tool_id.clone());
            }
            available = Some(clamped);
        } else if request.enabled
            && let Some(allowed) = &mut available
            && !allowed.contains(&request.tool_id)
        {
            allowed.push(request.tool_id.clone());
        }
        let available_changed = available != controls.available_tools;
        let still_enabled = controls
            .tools
            .iter()
            .any(|tool| tool.id == request.tool_id && tool.enabled);
        if next != controls.excluded_tools
            || available_changed
            || (!request.enabled && still_enabled)
            || (!created && request.enabled && !still_enabled)
        {
            let session = self.session(&request.session_id).await?;
            let mut patch = if created {
                exclusion_patch(next.clone())
            } else {
                // Never replace an adopted session's native exclusions on an
                // ordinary edit. The bounded allowlist expresses our choice.
                selection_patch(available.clone().expect("adopted baseline"))
            };
            if created && available_changed {
                patch.available_tools = available.clone();
            }
            let result = session
                .rpc()
                .options()
                .update(patch)
                .await
                .map_err(|error| capability("session.options.update", error))?;
            if !result.success {
                return Err(ServiceError::CommandFailed(
                    "session.options.update did not apply the app exclusion patch".into(),
                ));
            }
            {
                let mut metadata = self.metadata.write().await;
                let meta = metadata.entry(request.session_id.clone()).or_default();
                meta.tool_exclusions = next;
                meta.tool_available_tools = available;
            }
            self.persist_metadata().await.map_err(|error| {
                ServiceError::Persistence(format!(
                    "app tool selection changed in the runtime but could not be persisted: {error}"
                ))
            })?;
            // Rebuild only after an explicit configuration change, not every open.
            session.rpc().tools().initialize_and_validate().await?;
            controls = self.tool_controls(&request.session_id).await?;
        }
        if request.enabled
            && !controls
                .tools
                .iter()
                .any(|tool| tool.id == request.tool_id && tool.enabled)
        {
            controls.warnings.push(format!(
                "{} is not offered by the runtime after removing its individual app exclusion. Other app exclusions, external filters, model policy, or server availability may still restrict it.",
                request.tool_id
            ));
        } else if !request.enabled
            && controls
                .tools
                .iter()
                .any(|tool| tool.id == request.tool_id && tool.enabled)
        {
            controls.warnings.push(format!(
                "{} has an app exclusion, but current runtime metadata still reports it enabled. Do not assume the exclusion is effective.",
                request.tool_id
            ));
        }
        Ok(controls)
    }

    pub async fn adopt_tool_controls(&self, request: AdoptToolControls) -> Result<ToolControls> {
        let _lifecycle = self.lifecycle_gate.read().await;
        self.require_accepting_work()?;
        let gate = self.turn_gate(&request.session_id).await;
        let _guard = gate.lock().await;
        self.require_accepting_work()?;
        let controls = self.tool_controls(&request.session_id).await?;
        if !controls.metadata_available {
            return Err(ServiceError::CapabilityUnavailable(
                "The runtime has not exposed current tool metadata; adoption was not applied."
                    .into(),
            ));
        }
        if controls.can_edit_tools {
            return Ok(controls);
        }
        if self.session_processing(&request.session_id).await? {
            return Err(ServiceError::SessionProcessing(request.session_id));
        }
        let session = self.session(&request.session_id).await?;
        let current = session
            .rpc()
            .tools()
            .get_current_metadata()
            .await?
            .tools
            .ok_or_else(|| {
                ServiceError::CapabilityUnavailable(
                    "current tool metadata is unavailable; adoption was not applied".into(),
                )
            })?;
        // Recheck immediately before applying: inventory discovery may have
        // taken time. Only the still-effective intersection can be adopted.
        let allowed = effective_selection(&controls, &current);
        let mut patch = exclusion_patch(Vec::new());
        patch.available_tools = Some(allowed.clone());
        let result = session
            .rpc()
            .options()
            .update(patch)
            .await
            .map_err(|error| capability("session.options.update", error))?;
        if !result.success {
            return Err(ServiceError::CommandFailed(
                "runtime did not adopt the tool selection".into(),
            ));
        }
        {
            let mut metadata = self.metadata.write().await;
            let meta = metadata.entry(request.session_id.clone()).or_default();
            meta.tool_controls_managed = true;
            meta.tool_controls_created = false;
            meta.tool_available_tools = Some(allowed);
            meta.tool_exclusions.clear();
        }
        self.tool_state
            .write()
            .await
            .entry(request.session_id.clone())
            .or_default()
            .adopted_for_attachment = true;
        self.persist_metadata().await.map_err(|error| {
            ServiceError::Persistence(format!(
                "tool selection was adopted in the runtime but could not be persisted: {error}"
            ))
        })?;
        session.rpc().tools().initialize_and_validate().await?;
        self.tool_controls(&request.session_id).await
    }

    pub async fn set_mcp_enabled(&self, request: SetMcpEnabled) -> Result<ToolControls> {
        let _lifecycle = self.lifecycle_gate.read().await;
        self.require_accepting_work()?;
        let gate = self.turn_gate(&request.session_id).await;
        let _guard = gate.lock().await;
        self.require_accepting_work()?;
        self.require_profile_ready(&request.session_id).await?;
        let session = self.session(&request.session_id).await?;
        let meta = self.metadata.read().await.get(&request.session_id).cloned().unwrap_or_default();
        if meta.profile_mcps.is_some() {
            self.require_configuration_idle(&session).await?;
            self.verify_profile_mcps(&request.session_id).await?;
            if request.enabled && let Some(selection) = &meta.profile {
                let profile = crate::profiles::resolve_snapshot(selection)?;
                let resolution = self.resolve_profile_mcps(&profile, meta.cwd.as_deref().ok_or_else(||
                    ServiceError::InvalidArgument("Set a working directory before changing MCP configuration".into()))?).await?;
                if resolution.disabled.contains(&request.server_name) {
                    return Err(ServiceError::InvalidArgument(
                        "This MCP server is excluded by the session profile. Edit or switch profiles before enabling it.".into()));
                }
            }
        }
        let client = self.client().await?;
        let servers = client
            .call(
                "session.mcp.list",
                Some(json!({"sessionId":request.session_id})),
            )
            .await?;
        if !servers
            .get("servers")
            .and_then(Value::as_array)
            .is_some_and(|servers| {
                servers.iter().any(|server| {
                    server.get("name").and_then(Value::as_str) == Some(&request.server_name)
                })
            })
        {
            return Err(ServiceError::InvalidArgument(format!(
                "unknown MCP server {}",
                request.server_name
            )));
        }
        let method = if request.enabled {
            "session.mcp.enable"
        } else {
            "session.mcp.disable"
        };
        client
            .call(
                method,
                Some(json!({"sessionId":request.session_id,"serverName":request.server_name})),
            )
            .await
            .map_err(|error| capability(method, error))?;
        if let Some(mut state) = meta.profile_mcps {
            let changed = async {
                state.disabled = crate::mcp_resolution::disabled_servers(&client, &request.session_id).await?;
                let cwd = meta.cwd.as_deref().ok_or_else(|| ServiceError::InvalidArgument("Missing session working directory".into()))?;
                crate::session_configuration::SessionConfiguration.update_discovery(
                    &client, &request.session_id, cwd, Some(&state.disabled),
                ).await?;
                self.metadata.write().await.get_mut(&request.session_id)
                    .ok_or_else(|| ServiceError::SessionNotActive(request.session_id.clone()))?.profile_mcps = Some(state);
                self.persist_metadata().await
            }.await;
            if let Err(error) = changed {
                self.profile_configuration.lock().await.insert(request.session_id.clone(), crate::session_profiles::ProfileConfigurationState {
                    blocked: true, error: Some(format!("MCP selection could not be saved. Reapply the profile. {error}")), ..Default::default()
                });
                return Err(error);
            }
        }
        // Session-scoped RPCs publish native MCP/tool changes through the
        // existing event log. No global mcp.config.* or config-file writes.
        self.session(&request.session_id)
            .await?
            .rpc()
            .tools()
            .initialize_and_validate()
            .await?;
        self.tool_controls(&request.session_id).await
    }
}

fn capability(method: &str, error: impl std::fmt::Display) -> ServiceError {
    ServiceError::CapabilityUnavailable(format!("{method}: {error}"))
}

fn build_controls(
    state: &mut SessionToolState,
    current: Vec<CurrentToolMetadata>,
    catalog: Vec<github_copilot_sdk::rpc::Tool>,
    servers: Vec<ControlledServer>,
    inventories: HashMap<String, Vec<github_copilot_sdk::rpc::McpTools>>,
    excluded_tools: Vec<String>,
) -> ToolControls {
    let builtin_names: HashSet<_> = catalog.iter().map(|tool| tool.name.clone()).collect();
    for tool in state.inventory.values_mut() {
        tool.enabled = false;
        tool.deferred = None;
        tool.runtime_name = None;
    }
    for tool in catalog {
        let id = format!("builtin:{}", tool.name);
        state.inventory.insert(
            id.clone(),
            ControlledTool {
                id,
                name: tool.name,
                runtime_name: None,
                description: tool.description,
                source: ToolSource::Builtin,
                server_name: None,
                enabled: false,
                deferred: None,
            },
        );
    }
    for (server, tools) in inventories {
        for tool in tools {
            let id = format!("mcp:{server}-{}", tool.name);
            state.inventory.insert(
                id.clone(),
                ControlledTool {
                    id,
                    name: tool.name,
                    runtime_name: None,
                    description: tool.description.unwrap_or_default(),
                    source: ToolSource::Mcp,
                    server_name: Some(server.clone()),
                    enabled: false,
                    deferred: None,
                },
            );
        }
    }
    for tool in current {
        let (source, id) = match &tool.mcp_server_name {
            Some(server) => {
                let wire_name = match &tool.mcp_tool_name {
                    Some(name) => format!("{server}-{name}"),
                    None if tool.name.starts_with(&format!("{server}-")) => tool.name.clone(),
                    None => format!("{server}-{}", tool.name),
                };
                (ToolSource::Mcp, format!("mcp:{wire_name}"))
            }
            None if builtin_names.contains(&tool.name) => {
                (ToolSource::Builtin, format!("builtin:{}", tool.name))
            }
            None => (ToolSource::Custom, format!("custom:{}", tool.name)),
        };
        state.inventory.insert(
            id.clone(),
            ControlledTool {
                id,
                name: tool.name.clone(),
                runtime_name: Some(tool.name),
                description: tool.description,
                source,
                server_name: tool.mcp_server_name,
                // Runtime-resolved membership is authoritative. App exclusions
                // and server status are separate observations, not local policy.
                enabled: true,
                deferred: tool.defer_loading,
            },
        );
    }
    // An excluded custom/MCP tool may vanish from runtime inventory after
    // restart. Keep an honest disabled row so its app exclusion can be undone.
    for id in &excluded_tools {
        if state.inventory.contains_key(id) || id.contains('*') {
            continue;
        }
        let Some((source, name)) = id.split_once(':') else {
            continue;
        };
        let source = match source {
            "builtin" => ToolSource::Builtin,
            "mcp" => ToolSource::Mcp,
            "custom" => ToolSource::Custom,
            _ => continue,
        };
        state.inventory.insert(
            id.clone(),
            ControlledTool {
                id: id.clone(),
                name: name.into(),
                runtime_name: None,
                description: "Excluded by this app; current runtime metadata is unavailable."
                    .into(),
                source,
                server_name: None,
                enabled: false,
                deferred: None,
            },
        );
    }
    ToolControls {
        tools: state.inventory.values().cloned().collect(),
        servers,
        // No availableTools getter exists. Never manufacture a runtime allowlist.
        available_tools: None,
        excluded_tools,
        filter_ownership: "app",
        can_edit_tools: true,
        requires_adoption: false,
        filter_state_known: false,
        inventory_loading: false,
        metadata_available: true,
        metadata_loading: false,
        warnings: Vec::new(),
    }
}

fn toggle_app_exclusion(existing: &[String], id: &str, enabled: bool) -> Vec<String> {
    let mut exclusions = existing.to_vec();
    if enabled {
        exclusions.retain(|pattern| pattern != id);
    } else if !exclusions.iter().any(|pattern| pattern == id) {
        exclusions.push(id.into());
    }
    exclusions
}

fn exclusion_patch(exclusions: Vec<String>) -> SessionUpdateOptionsParams {
    let mut patch = SessionUpdateOptionsParams::default();
    // Ordinary exclusion edits leave the allowlist untouched. Only explicit
    // adoption or expansion of an adopted selection sets it separately.
    patch.excluded_tools = Some(exclusions);
    patch.tool_filter_precedence = Some(OptionsUpdateToolFilterPrecedence::Excluded);
    patch
}

fn selection_patch(available: Vec<String>) -> SessionUpdateOptionsParams {
    let mut patch = SessionUpdateOptionsParams::default();
    patch.available_tools = Some(available);
    patch.tool_filter_precedence = Some(OptionsUpdateToolFilterPrecedence::Excluded);
    patch
}

fn effective_selection(controls: &ToolControls, current: &[CurrentToolMetadata]) -> Vec<String> {
    let mut allowed = controls
        .tools
        .iter()
        .filter(|tool| {
            tool.enabled
                && current.iter().any(|current| {
                    tool.runtime_name.as_deref() == Some(current.name.as_str())
                        && tool.server_name == current.mcp_server_name
                        && match (&current.mcp_server_name, &current.mcp_tool_name) {
                            (None, None) => true,
                            (Some(server), Some(name)) => tool.id == format!("mcp:{server}-{name}"),
                            _ => false,
                        }
                })
        })
        .map(|tool| tool.id.clone())
        .collect::<Vec<_>>();
    allowed.sort();
    allowed.dedup();
    allowed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toggles_change_only_individual_app_exclusions() {
        let original = vec!["builtin:secret*".into()];
        let disabled = toggle_app_exclusion(&original, "builtin:powershell", false);
        assert_eq!(disabled, ["builtin:secret*", "builtin:powershell"]);
        assert_eq!(
            toggle_app_exclusion(&disabled, "builtin:powershell", true),
            original
        );
        assert_eq!(
            toggle_app_exclusion(&original, "builtin:secret_reader", true),
            original
        );
    }

    #[test]
    fn catalog_does_not_imply_tool_is_offered() {
        let mut state = SessionToolState::default();
        let controls = build_controls(
            &mut state,
            vec![],
            vec![github_copilot_sdk::rpc::Tool {
                name: "powershell".into(),
                ..Default::default()
            }],
            vec![],
            HashMap::new(),
            vec![],
        );
        assert_eq!(controls.tools[0].id, "builtin:powershell");
        assert!(!controls.tools[0].enabled);
        assert!(!controls.filter_state_known);
        assert!(controls.can_edit_tools);
        assert_eq!(controls.filter_ownership, "app");
        assert!(controls.available_tools.is_none());
    }

    #[test]
    fn exclusion_updates_never_touch_available_tools() {
        let patch = json!(exclusion_patch(vec!["builtin:read".into()]));
        assert_eq!(
            patch,
            json!({"excludedTools":["builtin:read"],"toolFilterPrecedence":"excluded"})
        );
        assert!(patch.get("availableTools").is_none());
        let adopted_patch = json!(selection_patch(vec!["builtin:read".into()]));
        assert!(adopted_patch.get("excludedTools").is_none());
        assert_eq!(adopted_patch["availableTools"], json!(["builtin:read"]));
    }

    #[test]
    fn persisted_exclusions_can_be_undone_without_claiming_inventory() {
        let controls = build_controls(
            &mut SessionToolState::default(),
            vec![],
            vec![],
            vec![],
            HashMap::new(),
            vec!["custom:extra".into()],
        );
        assert_eq!(controls.tools[0].id, "custom:extra");
        assert!(!controls.tools[0].enabled);
        assert!(controls.tools[0].description.contains("unavailable"));
    }

    #[test]
    fn app_exclusions_are_source_qualified() {
        let exclusions = vec!["mcp:server-read".into()];
        assert_eq!(
            toggle_app_exclusion(&exclusions, "builtin:read", true),
            exclusions
        );
        assert_eq!(
            toggle_app_exclusion(&exclusions, "builtin:read", false),
            ["mcp:server-read", "builtin:read"]
        );
    }

    #[test]
    fn runtime_metadata_resolves_policy_and_preserves_deferred_unknown() {
        for deferred in [None, Some(false), Some(true)] {
            let controls = build_controls(
                &mut SessionToolState::default(),
                vec![CurrentToolMetadata {
                    name: "powershell".into(),
                    defer_loading: deferred,
                    ..Default::default()
                }],
                vec![github_copilot_sdk::rpc::Tool {
                    name: "powershell".into(),
                    ..Default::default()
                }],
                vec![],
                HashMap::new(),
                vec!["builtin:powershell".into()],
            );
            assert!(controls.tools[0].enabled);
            assert_eq!(controls.tools[0].deferred, deferred);
            assert_eq!(controls.tools[0].id, "builtin:powershell");
        }
    }

    #[test]
    fn model_facing_names_are_separate_from_mcp_filter_ids() {
        let mut state = SessionToolState::default();
        let controls = build_controls(
            &mut state,
            vec![CurrentToolMetadata {
                name: "model_alias".into(),
                mcp_server_name: Some("server-key".into()),
                mcp_tool_name: Some("read_file".into()),
                namespaced_name: Some("presentation/read".into()),
                ..Default::default()
            }],
            vec![],
            vec![],
            HashMap::new(),
            vec![],
        );
        assert_eq!(controls.tools[0].id, "mcp:server-key-read_file");
        assert_eq!(controls.tools[0].name, "model_alias");
        assert_eq!(
            controls.tools[0].runtime_name.as_deref(),
            Some("model_alias")
        );
        assert_eq!(json!(&controls.tools[0])["runtimeName"], "model_alias");
        let absent = build_controls(&mut state, vec![], vec![], vec![], HashMap::new(), vec![]);
        assert!(!absent.tools[0].enabled);
        assert!(absent.tools[0].runtime_name.is_none());
        assert!(json!(&absent.tools[0]).get("runtimeName").is_none());
    }
}
