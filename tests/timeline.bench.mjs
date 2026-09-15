import { performance } from "node:perf_hooks";
import { projectTimeline } from "../src/lib/timeline.ts";

let sequence = 0;
const event = (type, data = {}) => ({
  id: `bench-${++sequence}`, type, data, timestamp: "2026-09-04T00:00:00Z",
});
const history = [];
for (let turn = 0; turn < 1500; turn += 1) {
  history.push(
    event("user.message", { content: `Prompt ${turn}` }),
    event("assistant.turn_start"),
    event("assistant.reasoning_delta", { reasoningId: `r-${turn}`, content: "Reasoning **markdown** ".repeat(20) }),
    event("assistant.reasoning", { reasoningId: `r-${turn}`, content: "Reasoning **markdown** ".repeat(20) }),
    event("tool.execution_start", { toolCallId: `t-${turn}`, arguments: { path: `file-${turn}` } }),
    event("tool.execution_complete", { toolCallId: `t-${turn}`, result: "Completed" }),
    event("assistant.message", { messageId: `m-${turn}`, content: "Response ".repeat(20) }),
    event("assistant.turn_end"),
  );
}
history.push(event("user.message", { content: "Active prompt" }),
  event("assistant.turn_start"),
  event("assistant.message_delta", { messageId: "active", content: "Live" }));
const initial = projectTimeline(undefined, history);
const count = 150;
const batches = Array.from({ length: count }, () =>
  event("assistant.message_delta", { messageId: "active", deltaContent: " token" }));
function measure(incremental) {
  let projection = initial;
  let events = history;
  const start = performance.now();
  for (const delta of batches) {
    events = [...events, delta];
    projection = projectTimeline(incremental ? projection : undefined, events);
  }
  return { ms: performance.now() - start, projection };
}
measure(true);
const incremental = measure(true);
const rebuilt = measure(false);
const retained = initial.items.filter((item, index) => incremental.projection.items[index] === item).length;
console.log(JSON.stringify({
  description: "Node projection CPU only; not React rendering or WebView layout/paint",
  historyEvents: history.length,
  batches: count,
  incrementalMs: Number(incremental.ms.toFixed(2)),
  fullProjectionMs: Number(rebuilt.ms.toFixed(2)),
  completedEntriesRetained: retained,
  initialEntries: initial.items.length,
}, null, 2));
