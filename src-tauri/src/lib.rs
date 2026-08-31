use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::Manager;

const DAEMON_ADDR: &str = "127.0.0.1:3847";
const START_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DaemonStatus {
    running: bool,
    url: String,
}

#[tauri::command]
fn daemon_status() -> DaemonStatus {
    status()
}

#[tauri::command]
fn ensure_daemon(app: tauri::AppHandle) -> Result<DaemonStatus, String> {
    ensure(&app)?;
    Ok(status())
}

fn status() -> DaemonStatus {
    DaemonStatus {
        running: daemon_running(),
        url: format!("http://{DAEMON_ADDR}"),
    }
}

fn daemon_running() -> bool {
    let Ok(addr) = DAEMON_ADDR.parse::<SocketAddr>() else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(350)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(700)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    if stream
        .write_all(b"GET /api/health HTTP/1.0\r\nHost: 127.0.0.1:3847\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    stream.read_to_string(&mut response).is_ok()
        && response.contains("200 OK")
        && response.contains("copilot-sessionsd")
}

fn ensure(app: &tauri::AppHandle) -> Result<(), String> {
    if daemon_running() {
        return Ok(());
    }
    let executable = resolve_daemon(app)?;
    let ui_dir = resolve_ui_dir(app);
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&log_dir).map_err(|error| error.to_string())?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("copilot-sessionsd.log"))
        .map_err(|error| error.to_string())?;
    let log_err = log.try_clone().map_err(|error| error.to_string())?;
    let mut command = Command::new(&executable);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Match mkb's proven detached launch: DETACHED_PROCESS |
        // CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW.
        command.creation_flags(0x0000_0008 | 0x0000_0200 | 0x0800_0000);
    }
    if let Some(ui_dir) = ui_dir {
        command.env("COPILOT_SESSIONS_UI_DIR", ui_dir);
    }
    command
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", executable.display()))?;

    let started = Instant::now();
    while started.elapsed() < START_TIMEOUT {
        if daemon_running() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    Err("copilot-sessionsd did not become ready within 60 seconds".to_string())
}

fn resolve_daemon(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("COPILOT_SESSIONSD_PATH").map(PathBuf::from) {
        if path.is_file() {
            return Ok(path);
        }
        return Err(format!(
            "COPILOT_SESSIONSD_PATH does not point to a file: {}",
            path.display()
        ));
    }

    let filename = if cfg!(windows) {
        "copilot-sessionsd.exe"
    } else {
        "copilot-sessionsd"
    };
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("bin").join(filename);
        if bundled.is_file() {
            return Ok(bundled);
        }
    }
    if let Ok(current) = std::env::current_exe() {
        let sibling = current.with_file_name(filename);
        if sibling.is_file() {
            return Ok(sibling);
        }
    }
    find_on_path(filename).ok_or_else(|| {
        format!(
            "could not find {filename}; build it with `cargo build -p copilot-sessionsd` or set COPILOT_SESSIONSD_PATH"
        )
    })
}

fn resolve_ui_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("COPILOT_SESSIONS_UI_DIR").map(PathBuf::from) {
        return Some(path);
    }
    app.path()
        .resource_dir()
        .ok()
        .map(|path| path.join("web"))
        .filter(|path| path.join("index.html").is_file())
        .or_else(|| {
            let current = std::env::current_dir().ok()?;
            [current.join("dist"), current.join("..").join("dist")]
                .into_iter()
                .find(|path| path.join("index.html").is_file())
        })
}

fn find_on_path(filename: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join(filename))
            .find(|candidate| candidate.is_file())
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            ensure(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![daemon_status, ensure_daemon])
        .run(tauri::generate_context!())
        .expect("error while running Copilot Sessions");
}
