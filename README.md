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
  Desktop layout controls place it above, below, or beside the conversation without recreating the terminal.
  Above is the default for clients without a saved layout; existing saved placement is preserved.
  Drag the divider, or focus it and use the arrow keys (Shift for larger steps). Placement and size
  are saved locally.
- **Multiple clients** may observe the same session. A terminal grants input control to one tab at a
  time while other attached clients remain read-only; permission and runtime state resolves across
  every open interface.
- **Catch up** merges recent persisted history into the live transcript without restarting the
  shared Copilot runtime or detaching other sessions.
  History is anchored to recent root-user messages rather than arbitrary telemetry pages; the header
  reports attachment/activity state and the loaded timestamp, turn count, and remaining older history.
- **Live events** use the SDK's forward event-log cursor and a sequenced replay bus. Model-call
  boundaries do not mark the whole session idle: session lifecycle events drive the composer status,
  with a periodic authoritative snapshot for recovery. Accepted, model-started, and first-output
  timings distinguish runtime/model latency from UI latency. Heavy diagnostic payloads are opt-in.
- **Models** are resolved from the live session rather than labeled "default." The header opens the
  session-specific model catalog and switches via the Copilot runtime.
- **Context & Tools** shows runtime token attribution and session-scoped tool availability. Tool
  filters affect future offered tools, not in-flight execution; disabling an MCP server is separate
  from changing user-wide MCP configuration. The current tool list does not wait for full MCP
  catalogs: optional discovery uses a shared cache with bounded background requests and publishes updates
  through the daemon event bus. Slow or failing servers show warnings without hiding the controls.
  Reopening the drawer retains its last snapshot while refreshing authoritative state.
- **Chat while working** supports FIFO queueing and explicit immediate steering. Queued messages can
  be edited, moved earlier, removed, or sent to the running turn. The queue uses compact preview rows
  with inline actions and a bounded scrolling list. Click its heading to collapse it to a count and
  next-message preview; errors remain visible, and collapsing does not cancel or change queued work.
  Selected files and pasted images are
  sent as SDK attachments only when the message is submitted. Draft text and files stay together
  per session while the client remains open; failed sends are restored or retained as separate unsent
  drafts without overwriting newer text. Ctrl+S stashes the complete session draft, including files.
- **`/ask <question>`** runs a transient, no-tools query against the current conversation without
  adding a chat turn. The Ask button opens a question draft. Answers live only in the panel.
  **Continue in chat** prepares a normal chat draft carrying the submitted question, answer,
  and any attached review context. It does not send until you submit the composer.
  The pinned runtime cannot correlate its broadcast query chunks to a caller, so the panel waits
  for the request's final answer instead of risking another client's output. Closing it does not
  stop the parent; cancellation is not exposed by this runtime API.
- **Fork conversation** (or `/fork`) creates an independent native context copy without changing
  the parent. Forking requires an idle session. It does not make a Git branch or copy terminal
  processes, and inherited pending work is never automatically resumed. After an explicit new
  message is accepted in the fork, recovery of that fork's own subsequent work is enabled.
- **Subagent navigation** belongs to each session: expand its sidebar row to see running and idle
  agents, or select **Show finished** to browse completed work. Selecting an agent opens its own
  conversation and a directly addressed text composer while the parent continues running. Parent
  and child drafts remain separate, and **Back to parent** restores the parent view. Messaging
  availability comes from the runtime; completed or unsupported tasks are read-only.
  Message attribution uses the runtime's source metadata, not just its `user` role:
  inter-agent prompts say **Agent instruction**, and injected skills say **Skill instructions**.
  Subagent inputs with no recorded sender say **Instruction**, rather than claiming they came
  from you; hover the label for provenance details. Known human inputs keep **You**.
  Agent/skill inputs do not become human-turn scroll anchors or replace pending human messages.
- **Questions and approvals** are separate from tool argument displays. Pending questions appear in
  a visible input panel above the conversation, including while viewing a subagent. Choices remain
  unselected until you answer; free-form replies are available when the runtime permits them.
