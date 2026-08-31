# Copilot Sessions

A responsive web client and lightweight Tauri desktop shell for GitHub Copilot CLI sessions.
Both interfaces connect to the same long-lived Rust daemon, so sessions, approvals, terminal
processes, and event streams have one owner and remain available when an interface closes.

## Architecture

```text
Tauri desktop shell ─┐
                     ├─ HTTP + SSE + WebSocket ─► copilot-sessionsd ─► Copilot Rust SDK ─► Copilot CLI
Mobile/web browser ──┘                                  │
                                                       └─ PTY processes
```

- **`copilot-sessionsd`** is the single stateful process. It owns the Copilot SDK client, active
  sessions, permission interception, event fan-out, persisted app metadata, and PTYs.
- **The React app** is one responsive source tree. The daemon serves it to browsers; Tauri embeds
  the same build and connects to the same daemon protocol.
- **The Tauri shell** only discovers or starts `copilot-sessionsd`. It does not own sessions or
  terminal processes and has no parallel session API.
- **Tool calls** pass through the daemon's permission handler. Requests are shown in every connected
  interface and can be approved once or denied before the CLI executes them.
- **The terminal** is optional and resizable on desktop. On narrow screens it becomes a full-screen
  pane. Each Copilot session gets its own lazy daemon-owned PTY. Closing the pane detaches it;
  revisiting the session restores the same process, environment, CWD, and up to 2 MiB of scrollback.
  OSC-7 shell updates can move the Copilot session's working directory with **Track CWD** enabled.
- **Multiple clients** may observe the same session. A terminal grants input control to one tab at a
  time while other attached clients remain read-only; permission and runtime state resolves across
  every open interface.
- **Models** are resolved from the live session rather than labeled "default." The header opens the
  session-specific model catalog and switches via the Copilot runtime.
- **Organization metadata** is app-owned and non-invasive: sessions can be pinned and assigned a
  folder and tags without modifying the underlying Copilot transcript.
- **Appearance** follows mkb's Auto / Light / Dark model. Auto tracks the OS, and Light uses mkb's
  warm Catppuccin-Latte-inspired paper palette. The preference follows open browser tabs.

## Process lifecycle and updates

`copilot-sessionsd` is explicitly long-lived and never exits because every UI detached or because it
was idle. Closing Tauri or a browser does not stop Copilot, MCP servers, or terminal processes.

The **Runtime maintenance** panel provides the only child-process lifecycle controls:

- **Reload MCP servers** reloads MCP hosts across active sessions without restarting the daemon.
- **Drain & disconnect Copilot** pauses new prompts, waits for active turns, then disconnects
  sessions and stops the Copilot CLI/MCP processes. Session history remains persisted; terminals
  keep running.
- **Prepare daemon restart** performs the same drain, checkpoints terminal CWD and bounded
  scrollback, then terminates terminal children. The next daemon restores the checkpoint into fresh
  shells and labels them as restored.
- **Reconnect Copilot** starts a fresh CLI runtime; sessions resume lazily when opened.

Terminal environment changes remain available across UI detach/reattach because the shell process
continues running. Across a daemon restart, CWD and scrollback are restored but arbitrary process
environment and running programs cannot be serialized; native shell history remains available
through the shell's normal history mechanism.

## Prerequisites

- Rust 1.94+
- Node.js 18+
- A GitHub Copilot subscription and authenticated Copilot CLI environment
- Tauri platform prerequisites for desktop builds

The official Rust Copilot SDK bundles its compatible CLI by default.

## Development

Install frontend dependencies:

```powershell
npm install
```

Run the daemon and web UI:

```powershell
npm run build
npm run daemon
```

Open `http://127.0.0.1:3847`. For frontend hot reload, leave the daemon running and use:

```powershell
npm run dev
```

Run the Tauri desktop app:

```powershell
npm run desktop
```

## Web listener

The daemon serves the responsive web interface on `127.0.0.1:3847` by default. It is deliberately
agnostic about how that listener is published or forwarded.

Set `COPILOT_SESSIONS_TOKEN` before starting the daemon to require login. If binding directly to a
non-loopback address, the daemon refuses to start unless this token is configured.

| Variable | Default | Purpose |
|---|---|---|
| `COPILOT_SESSIONS_BIND` | `127.0.0.1:3847` | Daemon HTTP address |
| `COPILOT_SESSIONS_TOKEN` | unset | Shared web access token |
| `COPILOT_SESSIONS_UI_DIR` | `dist` | Built web assets to serve |
| `COPILOT_SESSIONSD_PATH` | auto-detected | Tauri override for the daemon executable |

## Build

Build the standalone web/daemon product:

```powershell
npm run build
cargo build -p copilot-sessionsd --release
```

Stage the daemon and shared web build into a Tauri bundle:

```powershell
npm run desktop:build
```
