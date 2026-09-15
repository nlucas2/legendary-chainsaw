//! Native notification prompts and SDK callbacks share one ownership lock. A
//! callback has no native ID, so only an unambiguous, one-to-one match may own it.
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use github_copilot_sdk::Client;
use serde_json::{Value, json};
use tokio::time::Instant;

use crate::interactions::{InteractionBroker, Pending, validate_response};
use crate::{
    AppEvent, InteractionKind, InteractionResponse, PendingInteraction, Result, ServiceError,
};

const RECOVERY_PAGE_SIZE: usize = 256;
const RECOVERY_MAX_PAGES: usize = 4;
const RECOVERY_INTERVAL: Duration = Duration::from_secs(5);
const RECOVERY_TYPES: &[&str] = &["user_input.requested", "user_input.completed", "abort"];
// Tool results can be very large. Use them when already present in the live
// relay, but never reread them to backfill ephemeral user-input notifications.
const OBSERVED_TYPES: &[&str] = &[
    "user_input.requested",
    "user_input.completed",
    "tool.execution_complete",
    "abort",
];

#[derive(Clone)]
struct NativePrompt {
    interaction: PendingInteraction,
    callback: Option<String>,
    in_flight: bool,
    agent_id: Option<String>,
}

#[derive(Clone, Default)]
struct NativeSession {
    requests: HashMap<String, NativePrompt>,
    closed: HashSet<String>,
    generation: u64,
    cursor: Option<String>,
    refreshed: Option<Instant>,
}

struct RecoveryScan {
    generation: u64,
    cursor: Option<String>,
    staged: NativeSession,
}

#[derive(Default)]
pub(crate) struct NativeUserInput {
    sessions: HashMap<String, NativeSession>,
    scans: HashMap<String, RecoveryScan>,
}

fn equivalent(a: &PendingInteraction, b: &PendingInteraction) -> bool {
    a.session_id == b.session_id
        && a.kind == InteractionKind::UserInput
        && b.kind == InteractionKind::UserInput
        && a.data.get("question").and_then(Value::as_str)
            == b.data.get("question").and_then(Value::as_str)
        && a.data.get("choices").filter(|v| !v.is_null())
            == b.data.get("choices").filter(|v| !v.is_null())
        && a.data
            .get("allowFreeform")
            .and_then(Value::as_bool)
            .unwrap_or(true)
            == b.data
                .get("allowFreeform")
                .and_then(Value::as_bool)
                .unwrap_or(true)
}

impl NativeSession {
    fn close(&mut self, id: &str, callbacks: &mut HashMap<String, Pending>) {
        if let Some(prompt) = self.requests.remove(id)
            && let Some(callback) = prompt.callback
        {
            callbacks.remove(&callback);
        }
        self.closed.insert(id.to_owned());
    }

