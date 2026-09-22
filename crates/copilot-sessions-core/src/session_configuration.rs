//! Runtime-specific application of the app's resolved session configuration.
//! Creation, reattachment, and explicit discovery refresh share this policy.
use github_copilot_sdk::{Client, ResumeSessionConfig, SessionConfig};
use serde_json::json;

use crate::profiles::ResolvedProfile;
use crate::{AppEvent, Result, ServiceError, SessionService};

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct SessionConfiguration;

impl SessionConfiguration {
    pub fn configure_new_profile(
        self,
        config: SessionConfig,
        profile: Option<&ResolvedProfile>,
    ) -> SessionConfig {
        let mut config = self.configure_new(config);
        if let Some(profile) = profile {
            config = config
                .with_mcp_servers(profile.mcp_servers.clone())
                .with_skill_directories(profile.skill_directories.clone());
        }
        config
    }

    pub fn configure_resume_profile(
        self,
        config: ResumeSessionConfig,
        profile: Option<&ResolvedProfile>,
    ) -> ResumeSessionConfig {
        let mut config = self.configure_resume(config);
        if let Some(profile) = profile {
            config = config
                .with_mcp_servers(profile.mcp_servers.clone())
                .with_skill_directories(profile.skill_directories.clone());
        }
        config
    }

    pub async fn apply_profile(
        self,
        client: &Client,
        session_id: &str,
        cwd: &str,
        profile: &ResolvedProfile,
        recovery_metadata: Option<&crate::StoredSessionMeta>,
    ) -> Result<()> {
        // A resident resume updates the source configuration without registering
        // another SDK handle. MCP clients only change after the scoped reload.
        let mut parameters = json!({
            "sessionId": session_id, "workingDirectory": cwd,
            "enableConfigDiscovery": true, "continuePendingWork": false,
            "mcpServers": profile.mcp_servers, "skillDirectories": profile.skill_directories,
            "requestPermission": true, "requestUserInput": true, "requestElicitation": true,
            "requestExitPlanMode": true, "requestAutoModeSwitch": true
        });
        // Restore app-owned choices only for an observation-only cold reattach,
        // at the verified-idle source application boundary, not during draining.
        if let Some(metadata) = recovery_metadata
            .filter(|meta| meta.tool_controls_managed && meta.tool_controls_created)
        {
            parameters["excludedTools"] = json!(metadata.tool_exclusions);
            if let Some(available) = &metadata.tool_available_tools {
                parameters["availableTools"] = json!(available);
            }
        }
        let result = client.call("session.resume", Some(parameters)).await?;
        if result.get("sessionId").and_then(serde_json::Value::as_str) != Some(session_id) {
            return Err(ServiceError::CommandFailed(
                "Profile application returned a different session identity".into(),
            ));
        }
        client
            .call("session.mcp.reload", Some(json!({"sessionId": session_id})))
            .await?;
        let skills = client
            .call(
                "session.skills.reload",
                Some(json!({"sessionId": session_id})),
            )
            .await?;
        if skills
            .get("errors")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|errors| !errors.is_empty())
        {
            return Err(ServiceError::CommandFailed(
                "The runtime reported skill source errors; profile was not verified".into(),
            ));
        }
        let mcp = client
            .call("session.mcp.list", Some(json!({"sessionId": session_id})))
            .await?;
        let servers = mcp
            .get("servers")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| {
                ServiceError::CommandFailed(
                    "The runtime did not return a verifiable MCP inventory".into(),
                )
            })?;
        if profile.mcp_servers.keys().any(|name| {
            !servers.iter().any(|server| {
                server.get("name").and_then(serde_json::Value::as_str) == Some(name.as_str())
            })
        }) {
            return Err(ServiceError::CommandFailed(
                "The runtime did not load all selected profile MCP servers".into(),
            ));
        }
        Ok(())
    }
    pub fn configure_new(self, config: SessionConfig) -> SessionConfig {
        config.with_enable_config_discovery(true)
    }

    pub fn configure_resume(self, config: ResumeSessionConfig) -> ResumeSessionConfig {
        config.with_enable_config_discovery(true)
    }

    pub async fn apply_discovery(self, client: &Client, session_id: &str, cwd: &str) -> Result<()> {
        // Discovery is a resume-time option, not a mutable options.update field.
        // A resident resume preserves this session's filters and handlers; do not
        // replace SDK subscriptions or restart the shared runtime.
        let result = client
            .call(
                "session.resume",
                Some(json!({
                    "sessionId": session_id,
                    "workingDirectory": cwd,
                    "enableConfigDiscovery": true,
                    "continuePendingWork": false,
                    "requestPermission": true,
                    "requestUserInput": true,
                    "requestElicitation": true,
                    "requestExitPlanMode": true,
                    "requestAutoModeSwitch": true
                })),
            )
            .await?;
        if result.get("sessionId").and_then(serde_json::Value::as_str) != Some(session_id) {
            return Err(ServiceError::CommandFailed(
                "Configuration application returned a different session identity; refresh before retrying.".into(),
            ));
        }
        Ok(())
    }
}

