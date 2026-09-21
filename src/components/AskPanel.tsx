import { useEffect, useRef, useState } from "react";
import { MarkdownContent } from "./MarkdownContent";
import { askRequests, normalizeAskResult } from "../lib/ask";
import { daemonInvoke } from "../lib/daemon";
import { submitsComposer } from "../lib/composerInput";
import { useMobileInput } from "../lib/useMobileInput";
import { continueReviewConversation, quickAskQuestion, type ReviewChatContext } from "../lib/reviewChat";
import { ReviewContextChip } from "./ReviewContextChip";
import "./ask-panel.css";

export interface AskPanelProps {
  sessionId: string;
  onClose: () => void;
  initialQuestion?: string;
  /** Only set for an explicit submitted /ask command, never a suggested question. */
  submitOnOpen?: boolean;
  reviewContext?: ReviewChatContext;
  onContinue?: (context: ReviewChatContext) => void;
}

export function AskPanel(props: AskPanelProps) {
  return <SessionAskPanel key={props.sessionId} {...props} />;
}

function SessionAskPanel({ sessionId, onClose, initialQuestion = "", submitOnOpen = false, reviewContext, onContinue }: AskPanelProps) {
  const [question, setQuestion] = useState(initialQuestion);
  const mobileInput = useMobileInput();
  const [submittedQuestion, setSubmittedQuestion] = useState("");
  const [submittedContext, setSubmittedContext] = useState<ReviewChatContext>();
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const initialSubmitted = useRef(false);
  const inFlight = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);

  async function submit(text: string) {
    if (inFlight.current || !text.trim()) return;
    let token: symbol;
    try { token = askRequests.start(sessionId, text); }
    catch (cause) { setError(String(cause)); return; }
    inFlight.current = true;
    setBusy(true);
    setError("");
    setAnswer(null);
    setSubmittedQuestion(text.trim());
    setSubmittedContext(reviewContext);
    try {
      // No AbortController: closing this transient view must not abort its parent
      // or pretend the native query supports cancellation.
      const result = normalizeAskResult(await daemonInvoke("ask_session", {
        sessionId, question: quickAskQuestion(text.trim(), reviewContext),
      }), sessionId);
      if (mounted.current) setAnswer(result.answer);
    } catch (cause) {
      if (mounted.current) setError(String(cause));
    } finally {
      askRequests.finish(sessionId, token);
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    input.current?.focus();
    if (submitOnOpen && !initialSubmitted.current && initialQuestion.trim()) {
      initialSubmitted.current = true;
      void submit(initialQuestion);
    }
    return () => { mounted.current = false; };
  }, []);

  return <section className="ask-panel" aria-label="Ask about this conversation"
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <header className="ask-panel-header">
      <div><h2>/ask</h2><span>Transient · read-only</span></div>
      <button type="button" className="button secondary" onClick={onClose}
        title={busy ? "Close this panel. The query continues; the parent is not stopped." : "Close this transient answer"}>Close</button>
    </header>
    <p className="ask-panel-note">Ask a question using the current conversation context. No tools run and nothing is added to conversation history.</p>
    {reviewContext && <ReviewContextChip context={reviewContext} />}
    <form onSubmit={(event) => { event.preventDefault(); void submit(question); }}>
      <label htmlFor={`ask-question-${sessionId}`}>Question</label>
      <textarea ref={input} id={`ask-question-${sessionId}`} value={question} disabled={busy}
        placeholder="Ask about this conversation…" rows={3} enterKeyHint={mobileInput ? "enter" : "send"}
        onChange={(event) => setQuestion(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (submitsComposer({ ...event, isComposing: event.nativeEvent.isComposing }, mobileInput)) {
            event.preventDefault();
            void submit(question);
          }
        }} />
      <div className="ask-panel-actions">
        <small>{mobileInput ? "Enter for a new line · tap Ask" : "Enter to ask · Shift+Enter for a new line"}</small>
        <button type="submit" className="button primary" disabled={busy || !question.trim()}>
          {busy ? "Asking…" : "Ask"}
        </button>
      </div>
    </form>
    {busy && <div className="ask-panel-pending" role="status">
      <p>Waiting for the complete answer. This runtime cannot safely correlate live query chunks.</p>
      <button type="button" className="button secondary" disabled
        title="The native query API does not expose cancellation. Closing does not stop the parent.">Cancel unavailable</button>
    </div>}
    {error && <p className="ask-panel-error" role="alert">{error}</p>}
    {answer !== null && <article className="ask-panel-answer" aria-label="Transient answer" tabIndex={0}>
      <h3>Answer</h3>
      <p className="ask-panel-question">{submittedQuestion}</p>
      {answer ? <MarkdownContent>{answer}</MarkdownContent>
        : <p>The runtime returned an empty answer.</p>}
      {onContinue && <button type="button" className="button secondary" onClick={() => {
        try {
          onContinue(continueReviewConversation(submittedQuestion, answer, submittedContext));
          setError("");
        } catch (cause) { setError(String(cause)); }
      }}>Continue in chat</button>}
    </article>}
    <footer>This answer is not a saved chat. Continue in chat attaches this question and answer to a normal draft for explicit submission. Closing without continuing discards the displayed answer.</footer>
  </section>;
}
