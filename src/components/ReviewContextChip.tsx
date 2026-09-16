import { MessageSquareText, X } from "lucide-react";
import { useMemo } from "react";
import type { ReviewChatContext } from "../lib/reviewChat";
import "./review-workflow.css";

export function ReviewContextChip({ context, onRemove }: { context: ReviewChatContext; onRemove?: () => void }) {
  const size = useMemo(() => Math.max(1, Math.ceil(new TextEncoder().encode(context.text).length / 1024)), [context.text]);
  return <div className="review-context-chip">
    <details>
      <summary><MessageSquareText size={14} /><span>{context.label}</span>
        <small>{size} KiB</small></summary>
      <p>Saved review context. It will be included when you explicitly send your question.</p>
      {context.repository && <p>Repository: {context.repository}</p>}
      <pre>{context.text}</pre>
    </details>
    {onRemove && <button type="button" aria-label={`Remove review context ${context.label}`} onClick={onRemove}><X size={14} /></button>}
  </div>;
}
