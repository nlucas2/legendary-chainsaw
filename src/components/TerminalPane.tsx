import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ChevronDown, Link2, LockKeyhole, Power, Unlink, Users, X } from "lucide-react";
import { daemonClientId, daemonWebSocketUrl } from "../lib/daemon";
import type { TerminalServerMessage } from "../lib/types";

interface TerminalPaneProps {
  sessionId: string;
  cwd: string;
  followCwd: boolean;
  onFollowCwdChange: (value: boolean) => void;
  onCwdChange: (cwd: string) => void;
  onClose: () => void;
}

export function TerminalPane({
  sessionId,
  cwd,
  followCwd,
  onFollowCwdChange,
  onCwdChange,
  onClose,
}: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const replayingRef = useRef(false);
  const followCwdRef = useRef(followCwd);
  const onCwdChangeRef = useRef(onCwdChange);
  const [terminalCwd, setTerminalCwd] = useState(cwd);
  const [shell, setShell] = useState("terminal");
  const [connected, setConnected] = useState(false);
  const [restored, setRestored] = useState(false);
  const [hasControl, setHasControl] = useState(false);
  const [viewers, setViewers] = useState(1);
  const initialCwd = useRef(cwd);
  const clientId = useRef(daemonClientId());

  useEffect(() => {
    followCwdRef.current = followCwd;
    onCwdChangeRef.current = onCwdChange;
  }, [followCwd, onCwdChange]);

  useEffect(() => {
    if (!hostRef.current) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: "'Cascadia Code', 'SFMono-Regular', Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.18,
      theme: terminalTheme(),
    });
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
      socket.close();
      terminal.dispose();
      socketRef.current = null;
    };
  }, [sessionId]);

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
      <div className="terminal-host" ref={hostRef} />
    </section>
  );
}

function terminalTheme() {
  const style = getComputedStyle(document.documentElement);
  const light = document.documentElement.dataset.theme === "light";
  return {
    background: style.getPropertyValue("--bg").trim() || "#0b0f14",
    foreground: style.getPropertyValue("--text").trim() || "#d8dee9",
    cursor: style.getPropertyValue("--accent-bright").trim() || "#7dd3fc",
    selectionBackground: light ? "#d9cba9" : "#334155",
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
