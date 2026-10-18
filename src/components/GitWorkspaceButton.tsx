import { useEffect, useState } from "react";
import { GitCompareArrows } from "lucide-react";
import { daemonInvoke } from "../lib/daemon";

export function GitWorkspaceButton({ sessionId, cwd, onOpen }: { sessionId: string; cwd: string; onOpen: () => void }) {
  const [state, setState] = useState<{ repo?: boolean; error?: string }>({});
  useEffect(() => {
    const controller = new AbortController();
    setState({});
    void daemonInvoke<{ isRepository: boolean }>("git_repository", { sessionId }, controller.signal)
      .then((result) => {
        if (typeof result.isRepository !== "boolean") throw new Error("Git discovery returned no repository status.");
        if (!controller.signal.aborted) setState({ repo: result.isRepository });
      }).catch((cause) => {
        if (!controller.signal.aborted) setState({ error: String(cause) });
      });
    return () => controller.abort();
  }, [sessionId, cwd]);
  return <button type="button" className="icon-button workspace-primary-action" aria-label="Open Git workspace"
    title={state.error ? `Git discovery failed: ${state.error}. Open for details or retry.`
      : state.repo === false ? "This session directory is not in a Git working tree. Open Git to add another working path."
      : "Inspect local changes in this session directory or another working path"}
    onClick={onOpen}>
    <GitCompareArrows size={16} />
    <span className="desktop-label">{state.error ? "Git unavailable" : state.repo === false ? "No repo" : "Git"}</span>
    <span className="mobile-only">Git</span>
  </button>;
}
