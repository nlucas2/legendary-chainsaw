import { useState } from "react";
import { GitBranch, LoaderCircle } from "lucide-react";
import { activeAgent, visibleAgents, type AgentTask } from "../lib/agentTasks";
import type { AgentTaskState } from "../lib/useAgentTasks";
import "./subagent-navigation.css";

export function SessionSubagents({ sessionId, state, selectedId, onSelect, onRefresh, canRefresh }: {
  sessionId: string;
  state?: AgentTaskState;
  selectedId?: string;
  onSelect: (task: AgentTask) => void;
  onRefresh: () => void;
  canRefresh: boolean;
}) {
  const [showFinished, setShowFinished] = useState(false);
  const tasks = state?.data?.tasks ?? [];
  const visible = visibleAgents(tasks, showFinished, selectedId);
  return <div className="session-subagents" id={`subagents-${sessionId}`} aria-label="Session subagents">
    <div className="session-subagents-heading">
      <span>{state?.data ? `${tasks.filter(activeAgent).length} active subagents` : "Subagents"}</span>
      <button type="button" onClick={onRefresh} disabled={state?.loading || !canRefresh} aria-label="Refresh subagents">
        {state?.loading ? <LoaderCircle className="spin" size={12} /> : "Refresh"}
      </button>
    </div>
    <label className="subagent-filter"><input type="checkbox" checked={showFinished}
      onChange={(event) => setShowFinished(event.target.checked)} />Show finished</label>
    {!state?.data && state?.loading && <p role="status">Reading subagents...</p>}
    {state?.error && <p role="alert">{state.error}</p>}
    {state?.data && !visible.length && <p>No {showFinished ? "" : "active "}subagents in this session.</p>}
    <ul>
      {visible.map((task) => <li key={task.id}>
        <button type="button" className={selectedId === task.id ? "subagent-link selected" : "subagent-link"}
          aria-current={selectedId === task.id ? "page" : undefined}
          data-task-id={task.id} onClick={() => onSelect(task)}>
          <GitBranch size={13} />
          <span><strong>{task.name}</strong><small>{task.status}{task.model ? ` · ${task.model}` : ""}</small></span>
        </button>
      </li>)}
    </ul>
  </div>;
}