- **Organization metadata** is app-owned and non-invasive: sessions can be pinned and assigned a
  folder and tags without modifying the underlying Copilot transcript.
  The pencil beside the session title (or on its selected sidebar row) edits the session's name.
  **Archive** hides a session from the default **Current** sidebar view without stopping work,
  closing its terminal, deleting history, or changing folders, tags or pins. Use the sidebar's
  **Current / Archived / All** selector to browse or restore archived sessions in their original
  groups. Archive state is shared by clients connected to the same daemon.
  Rows have Archive/Restore actions, including for sessions that are not open; successful changes
  offer Undo. An already-open archived conversation stays open with a Restore button.
  Folder groups have subtle separators and indentation; sessions outside a folder have an explicit,
  collapsible **Unfiled** group rather than appearing to belong to the preceding folder.
  A small sidebar dot shows attached session activity: pulsing accent color for **Working**,
  steady green for **Idle**, and hollow for **Not attached** or **Status unavailable** (hover for
  details). Live events update sessions even when another chat is selected; bounded, read-only
  status polling restores state after reconnects or missed events without opening saved sessions.
  Indicators reflect the main session's processing state; subagents retain their own statuses.
  The pulse respects reduced-motion preferences.
- **Git workspace** discovers the repository from the session's current directory. Its read-only
  views cover staged, unstaged and untracked paths, plus a PR-style **committed** comparison from
  the selected target's merge base to HEAD. Choose a local target ref; the tracking upstream may
  not be the intended PR target. Existing remote default refs (`origin/HEAD`), main/master branches,
  and the upstream appear first under **Likely PR targets**. No refs are invented or fetched.
  There is no fetch, stage, commit, or push action.
  **Unstaged** includes tracked working-tree edits and clearly marked new, untracked files;
  **Untracked** remains available as a new-files-only filter. Regular untracked text files are
  previewed as additions against an empty file and support the same line comments and Ask drafts.
  Viewing a new file does not stage it, and untracked files remain excluded from PR comparison.
  Untracked previews are limited to currently Git-listed, nonignored UTF-8 regular files.
  Reads are bounded and opened relative to held directory handles without following links;
  symlinks, junctions/reparse points, hard links and nested repositories are not opened.
  Files that change during inspection or cannot be opened safely show an explicit unavailable
  message. Empty files and truncated previews are labeled rather than silently omitted.
  **One file** loads a selected diff. **Continuous diffs** displays a PR-style stream and loads
  three more files as you scroll, with a keyboard-accessible Load more button and at most three
  concurrent requests. The desktop file list stays visible and highlights the diff at your reading
  position. Clicking a filename jumps within the stream without switching to One file or losing
  in-progress notes. Distant jumps load nearby previews, not every skipped file; skipped previews
  load on scrolling back to them. Mobile's file picker and previous/next buttons navigate the
  same stream. **Whole-file context** includes unchanged lines around edits in tracked
  text files. All previews remain capped at 192 KiB or 2,500 lines, with truncation clearly marked.
  On mobile, comparison/repository details start collapsed. Compact change-view, layout and
  file selectors stay visible while scrolling, with previous/next-file buttons. Diffs scroll
  horizontally within their own bounds; comments and the footer follow the diff normally.
  Binary/non-text files, unsafe untracked paths, conflicts
  and submodule contents are explicitly unavailable rather than opened unsafely.
  Select code directly instead of aiming at checkboxes: click a line, drag across text, Shift-click
  a range, or Ctrl/Cmd-click to toggle individual lines. Keyboard Up/Down, Home/End and Space/Enter
  work too; touch taps toggle lines without preventing scrolling. Added, deleted, and unchanged
  context lines are selectable; diff metadata is not. Each note can cover up to 40 source lines.
  Save local review notes across files, then use **Bring all notes into chat** to triage the
  repository's collected notes together. The bundle includes stable note IDs, file/line references,
  original snapshot identities, and saved code excerpts. Other repositories are excluded; older
  snapshots and legacy notes without surrounding context are labeled, never silently rebased.
  **Quick ask** opens an editable, transient question with separate review context.
  **Discuss in chat** attaches that context to the normal composer without overwriting an existing
  draft; notes, selected code, and unfinished note text are carried over. Review chips can be
  expanded or removed before sending. **Continue in chat** also carries the actual submitted
  question and answer, not any later unsent edits to the question box.
  Review context uses standard UTF-8 text-blob attachments, so it remains in the conversation for
  follow-ups and survives the existing draft stash/retry/session-switch workflow. Each context is
  capped at 512 KiB and counts toward the normal five-file attachment limit. Nothing is sent
  automatically, and sending does not delete or mark local notes resolved. Remove notes explicitly
  when finished. Notes stay in this client until attached; they are never posted to GitHub or
  written into repository files.
