import { formatAiCredits, type SessionUsage } from "../lib/sessionUsage";

export function SessionUsageSummary({ usage }: { usage: SessionUsage }) {
  return <section className="ct-budget" aria-label="Session AI credits">
    <dl className="ct-budget-grid">
      <div><dt>AI credits used</dt><dd>{formatAiCredits(usage.totalNanoAiu)}</dd></div>
    </dl>
    <p className="ct-help">{usage.totalNanoAiu === null
      ? "The runtime has not reported an AI-credit total for this session. Token counts and premium-request multipliers are not AI credits."
      : "Reported session total, including subagents. This is not your account balance or remaining quota. Values can lag active model calls."}</p>
  </section>;
}
