use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{StreamExt, stream};
use github_copilot_sdk::{Client, rpc::McpTools, session::Session};
use serde_json::json;
use tokio::sync::RwLock;

use crate::{AppEvent, EventBus, tool_controls::ControlledServer};

const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(5);
const CATALOG_TTL: Duration = Duration::from_secs(300);
const RETRY_AFTER: Duration = Duration::from_secs(30);

#[derive(Clone, Default)]
pub(crate) struct ToolCatalog {
    entries: Arc<RwLock<HashMap<String, Entry>>>,
    metadata: Arc<RwLock<HashMap<String, MetadataInitialization>>>,
}

struct MetadataInitialization {
    generation: Arc<()>,
    loading: bool,
    error: Option<String>,
}

struct Entry {
    generation: Arc<()>,
    servers: Vec<String>,
    catalogs: HashMap<String, Vec<McpTools>>,
    errors: HashMap<String, String>,
    pending: usize,
    completed_at: Option<Instant>,
}

pub(crate) struct CatalogSnapshot {
    pub catalogs: HashMap<String, Vec<McpTools>>,
    pub warnings: Vec<String>,
    pub loading: bool,
}

impl ToolCatalog {
    pub async fn invalidate(&self, session_id: &str) {
        self.entries.write().await.remove(session_id);
        self.metadata.write().await.remove(session_id);
    }

    pub async fn clear(&self) {
        self.entries.write().await.clear();
        self.metadata.write().await.clear();
    }

    pub async fn initialize_metadata(
        &self,
        session: Arc<Session>,
        events: Arc<EventBus>,
    ) -> (bool, Option<String>) {
        let session_id = session.id().to_string();
        let mut metadata = self.metadata.write().await;
        if let Some(state) = metadata.get(&session_id) {
            return (state.loading, state.error.clone());
        }
        let generation = Arc::new(());
        metadata.insert(
            session_id.clone(),
            MetadataInitialization {
                generation: generation.clone(),
                loading: true,
                error: None,
            },
        );
        drop(metadata);
        let metadata = self.metadata.clone();
        tokio::spawn(async move {
            let cancellation = session.cancellation_token();
            let result = tokio::select! {
                _ = cancellation.cancelled() => return,
                result = tokio::time::timeout(DISCOVERY_TIMEOUT, async {
                    session.rpc().tools().initialize_and_validate().await
                }) => result,
            };
            let error = match result {
                Ok(Ok(_)) => None,
                Ok(Err(error)) => Some(format!("Tool initialization failed: {error}")),
                Err(_) => Some("Tool initialization has not completed within 5 seconds. Catalog browsing remains available.".into()),
            };
            let mut metadata = metadata.write().await;
            let Some(state) = metadata
                .get_mut(&session_id)
                .filter(|state| Arc::ptr_eq(&state.generation, &generation))
            else {
                return;
            };
            state.loading = false;
            state.error = error;
            drop(metadata);
            events.emit(AppEvent::ToolInventoryUpdated { session_id });
        });
        (true, None)
    }

    pub async fn snapshot(
        &self,
        session: Arc<Session>,
        client: Client,
        servers: &[ControlledServer],
        events: Arc<EventBus>,
    ) -> CatalogSnapshot {
        let session_id = session.id().to_string();
        let mut connected = servers
            .iter()
            .filter(|server| server.status == "connected")
            .map(|server| server.name.clone())
            .collect::<Vec<_>>();
        connected.sort();
        let mut entries = self.entries.write().await;
        let refresh = entries.get(&session_id).is_none_or(|entry| {
            entry.servers != connected
                || entry.completed_at.is_some_and(|at| {
                    at.elapsed()
                        >= if entry.errors.is_empty() {
                            CATALOG_TTL
                        } else {
                            RETRY_AFTER
                        }
                })
        });
        let mut launch = None;
        if refresh {
            let generation = Arc::new(());
            let catalogs = entries
                .remove(&session_id)
                .map(|entry| entry.catalogs)
                .unwrap_or_default();
            entries.insert(
                session_id.clone(),
                Entry {
                    generation: generation.clone(),
                    pending: connected.len(),
                    servers: connected.clone(),
                    catalogs,
                    errors: HashMap::new(),
                    completed_at: connected.is_empty().then(Instant::now),
                },
            );
            if !connected.is_empty() {
                launch = Some(generation);
            }
        }
        let entry = entries.get(&session_id).expect("catalog entry initialized");
        let snapshot = CatalogSnapshot {
            catalogs: entry.catalogs.clone(),
            warnings: entry.errors.values().cloned().collect(),
            loading: entry.pending > 0,
        };
        drop(entries);

        if let Some(generation) = launch {
            let entries = self.entries.clone();
            let cancellation = session.cancellation_token();
            tokio::spawn(async move {
                let mut discovery = stream::iter(connected.into_iter().map(|server| {
                    let client = client.clone();
                    let session_id = session_id.clone();
                    async move {
                        let result = tokio::time::timeout(
                            DISCOVERY_TIMEOUT,
                            client.call(
                                "session.mcp.listTools",
                                Some(json!({
                                    "sessionId": session_id, "serverName": server,
                                })),
                            ),
                        )
                        .await;
                        let tools = match result {
                            Ok(Ok(value)) => value
                                .get("tools")
                                .filter(|tools| tools.is_array())
                                .ok_or_else(|| format!("{server}: catalog returned no tool list"))
                                .and_then(|tools| {
                                    serde_json::from_value::<Vec<McpTools>>(tools.clone()).map_err(
                                        |error| format!("{server}: invalid tool catalog: {error}"),
                                    )
                                }),
                            Ok(Err(error)) => {
                                Err(format!("{server}: catalog unavailable: {error}"))
                            }
                            Err(_) => Err(format!(
                                "{server}: optional catalog discovery timed out after 5 seconds"
                            )),
                        };
                        (server, tools)
                    }
                }))
                .buffer_unordered(4);
                loop {
                    let result = tokio::select! {
                        _ = cancellation.cancelled() => return,
                        result = discovery.next() => result,
                    };
                    let Some((server, result)) = result else {
                        return;
                    };
                    let mut entries = entries.write().await;
                    let Some(entry) = entries
                        .get_mut(&session_id)
                        .filter(|entry| Arc::ptr_eq(&entry.generation, &generation))
                    else {
                        return;
                    };
                    match result {
                        Ok(tools) => {
                            entry.catalogs.insert(server, tools);
                        }
                        Err(error) => {
                            entry.errors.insert(server, error);
                        }
                    }
                    entry.pending -= 1;
                    if entry.pending == 0 {
                        entry.completed_at = Some(Instant::now());
                    }
                    drop(entries);
                    events.emit(AppEvent::ToolInventoryUpdated {
                        session_id: session_id.clone(),
                    });
                }
            });
        }
        snapshot
    }
}