- **Appearance** follows mkb's Auto / Light / Dark model. Auto tracks the OS, and Light uses mkb's
  warm Catppuccin-Latte-inspired paper palette. The preference follows open browser tabs.
  **Font & spacing** offers an optional CLI-like monospace preset, custom local font families,
  chat size/line/paragraph spacing, and independent terminal typography. Changes apply immediately;
  terminal font changes resize the existing terminal instead of restarting it. No CLI settings
  are inspected and no fonts are downloaded. The font section starts collapsed.
  **Font & spacing → Reasoning → Customize reasoning** separately controls reasoning font,
  size, line/paragraph spacing, italics, and normal/muted text tone, with a live preview.
  It defaults to the existing appearance and does not change chat or terminal styling.
  Explicit reasoning choices survive switching to the CLI-like preset; **Use chat styling**
  disables the override without losing those choices. **Reset font & spacing** resets all fonts.
  **Appearance → Use full chat width on desktop** expands the conversation and composer within
  the current pane, including split-terminal layouts, without changing mobile spacing or font
  preferences. Markdown tables have padded cells, soft borders and their own horizontal scrolling;
  links use accessible theme colors and wrap long addresses.
  Web links open in the system browser from Tauri, or a separate tab from the web client, rather
  than replacing the conversation. This also applies to reasoning, quick answers, and requested
  authentication pages. In-page anchors stay local. Unsupported schemes and relative repository
  links do not navigate the app; opener failures are shown without falling back to in-app navigation.

## Process lifecycle and updates

`copilot-sessionsd` is explicitly long-lived and never exits because every UI detached or because it
was idle. Closing Tauri or a browser does not stop Copilot, MCP servers, or terminal processes.

The **Runtime maintenance** panel provides explicit child-process lifecycle controls:

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

### One-command Windows update

After saving drafts and terminal work, run this from a **separate Windows Terminal / PowerShell
window**, not this app's terminal or an agent tool running inside the app:

```powershell
just update
```

`just update-check` checks prerequisites and current blockers without building or changing processes.
Without `just`, use `pwsh -NoProfile -File .\scripts\update-desktop.ps1`.

The updater checks process ancestry and the owner of port 3847, rejects queued/background work and
visible terminal child programs, prebuilds the frontend/daemon, then requests a **non-forced** drain
and terminal checkpoint. A blocked drain is cancelled without closing the app. It stops only the
identified app/daemon processes from this checkout, builds the matching desktop bundle, reopens it,
and waits for runtime readiness. It does not install dependencies or commit/push changes.

The update closes all desktop windows from this checkout. Unsent drafts and shell variables are
not preserved; terminal CWD and scrollback are checkpointed into fresh shells. Process checks cannot
detect all in-process shell work, so finish terminal work first. If a build fails, the command stops
with the error instead of launching a potentially incomplete update. Fix the error and rerun it.
If preparation itself errors or times out, no app/daemon process is killed; use **Cancel drain** in
Runtime maintenance if new prompts remain paused. Authenticated listeners use
`COPILOT_SESSIONS_TOKEN` from the external terminal's environment.

## Prerequisites

- Rust 1.94+
- Node.js 24+ (including the built-in TypeScript-aware test runner)
- A GitHub Copilot subscription and authenticated Copilot CLI environment
- Tauri platform prerequisites for desktop builds

The official Rust Copilot SDK bundles its compatible CLI by default.
This may differ from the separately installed `copilot` executable. Runtime maintenance exposes
runtime provenance and startup timings; do not assume a CLI update changes the bundled runtime.
Plan and Autopilot use native session modes, but a mode transition requiring a compaction
confirmation is not yet supported. The client displays the limitation instead of guessing a
confirmation value or starting a follow-up implementation turn automatically.

## Keyboard workflow

The prompt keeps focus while a session runs. Enter submits using the selected delivery mode;
Shift+Enter inserts a newline. Ctrl+Q explicitly queues; Ctrl+Enter steers the running turn.
Tab or Shift+Tab cycles agent modes in the composer. Ctrl+S stashes/restores the draft, Ctrl+R
cycles recent submitted prompts, and F6 / Shift+F6 moves between workspace regions.
Terminal-focused keystrokes stay with the terminal except its explicit toggle shortcut.
Press `?` outside text inputs for the shortcut list. Touch controls remain available.

## Regression tests

```powershell
npm test
cargo test -p copilot-sessions-core -p copilot-sessionsd
```

`npm run test:ui` exercises a disposable session against an isolated daemon on
`127.0.0.1:3848`, using an installed Microsoft Edge browser. Start that daemon with
`COPILOT_SESSIONS_DATA_DIR` set to a disposable directory and a current web build.
The browser tests submit a small number of model prompts and delete their own session.
They refuse to target the normal app port. The data-directory setting isolates app
metadata and terminal checkpoints, not the SDK's own session store.

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
| `COPILOT_SESSIONS_DATA_DIR` | platform local app data | App metadata and terminal checkpoint directory |
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