    fn observe(&mut self, sid: &str, event: &Value, callbacks: &mut HashMap<String, Pending>) {
        let kind = event["type"].as_str().unwrap_or_default();
        if !OBSERVED_TYPES.contains(&kind) {
            return;
        }
        let data = &event["data"];
        match kind {
            "user_input.requested" => {
                // Never derive request IDs from tools, event IDs, or arguments.
                let Some(id) = data["requestId"].as_str().filter(|id| !id.is_empty()) else {
                    return;
                };
                if self.closed.contains(id)
                    || self.requests.contains_key(id)
                    || !data["question"].is_string()
                    || data
                        .get("allowFreeform")
                        .is_some_and(|v| !v.is_null() && !v.is_boolean())
                    || data.get("choices").is_some_and(|v| {
                        !v.is_null()
                            && !v.as_array().is_some_and(|a| a.iter().all(Value::is_string))
                    })
                {
                    return;
                }
                self.requests.insert(
                    id.to_owned(),
                    NativePrompt {
                        interaction: PendingInteraction {
                            session_id: sid.to_owned(),
                            request_id: id.to_owned(),
                            kind: InteractionKind::UserInput,
                            data: data.clone(),
                        },
                        callback: None,
                        in_flight: false,
                        agent_id: event["agentId"].as_str().map(str::to_owned),
                    },
                );
                self.generation = self.generation.wrapping_add(1);
            }
            "user_input.completed" => {
                if let Some(id) = data["requestId"].as_str()
                    && (!self.closed.contains(id) || self.requests.contains_key(id))
                {
                    self.close(id, callbacks);
                    self.generation = self.generation.wrapping_add(1);
                }
            }
            "tool.execution_complete" | "abort" => {
                let ids: Vec<_> = self
                    .requests
                    .iter()
                    .filter(|(_, prompt)| {
                        if kind == "abort" {
                            event["agentId"]
                                .as_str()
                                .is_none_or(|agent| prompt.agent_id.as_deref() == Some(agent))
                        } else {
                            data["toolCallId"].as_str().is_some_and(|tool| {
                                prompt.interaction.data["toolCallId"].as_str() == Some(tool)
                            })
                        }
                    })
                    .map(|(id, _)| id.clone())
                    .collect();
                // Even with no visible prompts, abort invalidates a recovery
                // scan that may still be discovering pre-abort requests.
                if !ids.is_empty() || kind == "abort" {
                    self.generation = self.generation.wrapping_add(1);
                }
                for id in ids {
                    self.close(&id, callbacks);
                }
            }
            _ => {}
        }
    }
}

impl NativeUserInput {
    pub(crate) fn list(
        &self,
        callbacks: &HashMap<String, Pending>,
        sid: Option<&str>,
    ) -> Vec<PendingInteraction> {
        let mut hidden = HashSet::new();
        let mut items = Vec::new();
        for (session_id, session) in &self.sessions {
            if sid.is_some_and(|sid| sid != session_id) {
                continue;
            }
            for prompt in session.requests.values() {
                if let Some(callback) = &prompt.callback {
                    hidden.insert(callback);
                }
                items.push(prompt.interaction.clone());
            }
        }
        items.extend(
            callbacks
                .iter()
                .filter(|(id, pending)| {
                    !hidden.contains(id)
                        && sid.is_none_or(|sid| pending.interaction.session_id == sid)
                })
                .map(|(_, pending)| pending.interaction.clone()),
        );
        items.sort_by(|a, b| (&a.session_id, &a.request_id).cmp(&(&b.session_id, &b.request_id)));
        items
    }

    fn reconcile(&mut self, callbacks: &HashMap<String, Pending>) {
        for session in self.sessions.values_mut() {
            let mut matches = Vec::new();
            for (id, prompt) in &session.requests {
                if prompt.callback.is_some() {
                    continue;
                }
                let candidates: Vec<_> = callbacks
                    .iter()
                    .filter(|(_, entry)| equivalent(&prompt.interaction, &entry.interaction))
                    .map(|(id, _)| id)
                    .collect();
                if candidates.len() != 1 {
                    continue;
                }
                let callback = candidates[0];
                let reverse_matches = session
                    .requests
                    .values()
                    .filter(|p| equivalent(&p.interaction, &callbacks[callback].interaction))
                    .count();
                if reverse_matches == 1 {
                    matches.push((id.clone(), callback.clone()));
                }
            }
            for (id, callback) in matches {
                session.requests.get_mut(&id).unwrap().callback = Some(callback);
                session.generation = session.generation.wrapping_add(1);
            }
        }
    }

    pub(crate) fn close_callback(&mut self, callback: &str) {
        for session in self.sessions.values_mut() {
            let ids: Vec<_> = session
                .requests
                .iter()
                .filter(|(_, p)| p.callback.as_deref() == Some(callback))
                .map(|(id, _)| id.clone())
                .collect();
            for id in ids {
                session.requests.remove(&id);
                session.closed.insert(id);
                session.generation = session.generation.wrapping_add(1);
            }
        }
    }

    pub(crate) fn callback_changed(&mut self, interaction: &PendingInteraction) {
        if interaction.kind == InteractionKind::UserInput {
            let session = self
                .sessions
                .entry(interaction.session_id.clone())
                .or_default();
            session.generation = session.generation.wrapping_add(1);
        }
    }

