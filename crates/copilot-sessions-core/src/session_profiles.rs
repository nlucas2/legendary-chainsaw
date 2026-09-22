//! Immediate, idle-only profile changes. No profile queue or message persistence.
use crate::profiles::{ProfileLibrary, ResolvedProfile};
use crate::{NewSession, Result, ServiceError, SessionService};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewSessionProfile {
    pub session_id: Option<String>,
    pub profile_id: Option<String>,
    pub cwd: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetSessionProfile {
    pub session_id: String,
    pub profile_id: Option<String>,
    pub revision: String,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct ProfileConfigurationState {
    pub applying: bool,
    pub blocked: bool,
    pub requires_reconnect: bool,
    pub error: Option<String>,
}

impl SessionService {
    pub fn profile_library(&self) -> Result<ProfileLibrary> {
        Ok(ProfileLibrary::open(self.data_dir())?)
    }

    pub(crate) fn resolve_new_profile(&self, request: &NewSession) -> Result<Option<ResolvedProfile>> {
        if request.profile_id.is_none() && request.profile_revision.is_none() {
            return Ok(None);
        }
        let revision = request.profile_revision.as_deref().ok_or_else(|| ServiceError::InvalidArgument(
            "Preview the selected profile before creating this session (profileRevision is required)".into()))?;
        Ok(Some(self.resolve_profile_preview(request.profile_id.as_deref(), &request.cwd, revision)?))
    }

    fn resolve_profile_preview(&self, profile_id: Option<&str>, cwd: &str, revision: &str) -> Result<ResolvedProfile> {
        let profile = self.profile_library()?.resolve(profile_id)?;
        if preview_revision(&profile, cwd)? != revision {
            return Err(ServiceError::InvalidArgument(
                "Profile sources or working directory changed. Preview and confirm again.".into(),
            ));
        }
        Ok(profile)
    }

    pub async fn get_session_profile(&self, session_id: &str) -> Result<Value> {
        let profile = self.metadata.read().await.get(session_id).and_then(|meta| meta.profile.clone());
        let state = self.profile_configuration.lock().await.get(session_id).cloned().unwrap_or_default();
        Ok(json!({
            "sessionId": session_id,
            "profile": profile.filter(|p| p.profile_id.is_some()).map(|p|
                json!({"id":p.profile_id,"name":p.name,"revision":p.revision})),
            "applying": state.applying, "configurationBlocked": state.blocked,
            "requiresReconnect": state.requires_reconnect, "error": state.error
        }))
    }

    pub async fn preview_session_profile(&self, request: PreviewSessionProfile) -> Result<Value> {
        crate::validate_cwd(&request.cwd)?;
        let resolved = self.profile_library()?.resolve(request.profile_id.as_deref())?;
        let mut value = serde_json::to_value(resolved.preview()).map_err(crate::runtime_api::invalid_argument)?;
        value["revision"] = json!(preview_revision(&resolved, &request.cwd)?);
        let mut current = Vec::<String>::new();
        if let Some(id) = &request.session_id {
            if self.cwd_for(id).await.as_deref() != Some(&request.cwd) {
                return Err(ServiceError::InvalidArgument("Session directory changed. Refresh the profile preview.".into()));
            }
            if let Some(selection) = self.metadata.read().await.get(id).and_then(|meta| meta.profile.clone()) {
                match crate::profiles::resolve_snapshot(&selection) {
                    Ok(previous) => current.extend(previous.mcp_servers.keys().cloned()),
                    Err(_) => value["warnings"].as_array_mut().unwrap().push(json!(
                        "The previous sources changed or are unavailable. Automatic restoration may not be possible if application fails.")),
                }
            }
        }
        value["addedServers"] = json!(resolved.mcp_servers.keys().filter(|name| !current.contains(name)).collect::<Vec<_>>());
        value["removedServers"] = json!(current.iter().filter(|name| !resolved.mcp_servers.contains_key(*name)).collect::<Vec<_>>());
        value["requiresReconnect"] = json!(false);
        Ok(value)
    }

    pub async fn set_session_profile(self: &Arc<Self>, request: SetSessionProfile) -> Result<Value> {
        let service = Arc::clone(self);
        // Closing the HTTP request must not interrupt configuration halfway through.
        tokio::spawn(async move { service.apply_session_profile(request).await }).await
            .map_err(|error| ServiceError::CommandFailed(format!("Profile application failed: {error}")))?
    }

    async fn apply_session_profile(self: &Arc<Self>, request: SetSessionProfile) -> Result<Value> {
        let _lifecycle = self.lifecycle_gate.read().await;
        self.require_accepting_work()?;
        let gate = self.turn_gate(&request.session_id).await;
        let _turn = gate.try_lock().map_err(|_| ServiceError::SessionProcessing(request.session_id.clone()))?;
        if self.profile_configuration.lock().await.get(&request.session_id).is_some_and(|state| state.requires_reconnect) {
            return Err(ServiceError::CapabilityUnavailable(
                "The previous runtime acknowledgement was lost. Reconnect the saved session before applying a profile again.".into(),
            ));
        }
        let metadata = self.metadata.read().await.get(&request.session_id).cloned()
            .ok_or_else(|| ServiceError::SessionNotActive(request.session_id.clone()))?;
        let cwd = metadata.cwd.as_deref().ok_or_else(|| ServiceError::InvalidArgument("Set a working directory before selecting a profile".into()))?;
        let profile = self.resolve_profile_preview(request.profile_id.as_deref(), cwd, &request.revision)?;
        let recovering = !self.active.read().await.contains_key(&request.session_id);
        let session = if recovering {
            self.require_initialized(&request.session_id).await?;
            self.profile_configuration.lock().await.insert(request.session_id.clone(), ProfileConfigurationState {
                blocked: true, error: Some("The saved session must finish profile verification before accepting messages.".into()),
                ..Default::default()
            });
            let config = github_copilot_sdk::ResumeSessionConfig::new(request.session_id.clone().into())
                .with_streaming(true).with_continue_pending_work(false)
                .with_permission_handler(self.approvals.clone())
                .with_user_input_handler(self.interactions.clone())
                .with_elicitation_handler(self.interactions.clone())
                .with_exit_plan_mode_handler(self.interactions.clone())
                .with_auto_mode_switch_handler(self.interactions.clone());
            let session = Arc::new(self.client().await?.resume_session(config).await?);
            self.attach(session.clone()).await?;
            session
        } else {
            self.session(&request.session_id).await?
        };
        self.require_configuration_idle(&session).await?;
        let ask_gate = self.ask_gate(&request.session_id).await;
        let _ask = ask_gate.try_lock().map_err(|_| ServiceError::SessionProcessing("/ask is still running".into()))?;
        self.require_accepting_work()?;
        let previous = match metadata.profile.as_ref() {
            Some(selection) => crate::profiles::resolve_snapshot(selection).ok(),
            None if metadata.tool_controls_created => Some(self.profile_library()?.resolve(None)?),
            None => None,
        };
        let client = self.client().await?;
        self.profile_configuration.lock().await.insert(request.session_id.clone(), ProfileConfigurationState {
            applying: true, blocked: true, ..Default::default()
        });
        let applied = tokio::time::timeout(Duration::from_secs(60), async {
            crate::session_configuration::SessionConfiguration.apply_profile(
                &client, &request.session_id, cwd, &profile, recovering.then_some(&metadata),
            ).await?;
            crate::profiles::resolve_snapshot(&profile.selection())?;
            self.metadata.write().await.get_mut(&request.session_id).unwrap().profile = Some(profile.selection());
            if let Err(error) = self.persist_metadata().await {
                self.metadata.write().await.get_mut(&request.session_id).unwrap().profile = metadata.profile.clone();
                return Err(error);
            }
            Ok::<_, ServiceError>(())
        }).await;
        let failure = match applied {
            Ok(Ok(())) => None,
            Ok(Err(error)) => {
                let uncertain = matches!(&error, ServiceError::Copilot(error) if error.is_transport_failure());
                Some((error, uncertain))
            }
            Err(_) => Some((ServiceError::CommandFailed("Runtime configuration acknowledgement timed out".into()), true)),
        };
        if let Some((cause, uncertain)) = failure {
            let restored = if !uncertain {
                if let Some(previous) = previous {
                    matches!(tokio::time::timeout(Duration::from_secs(60),
                        crate::session_configuration::SessionConfiguration.apply_profile(
                            &client, &request.session_id, cwd, &previous, None,
                        )).await, Ok(Ok(())))
                } else { false }
            } else { false };
            let message = if restored {
                format!("Profile was not applied; the previous configuration was restored. {cause}")
            } else {
                format!("Profile configuration could not be verified. {} {cause}",
                    if uncertain { "Reconnect the saved session before retrying." } else { "Preview and apply again to recover." })
            };
            self.profile_configuration.lock().await.insert(request.session_id, ProfileConfigurationState {
                applying: false, blocked: !restored, requires_reconnect: uncertain, error: Some(message.clone()),
            });
            return Err(ServiceError::CommandFailed(message));
        }
        self.profile_configuration.lock().await.remove(&request.session_id);
        self.warmed.write().await.remove(&request.session_id);
        self.tool_catalog.invalidate(&request.session_id).await;
        self.events.emit(crate::AppEvent::ToolInventoryUpdated { session_id: request.session_id.clone() });
        self.get_session_profile(&request.session_id).await
    }

    pub(crate) async fn require_profile_ready(&self, session_id: &str) -> Result<()> {
        if self.profile_configuration.lock().await.get(session_id).is_some_and(|state| state.blocked) {
            return Err(ServiceError::SessionNotReady { session_id: session_id.into(),
                reason: "Profile configuration is being applied or needs recovery. Your message was not sent; try again after configuration is ready.".into() });
        }
        Ok(())
    }
}

fn preview_revision(profile: &ResolvedProfile, cwd: &str) -> Result<String> {
    let cwd = std::fs::canonicalize(cwd).map_err(|_| ServiceError::InvalidWorkingDirectory(cwd.into()))?;
    Ok(format!("{}:{:x}", profile.revision, Sha256::digest(cwd.to_string_lossy().as_bytes())))
}
