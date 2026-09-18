import { RefreshCw } from "lucide-react";
import { startupStageLabel } from "../lib/sessionStartup";
import type { SessionInitialization } from "../lib/types";
import "./session-startup.css";

export function SessionStartupBanner({ initialization, error, connected, retrying, onRetry }: {
  initialization: SessionInitialization;
  error?: string;
  connected: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  const failed = initialization.phase === "failed";
  return <section className="session-startup" aria-label="Session startup" role={failed || error ? "alert" : "status"}>
    {!failed && <RefreshCw size={16} className="spin" />}
    <div>
      <strong>{!connected ? "Reconnect to check session startup" : startupStageLabel(initialization)}</strong>
      <p>{failed ? "The session was created, but startup did not finish. Retry this session without creating another."
        : "Your new workspace is open. You can write a draft while setup continues; sending is enabled when the session is ready."}</p>
      {initialization.error && <p>{initialization.error}</p>}
      {error && <p>{error}</p>}
    </div>
    {failed && <button type="button" className="button secondary" disabled={!connected || retrying} onClick={onRetry}>
      {retrying ? "Retrying..." : "Retry initialization"}
    </button>}
  </section>;
}