impl SessionService {
    // Caller holds the lifecycle and per-session turn gates through application.
    pub(crate) async fn require_configuration_idle(
        &self,
        session: &github_copilot_sdk::session::Session,
    ) -> Result<()> {
        let id = session.id().as_str();
        if self.session_processing(id).await?
            || self
                .last_submissions
                .read()
                .await
                .get(id)
                .is_some_and(|at| at.elapsed() < std::time::Duration::from_secs(2))
        {
            return Err(ServiceError::SessionProcessing(id.into()));
        }
        if self
            .ask_gates
            .read()
            .await
            .get(id)
            .is_some_and(|gate| gate.try_lock().is_err())
        {
            return Err(ServiceError::SessionProcessing(
                "Configuration change is waiting for /ask to finish".into(),
            ));
        }
        let queue = session.rpc().queue().pending_items().await?;
        if !queue.items.is_empty()
            || !queue.steering_messages.is_empty()
            || queue.in_flight_steering_count.unwrap_or(0) > 0
            || !self.pending_interactions_async(id).await?.is_empty()
            || self.pending_permissions().iter().any(|event| {
                matches!(event,
                AppEvent::PermissionRequested { session_id, .. } if session_id == id)
            })
        {
            return Err(ServiceError::SessionProcessing(
                "Configuration reload is waiting for queued work or pending input to finish".into(),
            ));
        }
        let tasks = session.rpc().tasks().list().await?;
        if tasks.tasks.iter().any(|task| {
            !matches!(
                task.get("status").and_then(serde_json::Value::as_str),
                Some("idle" | "completed" | "failed" | "cancelled")
            )
        }) {
            return Err(ServiceError::SessionProcessing(
                "Configuration reload is waiting for background tasks to finish".into(),
            ));
        }
        // A callback can resume work while the native safety RPCs are in flight.
        if self
            .last_submissions
            .read()
            .await
            .get(id)
            .is_some_and(|at| at.elapsed() < std::time::Duration::from_secs(2))
        {
            return Err(ServiceError::SessionProcessing(
                "Configuration change is waiting for recently resumed work".into(),
            ));
        }
        self.require_accepting_work()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_policy_is_shared_without_replacing_explicit_session_selections() {
        let create = SessionConfiguration.configure_new(
            SessionConfig::default()
                .with_disabled_skills(["disabled"])
                .with_available_tools(["builtin:view"]),
        );
        assert_eq!(create.enable_config_discovery, Some(true));
        assert_eq!(create.disabled_skills, Some(vec!["disabled".into()]));
        assert_eq!(create.available_tools, Some(vec!["builtin:view".into()]));
        let resume = SessionConfiguration.configure_resume(
            ResumeSessionConfig::new("same-session".into())
                .with_disabled_skills(["disabled"])
                .with_continue_pending_work(false),
        );
        assert_eq!(resume.enable_config_discovery, Some(true));
        assert_eq!(resume.disabled_skills, Some(vec!["disabled".into()]));
        assert_eq!(resume.continue_pending_work, Some(false));
    }
}
