#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

use std::ffi::OsString;
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
    let data_dir = resolve_data_dir(std::env::var_os("COPILOT_SESSIONS_DATA_DIR"))?;
    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!(address = %bind, "claimed daemon address; starting Copilot runtime");
    let service = SessionService::start(data_dir).await?;
    serve(
        service,
        DaemonConfig {
            bind,
            ui_dir,
            access_token,
        },
        listener,
    )
    .await
}

fn resolve_data_dir(value: Option<OsString>) -> anyhow::Result<PathBuf> {
    match value {
        Some(value) if value.is_empty() => {
            anyhow::bail!("COPILOT_SESSIONS_DATA_DIR must not be empty")
        }
        Some(value) => Ok(PathBuf::from(value)),
        None => Ok(SessionService::default_data_dir()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_data_directory_is_used_without_modifying_process_environment() {
        let directory = PathBuf::from("test-state").join("disposable-daemon");
        assert_eq!(
            resolve_data_dir(Some(directory.clone().into_os_string())).unwrap(),
            directory
        );
    }

    #[test]
    fn unset_directory_preserves_default_and_empty_override_fails_closed() {
        assert_eq!(
            resolve_data_dir(None).unwrap(),
            SessionService::default_data_dir()
        );
        assert!(resolve_data_dir(Some(OsString::new())).is_err());
    }
}
