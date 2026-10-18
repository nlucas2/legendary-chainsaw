import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ChevronDown, Copy, Link2, LockKeyhole, Power, Unlink, Users, X } from "lucide-react";
import { daemonClientId, daemonWebSocketUrl } from "../lib/daemon";
import type { TerminalServerMessage } from "../lib/types";
import { normalizeTypography, terminalTypography, type TypographySettings } from "../lib/typography";
import { isTerminalCopy } from "../lib/shortcuts";

interface TerminalPaneProps {
  sessionId: string;
  cwd: string;
  followCwd: boolean;
  onFollowCwdChange: (value: boolean) => void;
  onCwdChange: (cwd: string) => void;
  onClose: () => void;
  typography?: TypographySettings;
  autoFocus?: boolean;
  onAutoFocus?: () => void;
}

export function TerminalPane({
  sessionId,
  cwd,
  followCwd,
  onFollowCwdChange,
  onCwdChange,
  onClose,
  typography,
  autoFocus = false,
  onAutoFocus,
}: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fontOptions = terminalTypography(normalizeTypography(typography));
  const fontOptionsRef = useRef(fontOptions);
  fontOptionsRef.current = fontOptions;
  const replayingRef = useRef(false);
  const followCwdRef = useRef(followCwd);
  const onCwdChangeRef = useRef(onCwdChange);
  const [terminalCwd, setTerminalCwd] = useState(cwd);
  const [shell, setShell] = useState("terminal");
  const [connected, setConnected] = useState(false);
  const [restored, setRestored] = useState(false);
  const [hasControl, setHasControl] = useState(false);
  const [viewers, setViewers] = useState(1);
  const [selectionAvailable, setSelectionAvailable] = useState(false);
  const [clipboardError, setClipboardError] = useState("");
  const copyPending = useRef(false);
  const initialCwd = useRef(cwd);
  const clientId = useRef(daemonClientId());

  useEffect(() => {
    followCwdRef.current = followCwd;
    onCwdChangeRef.current = onCwdChange;
  }, [followCwd, onCwdChange]);

  async function copySelection(terminal: Terminal) {
    const text = terminal.getSelection();
    if (!text || copyPending.current) return;
    copyPending.current = true;
    setClipboardError("");
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard access is unavailable. Use the desktop app or an HTTPS/localhost connection.");
      }
      await navigator.clipboard.writeText(text);
    } catch (cause) {
      if (terminalRef.current === terminal) setClipboardError(`Could not copy terminal selection: ${String(cause)}`);
    } finally { copyPending.current = false; }
  }

  useEffect(() => {
    if (!hostRef.current) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      ...fontOptionsRef.current,
      theme: terminalTheme(),
    });
    terminalRef.current = terminal;
    terminal.attachCustomKeyEventHandler((event) => {
      if (!isTerminalCopy(event, terminal.hasSelection())) return true;
      event.preventDefault();
      event.stopPropagation();
      if (event.type === "keydown" && !event.repeat) void copySelection(terminal);
      return false;
    });
    const selectionDisposable = terminal.onSelectionChange(() => setSelectionAvailable(terminal.hasSelection()));
    const fit = new FitAddon();
    fitRef.current = fit;
    terminal.loadAddon(fit);
    terminal.open(hostRef.current);
    fit.fit();

    const url = new URL(daemonWebSocketUrl("/api/terminal"));
    url.searchParams.set("sessionId", sessionId);
    url.searchParams.set("clientId", clientId.current);
    url.searchParams.set("cwd", initialCwd.current);
    url.searchParams.set("cols", String(terminal.cols));
    url.searchParams.set("rows", String(terminal.rows));
    const socket = new WebSocket(url);
    socketRef.current = socket;
    socket.onmessage = (raw) => {
      const message = JSON.parse(raw.data) as TerminalServerMessage;
      switch (message.type) {
        case "ready":
          setConnected(true);
          setShell(message.shell);
          setTerminalCwd(message.cwd);
          setRestored(message.restored);
          setHasControl(message.hasControl);
          setViewers(message.viewers);
          terminal.options.disableStdin = !message.hasControl;
          break;
        case "output":
          terminal.write(message.data);
          break;
        case "snapshot":
          replayingRef.current = true;
          terminal.write(message.data, () => {
            replayingRef.current = false;
          });
          break;
        case "cwd":
          setTerminalCwd(message.cwd);
          if (followCwdRef.current) onCwdChangeRef.current(message.cwd);
          break;
        case "control_changed": {
          const ownsControl = message.controller === clientId.current;
          setHasControl(ownsControl);
          setViewers(message.viewers);
          terminal.options.disableStdin = !ownsControl;
          break;
        }
        case "error":
          terminal.writeln(`\r\n\x1b[31m${message.message}\x1b[0m`);
          break;
        case "exit":
          setConnected(false);
          terminal.writeln("\r\n\x1b[90m[process exited]\x1b[0m");
          break;
      }
    };
    socket.onclose = () => setConnected(false);
    const dataDisposable = terminal.onData((data) => {
      if (replayingRef.current) return;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data }));
      }
    });
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(hostRef.current);
    const updateTheme = () => {
      terminal.options.theme = terminalTheme();
    };
    window.addEventListener("copilot-sessions-theme", updateTheme);

    return () => {
      observer.disconnect();
      window.removeEventListener("copilot-sessions-theme", updateTheme);
      dataDisposable.dispose();
      resizeDisposable.dispose();
      selectionDisposable.dispose();
      socket.close();
      terminal.dispose();
      socketRef.current = null;
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!autoFocus || !terminalRef.current) return;
    terminalRef.current.focus();
    onAutoFocus?.();
  }, [autoFocus, onAutoFocus, sessionId]);

  // Font changes resize the existing terminal; they never recreate the socket or PTY.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (terminal.options.fontFamily !== fontOptions.fontFamily) terminal.options.fontFamily = fontOptions.fontFamily;
    if (terminal.options.fontSize !== fontOptions.fontSize) terminal.options.fontSize = fontOptions.fontSize;
    if (terminal.options.lineHeight !== fontOptions.lineHeight) terminal.options.lineHeight = fontOptions.lineHeight;
    const frame = requestAnimationFrame(() => {
      if (terminalRef.current !== terminal) return;
      fitRef.current?.fit();
      terminal.refresh(0, terminal.rows - 1);
    });
    return () => cancelAnimationFrame(frame);
  }, [sessionId, fontOptions.fontFamily, fontOptions.fontSize, fontOptions.lineHeight]);

  return (
    <section className="terminal-pane" aria-label="Terminal">
      <header className="terminal-header">
        <div className="terminal-title">
          <span className={connected ? "status-dot online" : "status-dot"} />
          <strong>{shell}</strong>
          {restored && <span className="terminal-restored">restored</span>}
          <span className="terminal-viewers" title={`${viewers} attached client(s)`}>
            <Users size={12} /> {viewers}
          </span>
          <ChevronDown size={13} />
        </div>
        <div className="terminal-actions">
          <button type="button" className="icon-button" disabled={!selectionAvailable}
            title="Copy terminal selection (Ctrl+C / Cmd+C)" aria-label="Copy terminal selection"
            onClick={() => { if (terminalRef.current) void copySelection(terminalRef.current); }}>
            <Copy size={14} />
          </button>
          <button
            className={hasControl ? "icon-button active" : "icon-button"}
            title={hasControl ? "Release terminal control" : "Take terminal control"}
            onClick={() =>
              socketRef.current?.send(
                JSON.stringify({
                  type: hasControl ? "release_control" : "request_control",
                }),
              )
            }
          >
            <LockKeyhole size={14} />
            <span>{hasControl ? "Controlling" : "Read only"}</span>
          </button>
          <button
            className={followCwd ? "icon-button active" : "icon-button"}
            title={
              followCwd
                ? "Copilot session tracks this terminal's CWD"
                : "CWD tracking is off"
            }
            onClick={() => onFollowCwdChange(!followCwd)}
          >
            {followCwd ? <Link2 size={15} /> : <Unlink size={15} />}
            <span>Track CWD</span>
          </button>
          <button
            className="icon-button"
            title="Terminate this session's terminal"
            onClick={() => {
              if (!hasControl) return;
              if (
                window.confirm(
                  "Terminate this terminal process? Its environment will be discarded.",
                )
              ) {
                socketRef.current?.send(JSON.stringify({ type: "terminate" }));
              }
            }}
          >
            <Power size={15} />
          </button>
          <button className="icon-button" title="Close terminal" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
      </header>
      <div className="terminal-cwd" title={terminalCwd}>
        {terminalCwd}
      </div>
      {clipboardError && <p className="terminal-clipboard-error" role="alert">{clipboardError}</p>}
      <div className="terminal-host" ref={hostRef} />
    </section>
  );
}

function terminalTheme() {
  const style = getComputedStyle(document.documentElement);
  const light = document.documentElement.dataset.theme === "light";
  return {
    background: style.getPropertyValue("--bg").trim() || "#1e1e2e",
    foreground: style.getPropertyValue("--text").trim() || "#d8dee9",
    cursor: style.getPropertyValue("--accent-bright").trim() || "#7dd3fc",
    selectionBackground: style.getPropertyValue("--selection").trim() || (light ? "#ccdcf3" : "#354766"),
    black: light ? "#4c4636" : "#111827",
    brightBlack: light ? "#857a5f" : "#64748b",
    blue: light ? "#1e66f5" : "#60a5fa",
    brightBlue: light ? "#3b6ea5" : "#93c5fd",
    cyan: light ? "#179299" : "#22d3ee",
    green: light ? "#40a02b" : "#34d399",
    magenta: light ? "#8839ef" : "#c084fc",
    red: light ? "#d20f39" : "#fb7185",
    white: light ? "#f7f1e3" : "#e2e8f0",
    yellow: light ? "#df8e1d" : "#fbbf24",
  };
}
