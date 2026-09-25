use github_copilot_sdk::rpc::{ServerSkill, Skill, SkillsDiscoverRequest, SkillsDisableRequest, SkillsEnableRequest};
use serde::{Deserialize, Serialize};

use crate::{Result, ServiceError, SessionService};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileDisabledSkill {
    name: String,
    plugin: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReloadSessionSkills {
    pub session_id: String,
    pub cwd: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSkills {
    pub session_id: String,
    pub cwd: Option<String>,
    pub skills: Vec<Skill>,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSkillPreview {
    pub session_id: String,
    pub cwd: String,
    pub discovered: Vec<ServerSkill>,
    pub added: Vec<String>,
    pub changed: Vec<String>,
    pub not_discovered: Vec<String>,
    pub errors: Vec<String>,
}

pub(crate) fn skill_discovery_diff(current: &[Skill], discovered: &[ServerSkill]) -> (Vec<String>, Vec<String>, Vec<String>) {
    let mut added = Vec::new();
    let mut changed = Vec::new();
    for skill in discovered {
        match current.iter().find(|old| old.name == skill.name) {
            None => added.push(skill.name.clone()),
            Some(old) if old.path != skill.path || old.description != skill.description => changed.push(skill.name.clone()),
            _ => {}
        }
    }
    let mut not_discovered = current.iter().filter(|old| !discovered.iter().any(|skill| skill.name == old.name))
        .map(|skill| skill.name.clone()).collect::<Vec<_>>();
    added.sort();
    changed.sort();
    not_discovered.sort();
    (added, changed, not_discovered)
}

impl SessionService {
    pub(crate) async fn sync_profile_skill_exclusions(&self, session_id: &str) -> Result<()> {
        let plugins = self.metadata.read().await.get(session_id)
            .and_then(|meta| meta.profile.as_ref())
            .and_then(|profile| profile.snapshot.as_ref())
            .map(|snapshot| snapshot.profile.excluded_skill_plugins.clone()).unwrap_or_default();
        if let Err(error) = self.apply_profile_skill_exclusions(session_id, &plugins).await {
            self.profile_configuration.lock().await.insert(session_id.into(), crate::session_profiles::ProfileConfigurationState {
                blocked: true,
                error: Some(format!("Plugin-skill exclusions could not be verified. Reapply the profile before sending. {error}")),
                ..Default::default()
            });
            return Err(error);
        }
        Ok(())
    }

    pub(crate) async fn apply_profile_skill_exclusions(&self, session_id: &str, plugins: &[String]) -> Result<()> {
        let previous = self.metadata.read().await.get(session_id)
            .map(|meta| meta.profile_disabled_skills.clone()).unwrap_or_default();
        if plugins.is_empty() && previous.is_empty() { return Ok(()); }
        let session = self.attached_session(session_id).await?;
        let current = session.rpc().skills().list().await?.skills;
        let mut owned = previous.clone();
        let mut restore = Vec::new();
        let mut disable = Vec::new();
        for skill in &current {
            let plugin = skill.plugin_name.as_deref();
            let matched = plugin.is_some_and(|name| plugins.iter().any(|excluded| excluded == name));
            let prior = previous.iter().find(|entry| entry.name == skill.name && Some(entry.plugin.as_str()) == plugin);
            if matched && skill.enabled {
                let entry = ProfileDisabledSkill { name: skill.name.clone(), plugin: plugin.unwrap().into() };
                if !owned.contains(&entry) { owned.push(entry); }
                disable.push(skill.name.clone());
            } else if !matched && prior.is_some() {
                restore.push(skill.name.clone());
            }
        }
        // Retain ownership before changing native flags so partial failures can
        // restore only skills we disabled, not pre-existing user exclusions.
        {
            let mut metadata = self.metadata.write().await;
            let meta = metadata.get_mut(session_id).ok_or_else(|| ServiceError::SessionNotActive(session_id.into()))?;
            meta.profile_disabled_skills = owned.clone();
        }
        if let Err(error) = self.persist_metadata().await {
            if let Some(meta) = self.metadata.write().await.get_mut(session_id) {
                meta.profile_disabled_skills = previous;
            }
            return Err(error);
        }
        for name in &restore {
            session.rpc().skills().enable(SkillsEnableRequest { name: name.clone() }).await?;
        }
        for name in &disable {
            session.rpc().skills().disable(SkillsDisableRequest { name: name.clone() }).await?;
        }
        let effective = session.rpc().skills().list().await?.skills;
        if effective.iter().any(|skill| skill.enabled &&
            skill.plugin_name.as_ref().is_some_and(|plugin| plugins.contains(plugin)))
            || restore.iter().any(|name| !effective.iter().any(|skill| &skill.name == name && skill.enabled))
        {
            return Err(ServiceError::CommandFailed("The runtime did not apply the profile's plugin-skill exclusions.".into()));
        }
        owned.retain(|entry| !restore.contains(&entry.name));
        self.metadata.write().await.get_mut(session_id)
            .ok_or_else(|| ServiceError::SessionNotActive(session_id.into()))?.profile_disabled_skills = owned;
        self.persist_metadata().await?;
        Ok(())
    }

    pub async fn session_skills(&self, session_id: &str) -> Result<SessionSkills> {
        let _lifecycle = self.lifecycle_gate.read().await;
        let gate = self.turn_gate(session_id).await;
        let _turn = gate.lock().await;
        self.read_session_skills(session_id).await
    }

    async fn read_session_skills(&self, session_id: &str) -> Result<SessionSkills> {
        let session = self.attached_session(session_id).await?;
        let skills = session.rpc().skills().list().await?;
        Ok(SessionSkills {
            session_id: session_id.into(),
            cwd: self.cwd_for(session_id).await,
            skills: skills.skills,
            warnings: vec![],
            errors: vec![],
        })
    }

    pub async fn preview_session_skills(&self, request: ReloadSessionSkills) -> Result<SessionSkillPreview> {
        let _lifecycle = self.lifecycle_gate.read().await;
        let gate = self.turn_gate(&request.session_id).await;
        let _turn = gate.lock().await;
        let current = self.read_session_skills(&request.session_id).await?;
        if current.cwd.as_deref() != Some(request.cwd.as_str()) {
            return Err(ServiceError::InvalidArgument("The working directory changed. Refresh the skill list.".into()));
        }
        crate::validate_cwd(&request.cwd)?;
        let found = self.client().await?.rpc().skills().discover(SkillsDiscoverRequest {
            exclude_host_skills: Some(false),
            project_paths: Some(vec![request.cwd.clone()]),
            skill_directories: None,
        }).await?;
        let (added, changed, not_discovered) = skill_discovery_diff(&current.skills, &found.skills);
        Ok(SessionSkillPreview {
            session_id: request.session_id, cwd: request.cwd, discovered: found.skills,
            added, changed, not_discovered, errors: found.errors.unwrap_or_default(),
        })
    }

    pub async fn reload_session_skills(&self, request: ReloadSessionSkills) -> Result<SessionSkills> {
        let _lifecycle = self.lifecycle_gate.read().await;
        self.require_accepting_work()?;
        let gate = self.turn_gate(&request.session_id).await;
        let _turn = gate.try_lock().map_err(|_| ServiceError::SessionProcessing(request.session_id.clone()))?;
        self.require_profile_ready(&request.session_id).await?;
        let session = self.session(&request.session_id).await?;
        let cwd = self.cwd_for(&request.session_id).await.ok_or_else(|| {
            ServiceError::InvalidArgument("This session has no working directory".into())
        })?;
        if cwd != request.cwd {
            return Err(ServiceError::InvalidArgument(
                "The session working directory changed. Refresh the skills panel before loading.".into(),
            ));
        }
        crate::validate_cwd(&cwd)?;
        self.require_configuration_idle(&session).await?;
        crate::session_configuration::SessionConfiguration
            .apply_discovery(&self.client().await?, &request.session_id, &cwd).await?;
        let diagnostics = session.rpc().skills().reload().await?;
        self.sync_profile_skill_exclusions(&request.session_id).await?;
        self.verify_profile_mcps(&request.session_id).await?;
        let mut result = self.read_session_skills(&request.session_id).await.map_err(|error| {
            ServiceError::CommandFailed(format!("Skill reload returned, but its resulting skill list could not be read: {error}. Refresh the skill list before retrying."))
        })?;
        result.warnings = diagnostics.warnings;
        result.errors = diagnostics.errors;
        Ok(result)
    }
}