    pub(crate) fn clear_session(&mut self, sid: &str) {
        let session = self.sessions.entry(sid.to_owned()).or_default();
        session
            .closed
            .extend(session.requests.drain().map(|(id, _)| id));
        session.generation = session.generation.wrapping_add(1);
        session.refreshed = None;
        self.scans.remove(sid);
    }

    pub(crate) fn invalidate_recovery(&mut self, sid: &str) {
        let session = self.sessions.entry(sid.to_owned()).or_default();
        session.generation = session.generation.wrapping_add(1);
        session.refreshed = None;
        self.scans.remove(sid);
    }

    pub(crate) fn clear(&mut self) {
        for sid in self.sessions.keys().cloned().collect::<Vec<_>>() {
            self.clear_session(&sid);
        }
    }
}

impl InteractionBroker {
    // Every operation takes these locks in the same order, including callback
    // insertion, cancellation, native dispatch claims, and live completions.
    pub(crate) fn with_pending<T>(
        &self,
        change: impl FnOnce(&mut HashMap<String, Pending>, &mut NativeUserInput) -> T,
    ) -> T {
        let mut callbacks = self.pending.lock().expect("interaction map poisoned");
        let mut native = self.native.lock().expect("native interaction map poisoned");
        let before = native.list(&callbacks, None);
        let result = change(&mut callbacks, &mut native);
        native.reconcile(&callbacks);
        let after = native.list(&callbacks, None);
        let same_id = |a: &PendingInteraction, b: &PendingInteraction| {
            a.session_id == b.session_id && a.request_id == b.request_id
        };
        for interaction in &before {
            if !after.iter().any(|p| same_id(interaction, p)) {
                self.events.emit(AppEvent::InteractionResolved {
                    session_id: interaction.session_id.clone(),
                    request_id: interaction.request_id.clone(),
                });
            }
        }
        for interaction in after {
            if !before.iter().any(|p| same_id(&interaction, p)) {
                self.events
                    .emit(AppEvent::InteractionRequested { interaction });
            }
        }
        result
    }

    pub(crate) fn observe_native_event(&self, sid: &str, event: &Value) {
        if !event["type"]
            .as_str()
            .is_some_and(|kind| OBSERVED_TYPES.contains(&kind))
        {
            return;
        }
        self.with_pending(|callbacks, native| {
            native
                .sessions
                .entry(sid.to_owned())
                .or_default()
                .observe(sid, event, callbacks);
        });
    }

