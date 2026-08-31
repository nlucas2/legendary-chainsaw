#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

use std::net::SocketAddr;
use std::path::PathBuf;

use copilot_sessions_core::SessionService;
use copilot_sessionsd::{DaemonConfig, default_bind, serve};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "copilot_sessions=info".into()),
        )
        .init();

    let bind = std::env::var("COPILOT_SESSIONS_BIND")
        .ok()
        .and_then(|value| value.parse::<SocketAddr>().ok())
        .unwrap_or_else(default_bind);
    let ui_dir = std::env::var_os("COPILOT_SESSIONS_UI_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("dist"));
    let access_token = std::env::var("COPILOT_SESSIONS_TOKEN")
        .ok()
        .filter(|token| !token.is_empty());
    let service = SessionService::start(SessionService::default_data_dir()).await?;
    serve(
        service,
        DaemonConfig {
            bind,
            ui_dir,
            access_token,
        },
    )
    .await
}
