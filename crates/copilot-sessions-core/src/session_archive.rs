use serde::Deserialize;

use crate::{AppEvent, Result, ServiceError, SessionService, SessionSummary};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetSessionArchived {
    pub session_id: String,
    pub archived: bool,
}

impl SessionService {
    pub async fn set_session_archived(
        &self,
        request: SetSessionArchived,
    ) -> Result<SessionSummary> {
        let session_id = &request.session_id;
        if session_id.is_empty()
            || session_id.trim() != session_id
            || session_id.chars().any(char::is_control)
        {
            return Err(ServiceError::InvalidArgument(
                "sessionId must be nonempty with no surrounding whitespace or control characters"
                    .into(),
            ));
        }

        let _write_guard = self.metadata_write_gate.lock().await;
        let active = self.active.read().await;
        let mut metadata = self.metadata.write().await;
        let mut cache = self.session_cache.write().await;
        let cached = cache.iter_mut().find(|item| item.session_id == *session_id);
        let mut summary = if let Some(summary) = cached.as_deref() {
            summary.clone()
        } else if let Some(meta) = metadata.get(session_id) {
            SessionSummary {
                session_id: session_id.clone(),
                title: meta.title.clone().unwrap_or_else(|| "Session".into()),
                start_time: String::new(),
                modified_time: String::new(),
                cwd: meta.cwd.clone(),
                model: meta.model.clone(),
                is_active: active.contains_key(session_id),
                is_remote: false,
                pinned: meta.pinned,
                archived: meta.archived,
                folder: meta.folder.clone(),
                tags: meta.tags.clone(),
                initialization: None,
            }
        } else {
            return Err(ServiceError::InvalidArgument(format!(
                "unknown session {session_id}"
            )));
        };

        let mut candidate = metadata.clone();
        candidate.entry(session_id.clone()).or_default().archived = request.archived;
        // No await after persistence: callers cannot cancel between the durable
        // write, cache commit and ordered event publication. Never touch runtime.
        self.write_metadata(&candidate)?;
        *metadata = candidate;
        summary.archived = request.archived;
        if let Some(cached) = cached {
            cached.archived = request.archived;
        } else {
            cache.push(summary.clone());
        }
        self.events.emit(AppEvent::SessionArchiveChanged {
            session_id: request.session_id,
            archived: request.archived,
        });
        Ok(summary)
    }
}