    /// Returns Some only for a claimed, notification-only native request.
    pub(crate) fn prepare_response(
        &self,
        response: InteractionResponse,
        allow_native: bool,
    ) -> Result<Option<PendingInteraction>> {
        let stale = || ServiceError::InteractionNotPending(response.request_id.clone());
        let interaction = self
            .with_pending(|callbacks, native| {
                native
                    .sessions
                    .get(&response.session_id)
                    .and_then(|s| s.requests.get(&response.request_id))
                    .map(|p| p.interaction.clone())
                    .or_else(|| {
                        callbacks
                            .get(&response.request_id)
                            .map(|p| p.interaction.clone())
                    })
            })
            .filter(|p| p.session_id == response.session_id && p.kind == response.kind)
            .ok_or_else(stale)?;
        // Schema compilation can be expensive; validate before claiming a sender.
        validate_response(&interaction, &response.response)?;
        self.with_pending(|callbacks, native| {
            let native_prompt = native
                .sessions
                .get(&response.session_id)
                .and_then(|s| s.requests.get(&response.request_id))
                .cloned();
            let callback = if let Some(prompt) = native_prompt {
                if prompt.in_flight {
                    return Err(stale());
                }
                if let Some(callback) = prompt.callback {
                    let equivalent_callbacks = callbacks
                        .values()
                        .filter(|p| equivalent(&interaction, &p.interaction))
                        .count();
                    let equivalent_native = native.sessions[&response.session_id]
                        .requests
                        .values()
                        .filter(|p| equivalent(&interaction, &p.interaction))
                        .count();
                    if equivalent_callbacks != 1 || equivalent_native != 1 {
                        return Err(ServiceError::InvalidArgument(
                            "ambiguous user-input callback ownership; no response was sent".into(),
                        ));
                    }
                    Some(callback)
                } else {
                    if callbacks
                        .values()
                        .any(|p| equivalent(&interaction, &p.interaction))
                    {
                        return Err(ServiceError::InvalidArgument(
                            "ambiguous user-input callback ownership; no response was sent".into(),
                        ));
                    }
                    if !allow_native {
                        return Err(ServiceError::InvalidArgument(
                            "native user input requires asynchronous delivery".into(),
                        ));
                    }
                    if response.response.get("noResponse").is_some() {
                        return Err(ServiceError::InvalidArgument(
                            "native user input does not support noResponse".into(),
                        ));
                    }
                    let session = native.sessions.get_mut(&response.session_id).unwrap();
                    session
                        .requests
                        .get_mut(&response.request_id)
                        .unwrap()
                        .in_flight = true;
                    session.generation = session.generation.wrapping_add(1);
                    return Ok(Some(interaction));
                }
            } else {
                if native
                    .sessions
                    .get(&response.session_id)
                    .is_some_and(|s| s.closed.contains(&response.request_id))
                {
                    return Err(stale());
                }
                let Some(entry) = callbacks.get(&response.request_id).filter(|p| {
                    p.interaction.session_id == response.session_id
                        && p.interaction.kind == response.kind
                }) else {
                    return Err(stale());
                };
                let matches: Vec<_> = native
                    .sessions
                    .get(&response.session_id)
                    .into_iter()
                    .flat_map(|s| s.requests.values())
                    .filter(|p| equivalent(&p.interaction, &entry.interaction))
                    .collect();
                if matches.iter().any(|prompt| prompt.in_flight) {
                    return Err(stale());
                }
                if !matches.is_empty()
                    && (matches.len() != 1
                        || matches[0].callback.as_deref() != Some(&response.request_id))
                {
                    return Err(ServiceError::InvalidArgument(
                        "ambiguous user-input callback ownership; no response was sent".into(),
                    ));
                }
                Some(response.request_id.clone())
            };
            let callback = callback.unwrap();
            let entry = callbacks.remove(&callback).ok_or_else(stale)?;
            native.callback_changed(&entry.interaction);
            native.close_callback(&callback);
            if entry.sender.send(response.response).is_ok() {
                Ok(None)
            } else {
                Err(stale())
            }
        })
    }

    pub(crate) async fn respond_native(
        self: &Arc<Self>,
        response: InteractionResponse,
        client: &Client,
    ) -> Result<()> {
        let answer = response.response.clone();
        let Some(interaction) = self.prepare_response(response, true)? else {
            return Ok(());
        };
        let mut claim = NativeClaim {
            broker: self.clone(),
            interaction,
            finished: false,
        };
        // The pinned SDK generated result uses `success`; newer runtimes use
        // `handled`. Read the wire result once: retrying with another API after
        // deserialization failure could deliver the same answer twice.
        let result = client
            .call(
                "session.ui.handlePendingUserInput",
                Some(json!({
                    "sessionId": claim.interaction.session_id,
                    "requestId": claim.interaction.request_id,
                    "response": {
                        "answer": answer["answer"],
                        "wasFreeform": answer["wasFreeform"],
                    },
                })),
            )
            .await?;
        let handled = result
            .get("handled")
            .or_else(|| result.get("success"))
            .and_then(Value::as_bool)
            .ok_or_else(|| {
                ServiceError::CapabilityUnavailable(
                    "native user-input delivery returned no handled/success boolean".into(),
                )
            })?;
        claim.finished = true;
        self.with_pending(|callbacks, native| {
            if let Some(state) = native.sessions.get_mut(&claim.interaction.session_id) {
                state.close(&claim.interaction.request_id, callbacks);
                state.generation = state.generation.wrapping_add(1);
            }
        });
        if handled {
            Ok(())
        } else {
            Err(ServiceError::InteractionNotPending(
                claim.interaction.request_id.clone(),
            ))
        }
    }

