use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

const MAX_SCROLLBACK_BYTES: usize = 2 * 1024 * 1024;
const SOFT_TERMINAL_LIMIT: usize = 8;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMessage {
    Input { data: String },
    Resize { cols: u16, rows: u16 },
    Chdir { cwd: String },
    RequestControl,
    ReleaseControl,
    Terminate,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum ServerMessage {
    Ready {
        session_id: String,
        cwd: String,
        shell: String,
        restored: bool,
        has_control: bool,
        viewers: usize,
    },
    Output {
        data: String,
    },
    Snapshot {
        data: String,
    },
    Cwd {
        cwd: String,
    },
    ControlChanged {
        controller: Option<String>,
        viewers: usize,
    },
    Exit,
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCheckpoint {
    pub session_id: String,
    pub cwd: String,
    pub shell: String,
    pub scrollback: String,
}

#[derive(Default)]
struct ManagerState {
    terminals: HashMap<String, Arc<TerminalSession>>,
    lru: VecDeque<String>,
    restored: HashMap<String, TerminalCheckpoint>,
}

#[derive(Clone, Default)]
pub struct TerminalManager {
    state: Arc<Mutex<ManagerState>>,
}

struct TerminalSession {
    session_id: String,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    shell_kind: ShellKind,
    shell: String,
    cwd: Mutex<String>,
    scrollback: Mutex<VecDeque<u8>>,
    events: broadcast::Sender<ServerMessage>,
    attached_clients: AtomicUsize,
    at_prompt: AtomicBool,
    exited: AtomicBool,
    restored: bool,
    controller: Mutex<Option<String>>,
}

impl TerminalManager {
    pub fn load_checkpoints(&self, path: &Path) -> Result<usize, String> {
        if !path.is_file() {
            return Ok(0);
        }
        let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
        let checkpoints: Vec<TerminalCheckpoint> =
            serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        let count = checkpoints.len();
        let mut state = self.state.lock().map_err(|_| "terminal state poisoned")?;
        state.restored = checkpoints
            .into_iter()
            .map(|checkpoint| (checkpoint.session_id.clone(), checkpoint))
            .collect();
        drop(state);
        std::fs::remove_file(path).map_err(|error| error.to_string())?;
        Ok(count)
    }

    pub fn checkpoint(&self, path: &Path) -> Result<Vec<TerminalCheckpoint>, String> {
        let checkpoints = {
            let state = self.state.lock().map_err(|_| "terminal state poisoned")?;
            state
                .terminals
                .values()
                .map(|terminal| terminal.checkpoint())
                .chain(state.restored.values().cloned())
                .collect::<Vec<_>>()
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let bytes = serde_json::to_vec_pretty(&checkpoints).map_err(|error| error.to_string())?;
        let temporary = path.with_extension("json.tmp");
        std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
        std::fs::rename(temporary, path).map_err(|error| error.to_string())?;
        Ok(checkpoints)
    }

    pub fn terminate_all(&self) {
        let terminals = self
            .state
            .lock()
            .map(|mut state| state.terminals.drain().map(|(_, value)| value).collect())
            .unwrap_or_else(|_| Vec::<Arc<TerminalSession>>::new());
        for terminal in terminals {
            terminal.terminate();
        }
    }

    pub async fn attach(
        &self,
        socket: WebSocket,
        session_id: String,
        client_id: String,
        cwd: PathBuf,
        cols: Option<u16>,
        rows: Option<u16>,
    ) {
        let terminal = match self.get_or_start(&session_id, cwd, cols, rows) {
            Ok(terminal) => terminal,
            Err(message) => {
                send_socket_error(socket, message).await;
                return;
            }
        };
        let viewers = terminal.attached_clients.fetch_add(1, Ordering::Relaxed) + 1;
        let has_control = terminal.claim_control(&client_id, false);
        let mut terminal_events = terminal.events.subscribe();
        let (mut socket_tx, mut socket_rx) = socket.split();
        send(
            &mut socket_tx,
            &ServerMessage::Ready {
                session_id,
                cwd: terminal.cwd(),
                shell: terminal.shell.clone(),
                restored: terminal.restored,
                has_control,
                viewers,
            },
        )
        .await;
        let scrollback = terminal.scrollback();
        if !scrollback.is_empty() {
            send(
                &mut socket_tx,
                &ServerMessage::Snapshot { data: scrollback },
            )
            .await;
        }
        send(
            &mut socket_tx,
            &ServerMessage::Cwd {
                cwd: terminal.cwd(),
            },
        )
        .await;

        loop {
            tokio::select! {
                incoming = socket_rx.next() => {
                    let Some(Ok(message)) = incoming else { break };
                    let Message::Text(text) = message else { continue };
                    let Ok(message) = serde_json::from_str::<ClientMessage>(&text) else {
                        send(&mut socket_tx, &ServerMessage::Error {
                            message: "invalid terminal message".to_string(),
                        }).await;
                        continue;
                    };
                    let result = match message {
                        ClientMessage::Input { data } => terminal
                            .require_control(&client_id)
                            .and_then(|()| terminal.write(data.as_bytes())),
                        ClientMessage::Resize { cols, rows } => terminal
                            .require_control(&client_id)
                            .and_then(|()| terminal.resize(cols, rows)),
                        ClientMessage::Chdir { cwd } => terminal
                            .require_control(&client_id)
                            .and_then(|()| terminal.chdir(&cwd)),
                        ClientMessage::RequestControl => {
                            if terminal.claim_control(&client_id, false) {
                                Ok(())
                            } else {
                                Err("another client currently controls this terminal".to_string())
                            }
                        }
                        ClientMessage::ReleaseControl => {
                            terminal.release_control(&client_id);
                            Ok(())
                        }
                        ClientMessage::Terminate => {
                            terminal
                                .require_control(&client_id)
                                .map(|()| terminal.terminate())
                        }
                    };
                    if let Err(message) = result {
                        send(&mut socket_tx, &ServerMessage::Error { message }).await;
                    }
                }
                event = terminal_events.recv() => {
                    match event {
                        Ok(event) => send(&mut socket_tx, &event).await,
                        Err(broadcast::error::RecvError::Lagged(count)) => {
                            send(&mut socket_tx, &ServerMessage::Error {
                                message: format!("terminal display skipped {count} output chunks"),
                            }).await;
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
            }
        }
        terminal.attached_clients.fetch_sub(1, Ordering::Relaxed);
        terminal.release_control(&client_id);
    }

    fn get_or_start(
        &self,
        session_id: &str,
        cwd: PathBuf,
        cols: Option<u16>,
        rows: Option<u16>,
    ) -> Result<Arc<TerminalSession>, String> {
        {
            let mut state = self.state.lock().map_err(|_| "terminal state poisoned")?;
            if let Some(existing) = state.terminals.get(session_id).cloned()
                && !existing.exited.load(Ordering::Relaxed)
            {
                touch_lru(&mut state.lru, session_id);
                return Ok(existing);
            }
            state.terminals.remove(session_id);
        }

        let restored = self
            .state
            .lock()
            .map_err(|_| "terminal state poisoned")?
            .restored
            .remove(session_id);
        let start_cwd = restored
            .as_ref()
            .map(|checkpoint| PathBuf::from(&checkpoint.cwd))
            .filter(|path| path.is_dir())
            .unwrap_or(cwd);
        let terminal = TerminalSession::start(
            session_id.to_string(),
            start_cwd,
            cols,
            rows,
            restored.as_ref(),
        )?;

        let mut state = self.state.lock().map_err(|_| "terminal state poisoned")?;
        state
            .terminals
            .insert(session_id.to_string(), terminal.clone());
        touch_lru(&mut state.lru, session_id);
        reap_detached_terminals(&mut state);
        Ok(terminal)
    }
}

impl TerminalSession {
    fn start(
        session_id: String,
        cwd: PathBuf,
        cols: Option<u16>,
        rows: Option<u16>,
        checkpoint: Option<&TerminalCheckpoint>,
    ) -> Result<Arc<Self>, String> {
        if !cwd.is_dir() {
            return Err(format!(
                "working directory does not exist: {}",
                cwd.display()
            ));
        }
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: rows.unwrap_or(28).max(2),
                cols: cols.unwrap_or(100).max(2),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| error.to_string())?;
        let (command, shell, shell_kind) = shell_command(&cwd);
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("could not start {shell}: {error}"))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| error.to_string())?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| error.to_string())?;
        let (events, _) = broadcast::channel(512);
        let terminal = Arc::new(Self {
            session_id,
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            child: Mutex::new(child),
            shell_kind,
            shell,
            cwd: Mutex::new(cwd.to_string_lossy().into_owned()),
            scrollback: Mutex::new(
                checkpoint
                    .map(|value| value.scrollback.as_bytes().iter().copied().collect())
                    .unwrap_or_default(),
            ),
            events,
            attached_clients: AtomicUsize::new(0),
            at_prompt: AtomicBool::new(false),
            exited: AtomicBool::new(false),
            restored: checkpoint.is_some(),
            controller: Mutex::new(None),
        });
        spawn_reader(terminal.clone(), reader);
        Ok(terminal)
    }

    fn write(&self, data: &[u8]) -> Result<(), String> {
        self.at_prompt.store(false, Ordering::Relaxed);
        let mut writer = self.writer.lock().map_err(|_| "terminal writer poisoned")?;
        writer.write_all(data).map_err(|error| error.to_string())?;
        writer.flush().map_err(|error| error.to_string())
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master
            .lock()
            .map_err(|_| "terminal PTY poisoned")?
            .resize(PtySize {
                rows: rows.max(2),
                cols: cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| error.to_string())
    }

    fn chdir(&self, cwd: &str) -> Result<(), String> {
        if !Path::new(cwd).is_dir() {
            return Err(format!("working directory does not exist: {cwd}"));
        }
        self.write(chdir_command(self.shell_kind, cwd).as_bytes())
    }

    fn cwd(&self) -> String {
        self.cwd
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default()
    }

    fn scrollback(&self) -> String {
        self.scrollback
            .lock()
            .map(|mut bytes| String::from_utf8_lossy(bytes.make_contiguous()).into_owned())
            .unwrap_or_default()
    }

    fn push_output(&self, data: &str) {
        if let Ok(mut scrollback) = self.scrollback.lock() {
            scrollback.extend(data.as_bytes());
            while scrollback.len() > MAX_SCROLLBACK_BYTES {
                scrollback.pop_front();
            }
        }
    }

    fn checkpoint(&self) -> TerminalCheckpoint {
        TerminalCheckpoint {
            session_id: self.session_id.clone(),
            cwd: self.cwd(),
            shell: self.shell.clone(),
            scrollback: self.scrollback(),
        }
    }

    fn terminate(&self) {
        if !self.exited.swap(true, Ordering::Relaxed) {
            if let Ok(mut child) = self.child.lock() {
                let _ = child.kill();
            }
            let _ = self.events.send(ServerMessage::Exit);
        }
    }

    fn require_control(&self, client_id: &str) -> Result<(), String> {
        if self
            .controller
            .lock()
            .map(|controller| controller.as_deref() == Some(client_id))
            .unwrap_or(false)
        {
            Ok(())
        } else {
            Err("terminal is read-only in this client; take control first".to_string())
        }
    }

    fn claim_control(&self, client_id: &str, force: bool) -> bool {
        let claimed = self
            .controller
            .lock()
            .map(|mut controller| {
                if controller.is_none() || controller.as_deref() == Some(client_id) || force {
                    *controller = Some(client_id.to_string());
                    true
                } else {
                    false
                }
            })
            .unwrap_or(false);
        if claimed {
            self.broadcast_control();
        }
        claimed
    }

    fn release_control(&self, client_id: &str) {
        let released = if let Ok(mut controller) = self.controller.lock() {
            if controller.as_deref() == Some(client_id) {
                *controller = None;
                true
            } else {
                false
            }
        } else {
            false
        };
        if released {
            self.broadcast_control();
        }
    }

    fn broadcast_control(&self) {
        let controller = self
            .controller
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default();
        let _ = self.events.send(ServerMessage::ControlChanged {
            controller,
            viewers: self.attached_clients.load(Ordering::Relaxed),
        });
    }
}

fn spawn_reader(terminal: Arc<TerminalSession>, mut reader: Box<dyn Read + Send>) {
    std::thread::spawn(move || {
        let mut bytes = [0_u8; 8192];
        let mut osc_tail = String::new();
        loop {
            match reader.read(&mut bytes) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    let data = String::from_utf8_lossy(&bytes[..count]).into_owned();
                    terminal.push_output(&data);
                    let _ = terminal
                        .events
                        .send(ServerMessage::Output { data: data.clone() });
                    osc_tail.push_str(&data);
                    while let Some((cwd, consumed)) = take_osc7(&osc_tail) {
                        if let Ok(mut current) = terminal.cwd.lock() {
                            *current = cwd.clone();
                        }
                        terminal.at_prompt.store(true, Ordering::Relaxed);
                        let _ = terminal.events.send(ServerMessage::Cwd { cwd });
                        osc_tail.drain(..consumed);
                    }
                    if osc_tail.len() > 4096 {
                        let keep_from = osc_tail.len().saturating_sub(512);
                        osc_tail.drain(..keep_from);
                    }
                }
            }
        }
        terminal.exited.store(true, Ordering::Relaxed);
        let _ = terminal.events.send(ServerMessage::Exit);
    });
}

fn touch_lru(lru: &mut VecDeque<String>, session_id: &str) {
    lru.retain(|id| id != session_id);
    lru.push_back(session_id.to_string());
}

fn reap_detached_terminals(state: &mut ManagerState) {
    while state.terminals.len() > SOFT_TERMINAL_LIMIT {
        let Some(candidate) = state.lru.pop_front() else {
            break;
        };
        let can_reap = state.terminals.get(&candidate).is_some_and(|terminal| {
            terminal.attached_clients.load(Ordering::Relaxed) == 0
                && terminal.at_prompt.load(Ordering::Relaxed)
        });
        if can_reap {
            if let Some(terminal) = state.terminals.remove(&candidate) {
                terminal.terminate();
            }
        } else {
            state.lru.push_back(candidate);
            break;
        }
    }
}

async fn send(
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    message: &ServerMessage,
) {
    if let Ok(json) = serde_json::to_string(message) {
        let _ = sender.send(Message::Text(json.into())).await;
    }
}

async fn send_socket_error(socket: WebSocket, message: String) {
    let (mut sender, _) = socket.split();
    send(&mut sender, &ServerMessage::Error { message }).await;
}

#[derive(Clone, Copy)]
enum ShellKind {
    #[cfg(windows)]
    PowerShell,
    #[cfg(not(windows))]
    Posix,
}

fn shell_command(cwd: &Path) -> (CommandBuilder, String, ShellKind) {
    #[cfg(windows)]
    {
        let shell = if command_exists("pwsh.exe") {
            "pwsh.exe"
        } else {
            "powershell.exe"
        };
        let mut command = CommandBuilder::new(shell);
        command.cwd(cwd);
        command.args([
            "-NoLogo",
            "-NoExit",
            "-Command",
            "function global:prompt { $u=[System.Uri]::new((Get-Location).Path).AbsoluteUri; Write-Host -NoNewline \"`e]7;$u`a\"; \"PS $((Get-Location).Path)> \" }",
        ]);
        (command, shell.to_string(), ShellKind::PowerShell)
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        let mut command = CommandBuilder::new(&shell);
        command.cwd(cwd);
        command.env(
            "PROMPT_COMMAND",
            "printf '\\033]7;file://%s%s\\007' \"$HOSTNAME\" \"$PWD\"",
        );
        command.arg("-i");
        (command, shell, ShellKind::Posix)
    }
}

fn chdir_command(shell: ShellKind, cwd: &str) -> String {
    match shell {
        #[cfg(windows)]
        ShellKind::PowerShell => {
            format!("Set-Location -LiteralPath '{}'\r", cwd.replace('\'', "''"))
        }
        #[cfg(not(windows))]
        ShellKind::Posix => format!("cd -- '{}'\r", cwd.replace('\'', "'\\''")),
    }
}

#[cfg(windows)]
fn command_exists(command: &str) -> bool {
    std::process::Command::new("where.exe")
        .arg(command)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn take_osc7(input: &str) -> Option<(String, usize)> {
    let start = input.find("\u{1b}]7;")?;
    let value_start = start + 4;
    let rest = &input[value_start..];
    let (value, end_len) = if let Some(end) = rest.find('\u{7}') {
        (&rest[..end], end + 1)
    } else {
        let end = rest.find("\u{1b}\\")?;
        (&rest[..end], end + 2)
    };
    let cwd = file_uri_to_path(value)?;
    Some((cwd, value_start + end_len))
}

fn file_uri_to_path(value: &str) -> Option<String> {
    let path = value.strip_prefix("file://")?;
    let path = match path.find('/') {
        Some(index) => &path[index..],
        None => path,
    };
    let decoded = percent_decode(path);
    #[cfg(windows)]
    let decoded = decoded
        .strip_prefix('/')
        .unwrap_or(&decoded)
        .replace('/', "\\");
    Some(decoded)
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let Ok(hex) = u8::from_str_radix(&value[index + 1..index + 3], 16)
        {
            output.push(hex);
            index += 3;
            continue;
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&output).into_owned()
}

#[cfg(test)]
mod tests {
    use super::{file_uri_to_path, take_osc7};

    #[test]
    fn parses_bel_terminated_osc7() {
        let input = "\u{1b}]7;file://localhost/C:/work/demo\u{7}PS>";
        let (cwd, consumed) = take_osc7(input).expect("OSC 7");
        assert_eq!(cwd, r"C:\work\demo");
        assert_eq!(&input[consumed..], "PS>");
    }

    #[test]
    fn decodes_spaces() {
        assert_eq!(
            file_uri_to_path("file:///C:/work/my%20repo").as_deref(),
            Some(r"C:\work\my repo")
        );
    }
}
