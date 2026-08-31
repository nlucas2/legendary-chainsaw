import { useEffect, useState } from "react";
import {
  CircleStop,
  Plug,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  X,
} from "lucide-react";
import { daemonInvoke } from "../lib/daemon";
import type {
  DrainStatus,
  PrepareRestartResult,
  RuntimeStatus,
} from "../lib/types";

interface RuntimePanelProps {
  onClose: () => void;
  onStatusChange: (status: RuntimeStatus) => void;
}

export function RuntimePanel({ onClose, onStatusChange }: RuntimePanelProps) {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [blockers, setBlockers] = useState<string[]>([]);
  const [blockedAction, setBlockedAction] = useState<"drain" | "prepare" | null>(
    null,
  );

  async function refresh() {
    const next = await daemonInvoke<RuntimeStatus>("runtime_status");
    setStatus(next);
    onStatusChange(next);
  }

  useEffect(() => {
    void refresh().catch((error) => setMessage(String(error)));
  }, []);

  async function run(name: string, action: () => Promise<void>) {
    setBusy(name);
    setMessage("");
    setBlockers([]);
    setBlockedAction(null);
    try {
      await action();
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  }

  async function drain(force: boolean) {
    const result = await daemonInvoke<DrainStatus>("drain_copilot", {
      timeoutSeconds: force ? 3 : 30,
      force,
    });
    if (result.complete) {
      setMessage(
        `Copilot disconnected cleanly from ${result.disconnectedSessions} active session(s). Terminals remain running.`,
      );
    } else {
      setBlockers(result.processingSessions);
      setBlockedAction("drain");
      setMessage("Drain paused: some sessions are still processing.");
    }
  }

  async function prepareRestart(force: boolean) {
    const result = await daemonInvoke<PrepareRestartResult>("prepare_restart", {
      timeoutSeconds: force ? 3 : 30,
      force,
    });
    if (result.drain.complete) {
      setMessage(
        `Safe to restart. Checkpointed ${result.checkpointedTerminals} terminal session(s); Copilot and MCP processes are stopped.`,
      );
    } else {
      setBlockers(result.drain.processingSessions);
      setBlockedAction("prepare");
      setMessage("Restart preparation paused: active work did not drain.");
    }
  }

  return (
    <div className="runtime-backdrop">
      <section className="runtime-panel" aria-label="Runtime maintenance">
        <header>
          <div>
            <span>Explicit lifecycle control</span>
            <h2>Runtime maintenance</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close runtime">
            <X size={18} />
          </button>
        </header>

        <div className="runtime-status-card">
          <div>
            <span className={status?.connected ? "status-dot online" : "status-dot"} />
            <strong>{status?.connected ? "Copilot connected" : "Copilot disconnected"}</strong>
          </div>
          <dl>
            <div>
              <dt>New work</dt>
              <dd>{status?.acceptingWork ? "accepted" : "paused"}</dd>
            </div>
            <div>
              <dt>Attached sessions</dt>
              <dd>{status?.activeSessions ?? "—"}</dd>
            </div>
            <div>
              <dt>Daemon</dt>
              <dd>always on</dd>
            </div>
          </dl>
        </div>

        <div className="runtime-actions">
          <button
            disabled={!!busy || !status?.connected}
            onClick={() =>
              void run("reload", async () => {
                const results = await daemonInvoke<
                  { sessionId: string; success: boolean; error?: string }[]
                >("reload_mcp");
                const failed = results.filter((result) => !result.success);
                setMessage(
                  failed.length
                    ? `Reloaded MCP for ${results.length - failed.length} session(s); ${failed.length} failed.`
                    : `Reloaded MCP servers for ${results.length} active session(s).`,
                );
                setBlockers(failed.map((result) => `${result.sessionId}: ${result.error}`));
              })
            }
          >
            <RefreshCw className={busy === "reload" ? "spin" : ""} size={17} />
            <span>
              <strong>Reload MCP servers</strong>
              <small>No daemon or terminal restart</small>
            </span>
          </button>

          <button
            disabled={!!busy || !status?.connected}
            onClick={() => void run("drain", () => drain(false))}
          >
            <Plug size={17} />
            <span>
              <strong>Drain & disconnect Copilot</strong>
              <small>Stops Copilot and MCP; terminals stay alive</small>
            </span>
          </button>

          <button
            disabled={!!busy || !status?.connected}
            onClick={() =>
              void run("prepare", () =>
                prepareRestart(false),
              )
            }
          >
            <ShieldCheck size={17} />
            <span>
              <strong>Prepare daemon restart</strong>
              <small>Drain, checkpoint terminals, then stop child processes</small>
            </span>
          </button>

          {!status?.connected && (
            <button
              disabled={!!busy}
              onClick={() =>
                void run("connect", async () => {
                  await daemonInvoke("connect_copilot");
                  setMessage("Copilot runtime connected. Sessions resume when opened.");
                })
              }
            >
              <RotateCcw size={17} />
              <span>
                <strong>Reconnect Copilot</strong>
                <small>Starts a fresh CLI runtime</small>
              </span>
            </button>
          )}
        </div>

        {blockers.length > 0 && (
          <div className="runtime-blockers">
            <strong>Still processing</strong>
            {blockers.map((blocker) => (
              <code key={blocker}>{blocker}</code>
            ))}
            <button
              disabled={!!busy}
              onClick={() => {
                if (
                  window.confirm(
                    "Force interruption? Active turns will be aborted before disconnect.",
                  )
                ) {
                  if (blockedAction === "prepare") {
                    void run("force", () => prepareRestart(true));
                  } else {
                    void run("force", () => drain(true));
                  }
                }
              }}
            >
              <CircleStop size={14} /> Force disconnect
            </button>
            <button
              disabled={!!busy}
              onClick={() =>
                void run("cancel", async () => {
                  await daemonInvoke("cancel_drain");
                  setMessage("Drain cancelled; new Copilot work is accepted again.");
                })
              }
            >
              Cancel drain
            </button>
          </div>
        )}
        {message && <div className="runtime-message">{message}</div>}
        <footer>
          Closing this app never stops the daemon. Only the explicit actions above stop
          Copilot, MCP, or terminal child processes.
        </footer>
      </section>
    </div>
  );
}