    pub(crate) async fn recover_native(&self, sid: &str, client: &Client) -> Result<()> {
        let _gate = self.recovery_gate.lock().await;
        let scan = self.with_pending(|_, native| {
            let state = native.sessions.entry(sid.to_owned()).or_default();
            if state
                .refreshed
                .is_some_and(|at| at.elapsed() < RECOVERY_INTERVAL)
            {
                return None;
            }
            let scan = native
                .scans
                .remove(sid)
                .filter(|scan| scan.generation == state.generation);
            Some(scan.unwrap_or_else(|| RecoveryScan {
                generation: state.generation,
                cursor: state.cursor.clone(),
                staged: state.clone(),
            }))
        });
        let Some(mut scan) = scan else {
            return Ok(());
        };
        for _ in 0..RECOVERY_MAX_PAGES {
            // Backward eventLog reads ignore includeEphemeral. Use a filtered
            // forward cursor, retain it across reconnects, and cap each read.
            let result = tokio::time::timeout(
                Duration::from_secs(10),
                client.call(
                    "session.eventLog.read",
                    Some(json!({
                        "sessionId": sid, "cursor": scan.cursor,
                        "direction": "forward", "includeEphemeral": true,
                        "types": RECOVERY_TYPES, "agentScope": "all", "max": RECOVERY_PAGE_SIZE,
                    })),
                ),
            )
            .await;
            let result = match result {
                Ok(Ok(result)) => result,
                error => {
                    self.with_pending(|_, native| {
                        native.scans.insert(sid.to_owned(), scan);
                    });
                    return Err(match error {
                        Ok(Err(error)) => error.into(),
                        _ => ServiceError::CapabilityUnavailable(
                            "native user-input recovery timed out".into(),
                        ),
                    });
                }
            };
            let (Some(cursor), Some(events), Some(has_more)) = (
                result["cursor"].as_str(),
                result["events"].as_array(),
                result["hasMore"].as_bool(),
            ) else {
                return Err(ServiceError::CapabilityUnavailable(
                    "invalid native user-input event-log response".into(),
                ));
            };
            if has_more && scan.cursor.as_deref() == Some(cursor) {
                return Err(ServiceError::CapabilityUnavailable(
                    "native user-input recovery cursor did not advance".into(),
                ));
            }
            for event in events {
                scan.staged.observe(sid, event, &mut HashMap::new());
            }
            scan.cursor = Some(cursor.to_owned());
            if !has_more {
                self.with_pending(|callbacks, native| {
                    let state = native.sessions.entry(sid.to_owned()).or_default();
                    // A snapshot started before a live completion/answer/abort
                    // must never reintroduce that prompt or cancel newer work.
                    if state.generation != scan.generation {
                        return;
                    }
                    for id in scan.staged.closed {
                        state.close(&id, callbacks);
                    }
                    for (id, prompt) in scan.staged.requests {
                        if !state.closed.contains(&id) {
                            state.requests.entry(id).or_insert(prompt);
                        }
                    }
                    state.cursor = scan.cursor;
                    state.refreshed = Some(Instant::now());
                });
                return Ok(());
            }
        }
        self.with_pending(|_, native| {
            native.scans.insert(sid.to_owned(), scan);
        });
        Err(ServiceError::CapabilityUnavailable(
            "native user-input recovery reached its bounded page limit; retry to continue".into(),
        ))
    }
}

struct NativeClaim {
    broker: Arc<InteractionBroker>,
    interaction: PendingInteraction,
    finished: bool,
}

impl Drop for NativeClaim {
    fn drop(&mut self) {
        if !self.finished {
            self.broker.with_pending(|_, native| {
                if let Some(session) = native.sessions.get_mut(&self.interaction.session_id)
                    && let Some(prompt) = session.requests.get_mut(&self.interaction.request_id)
                {
                    prompt.in_flight = false;
                    session.generation = session.generation.wrapping_add(1);
                }
            });
        }
    }
}

#[cfg(test)]
#[path = "native_user_input_tests.rs"]
mod tests;
