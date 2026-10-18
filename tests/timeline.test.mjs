import test from "node:test";
import assert from "node:assert/strict";
import { decodeAttachmentImage, projectTimeline } from "../src/lib/timeline.ts";

let sequence = 0;
const event = (type, data = {}, extra = {}) => ({
  id: `event-${++sequence}`, type, data, timestamp: "2026-09-04T00:00:00Z", ...extra,
});
const visible = (projection) => projection.items.filter((item) =>
  !item.hidden && (!["message", "reasoning"].includes(item.kind) || item.content.trim() || item.attachments?.length));
const reasoning = (projection) => visible(projection).filter((item) => item.kind === "reasoning");
const messages = (projection) => visible(projection).filter((item) =>
  item.kind === "message" && item.role === "assistant");
const append = (projection, ...events) =>
  projectTimeline(projection, [...projection.events, ...events], projection.options);
const project = (events, options) => projectTimeline(undefined, events, options);
function replay(events, options) {
  let state = project([], options);
  for (const next of events) state = append(state, next);
  assert.deepEqual(state.items, project(events, options).items);
  return state;
}
function freezeItems(items) {
  for (const item of items) {
    if (item.progress) Object.freeze(item.progress);
    if (item.timeline) freezeItems(item.timeline);
    Object.freeze(item);
  }
  Object.freeze(items);
}

test("interleaved reasoning final representations do not duplicate or move behind answer", () => {
  const events = [
    event("user.message", { content: "Help" }),
    event("assistant.turn_start"),
    event("assistant.reasoning_delta", { reasoningId: "r", deltaContent: "First " }),
    event("assistant.message_delta", { messageId: "comment", deltaContent: "Checking." }),
    event("tool.execution_start", { toolCallId: "t", toolName: "inspect" }),
    event("assistant.reasoning_delta", { reasoningId: "r", deltaContent: "second." }),
    event("assistant.reasoning", { reasoningId: "r", content: "First second." }),
    event("assistant.message_delta", { messageId: "answer", deltaContent: "Done." }),
    event("assistant.message", { messageId: "answer", content: "Done.", reasoningText: "First second." }),
    event("assistant.turn_end"),
  ];
  const result = replay(events);
  assert.deepEqual(visible(result).map((item) => item.kind),
    ["message", "reasoning", "message", "tool", "reasoning", "message"]);
  assert.deepEqual(reasoning(result).map((item) => item.content), ["First ", "second."]);
  assert.ok(reasoning(result).every((item) => !item.streaming));
  assert.deepEqual(visible(result).filter((item) => item.turnLead).map((item) => item.kind), ["reasoning"]);
});

test("user-role source attribution survives live projection, replay and nested children", () => {
  const result = replay([
    event("user.message", { content: "Human input" }),
    event("user.message", { content: "Agent follow-up", source: "agent-parent" }),
    event("user.message", { content: "Skill context", source: "skill-pdf" }),
    event("subagent.started", { agentName: "Builder" }, { agentId: "child" }),
    event("user.message", { content: "Child instruction", source: "agent-parent" }, { agentId: "child" }),
    event("user.message", { content: "Legacy child input" }, { agentId: "child" }),
  ]);
  assert.deepEqual(result.items.slice(0, 3).map((item) => item.userOrigin.kind), ["human", "agent", "skill"]);
  assert.deepEqual(result.items[3].timeline.map((item) => item.userOrigin.kind), ["agent", "unknown"]);
});

test("switching to a focused child scope invalidates attribution in the projection cache", () => {
  const events = [event("user.message", { content: "Sender unavailable" })];
  const root = project(events);
  assert.equal(root.items[0].userOrigin.kind, "human");
  const child = projectTimeline(root, events, { subagentConversation: true });
  assert.equal(child.items[0].userOrigin.kind, "unknown");
  assert.equal(root.items[0].userOrigin.kind, "human");
  assert.equal(projectTimeline(child, events, {}).items[0].userOrigin.kind, "human");
});

test("distinct reasoning in later model cycles remains before the corresponding response", () => {
  const result = replay([
    event("user.message", { content: "Help" }),
    event("assistant.turn_start"),
    event("assistant.reasoning", { content: "First cycle." }),
    event("assistant.message", { messageId: "a", content: "Checking.", reasoningText: "First cycle." }),
    event("assistant.turn_end"),
    event("tool.execution_start", { toolCallId: "t" }),
    event("assistant.turn_start"),
    event("assistant.message_delta", { messageId: "b", content: "Final." }),
    event("assistant.message", { messageId: "b", content: "Final.", reasoningText: "Different cycle." }),
    event("assistant.turn_end"),
  ]);
  assert.deepEqual(reasoning(result).map((item) => item.content), ["First cycle.", "Different cycle."]);
  assert.equal(visible(result).at(-2).content, "Different cycle.");
  assert.equal(visible(result).at(-1).content, "Final.");
  assert.equal(visible(result).filter((item) => item.turnLead).length, 1);
});

test("an unkeyed repeated early summary never erases distinct later reasoning", () => {
  const result = replay([
    event("assistant.reasoning_delta", { reasoningId: "r1", content: "First reasoning." }),
    event("assistant.message", { content: "Commentary" }),
    event("assistant.reasoning_delta", { reasoningId: "r2", content: "Later distinct reasoning." }),
    event("assistant.message", { content: "Answer", reasoningText: "First reasoning." }),
  ]);
  assert.deepEqual(reasoning(result).map((item) => item.content),
    ["First reasoning.", "Later distinct reasoning."]);
  assert.equal(visible(result).at(-1).content, "Answer");
});

test("summary-only final appears before response and claims the turn avatar", () => {
  const result = replay([
    event("assistant.message_start", { messageId: "a" }),
    event("assistant.message_delta", { messageId: "a", content: "Answer" }),
    event("assistant.message", { messageId: "a", content: "Answer", reasoningText: "Visible summary." }),
  ]);
  assert.deepEqual(visible(result).map((item) => item.kind), ["reasoning", "message"]);
  assert.equal(reasoning(result)[0].turnLead, true);
  assert.equal(messages(result)[0].turnLead, false);
});

test("tool-first responses own the assistant heading during streaming and replay", () => {
  const events = [
    event("session.start", { model: "historical-model" }),
    event("user.message", { content: "Inspect this" }),
    event("assistant.turn_start"),
    event("assistant.tool_call_delta", { toolCallId: "view", toolName: "view", inputDelta: '{"path":' }),
    event("tool.execution_start", { toolCallId: "view", toolName: "view", arguments: { path: "file.txt" } }),
    event("tool.execution_complete", { toolCallId: "view", success: true, result: "Read" }),
    event("tool.execution_start", { toolCallId: "shell", toolName: "powershell" }),
    event("assistant.turn_end"),
    event("assistant.turn_start"),
    event("assistant.reasoning", { content: "Summary after inspecting." }),
    event("assistant.message", { content: "Done", model: "historical-model" }),
  ];
  const result = replay(events);
  assert.deepEqual(project(events, { assistantModel: "different-current-picker" }).items, result.items);
  assert.deepEqual(visible(result).filter((item) => item.turnLead).map((item) => [item.kind, item.model]),
    [["tool", "historical-model"]]);
  assert.equal(messages(result)[0].turnLead, false);
  assert.equal(reasoning(result)[0].turnLead, false);
  const toolOnly = replay([
    event("user.message", { content: "Do it" }),
    event("tool.execution_start", { toolCallId: "t", toolName: "view" }),
  ]);
  assert.equal(toolOnly.items[1].turnLead, true);
  assert.equal(toolOnly.items[1].model, undefined);
  assert.equal(messages(toolOnly).length, 0);
  const live = append(project([], { assistantModel: "live-model" }),
    event("user.message", { content: "Live prompt" }),
    event("tool.execution_start", { toolCallId: "live", toolName: "view" }));
  assert.equal(live.items[1].model, "live-model");
});

test("tool heading model provenance uses explicit response data without backfilling older turns", () => {
  const result = replay([
    event("user.message", { content: "Old" }),
    event("tool.execution_start", { toolCallId: "old", toolName: "view" }),
    event("assistant.message", { content: "Old answer" }),
    event("user.message", { content: "New" }),
    event("assistant.turn_start"),
    event("tool.execution_start", { toolCallId: "new", toolName: "view" }),
    event("assistant.message", { content: "New answer", model: "reported-model" }),
  ]);
  const tools = result.items.filter((item) => item.kind === "tool");
  assert.equal(tools[0].model, undefined);
  assert.equal(tools[1].model, "reported-model");
  assert.ok(tools.every((item) => item.turnLead));
});

test("discarded leading text transfers its heading to the earlier tool instead of the later answer", () => {
  const result = replay([
    event("assistant.message_delta", { messageId: "draft", content: "Discard" }),
    event("tool.execution_start", { toolCallId: "view", toolName: "view" }),
    event("assistant.message_delta", { messageId: "draft", content: "More discarded text" }),
    event("assistant.message", { messageId: "draft", content: "Replacement" }),
  ]);
  assert.deepEqual(visible(result).filter((item) => item.turnLead).map((item) => item.kind), ["tool"]);
  assert.equal(messages(result)[0].content, "Replacement");
  assert.equal(messages(result)[0].turnLead, false);
});

test("subagent-first activity starts the parent response and child tools use their own model", () => {
  const result = replay([
    event("session.start", { model: "parent-model" }),
    event("user.message", { content: "Delegate this" }),
    event("subagent.started", { agentName: "Builder", model: "child-model" }, { agentId: "child" }),
    event("user.message", { content: "Child instructions" }, { agentId: "child" }),
    event("tool.execution_start", { toolCallId: "child-view", toolName: "view" }, { agentId: "child" }),
    event("assistant.message", { content: "Child answer" }, { agentId: "child" }),
    event("assistant.message", { content: "Parent answer" }),
  ]);
  const child = result.items.find((item) => item.kind === "subagent");
  assert.equal(child.turnLead, true);
  assert.equal(child.parentModel, "parent-model");
  assert.equal(child.model, "child-model");
  assert.equal(child.timeline[1].turnLead, true);
  assert.equal(child.timeline[1].model, "child-model");
  assert.equal(child.timeline[2].turnLead, false);
  assert.equal(messages(result)[0].turnLead, false);
});

test("actual summary without answer creates reasoning, never a phantom answer", () => {
  const result = replay([
    event("assistant.message", { messageId: "a", content: "", reasoningText: "Visible summary." }),
  ]);
  assert.equal(reasoning(result).length, 1);
  assert.equal(messages(result).length, 0);
});

test("empty reasoning, metadata deltas, message starts and tool-only finals create no bubbles", () => {
  const result = replay([
    event("assistant.turn_start"),
    event("assistant.reasoning_delta", { reasoningId: "r", deltaContent: "" }),
    event("assistant.reasoning_delta", { reasoningId: "r", deltaContent: "  \n" }),
    event("assistant.reasoning", { reasoningId: "r", content: "" }),
    event("assistant.message_start", { messageId: "a" }),
    event("assistant.message_delta", { messageId: "a", deltaContent: "" }),
    event("assistant.streaming_delta", { delta: { role: "assistant" } }),
    event("assistant.message", { messageId: "a", content: "", toolRequests: [{ name: "tool" }] }),
    event("assistant.turn_end"),
  ]);
  assert.deepEqual(result.items, []);
});

test("canonical shorter multi-segment messages replace every draft segment by explicit id", () => {
  const result = replay([
    event("assistant.message_delta", { messageId: "a", deltaContent: "First draft " }),
    event("tool.execution_start", { toolCallId: "t" }),
    event("assistant.message_delta", { messageId: "a", deltaContent: "long tail" }),
    event("assistant.message", { messageId: "a", content: "Short" }),
  ]);
  assert.equal(messages(result).map((item) => item.content).join(""), "Short");
  assert.equal(messages(result).length, 1);
  assert.equal(visible(result).filter((item) => item.kind === "tool").length, 1);
  assert.ok(result.items.filter((item) => item.kind === "message").every((item) => !item.streaming));
});

test("canonical rewritten message and replayed finals never leave a draft or duplicate", () => {
  let result = project([
    event("assistant.message_delta", { messageId: "a", content: "Wrong draft." }),
    event("assistant.reasoning", { content: "Interruption" }),
    event("assistant.message_delta", { messageId: "a", content: "Wrong tail." }),
    event("assistant.message", { messageId: "a", content: "The authoritative text." }),
  ]);
  assert.equal(messages(result).map((item) => item.content).join(""), "The authoritative text.");
  assert.equal(messages(result).length, 1);
  assert.equal(visible(result).at(-1).content, "The authoritative text.");
  const priorItems = result.items;
  result = append(result, event("assistant.message", { messageId: "a", content: "The authoritative text." }));
  assert.equal(result.items, priorItems);
});

test("identical responses across human turns stay distinct; no content-only message dedup", () => {
  const result = replay([
    event("user.message", { content: "First" }),
    event("assistant.message", { messageId: "reused-id", content: "Same" }),
    event("user.message", { content: "Second" }),
    event("assistant.message", { messageId: "reused-id", content: "Same" }),
    event("assistant.message", { content: "Same" }),
  ]);
  assert.equal(messages(result).length, 3);
  assert.notEqual(messages(result)[0].id, messages(result)[1].id);
  assert.equal(messages(result)[0].turnLead, true);
  assert.equal(messages(result)[1].turnLead, true);
});

test("a final without a matching explicit messageId must not replace another stream", () => {
  const result = replay([
    event("assistant.message_delta", { messageId: "draft", content: "Draft" }),
    event("assistant.message", { messageId: "different", content: "Answer" }),
  ]);
  assert.deepEqual(messages(result).map((item) => item.content), ["Draft", "Answer"]);
});

test("empty canonical final removes streamed placeholders or draft content", () => {
  const result = replay([
    event("assistant.message_delta", { messageId: "a", content: "Discard" }),
    event("assistant.message", { messageId: "a", content: "", toolRequests: [{}] }),
  ]);
  assert.equal(messages(result).length, 0);
});

test("leading whitespace is buffered without a card and preserved once actual text arrives", () => {
  let result = project([
    event("assistant.reasoning_delta", { reasoningId: "r", content: "    " }),
    event("assistant.message_delta", { messageId: "a", content: "\n\n" }),
  ]);
  assert.deepEqual(result.items, []);
  result = append(result,
    event("assistant.reasoning_delta", { reasoningId: "r", content: "code" }),
    event("assistant.message_delta", { messageId: "a", content: "Answer" }));
  assert.equal(reasoning(result)[0].content, "    code");
  assert.equal(messages(result)[0].content, "\n\nAnswer");
});

test("discarding the leading draft transfers its avatar to visible continuation", () => {
  const result = replay([
    event("assistant.message_delta", { messageId: "discard", content: "Discard" }),
    event("assistant.reasoning", { content: "Actual visible lead" }),
    event("assistant.message", { messageId: "discard", content: "" }),
    event("assistant.message", { messageId: "answer", content: "Answer" }),
  ]);
  assert.equal(reasoning(result)[0].turnLead, true);
  assert.equal(messages(result)[0].turnLead, false);
  const empty = replay([
    event("assistant.message_delta", { messageId: "discard", content: "Discard" }),
    event("assistant.message", { messageId: "discard", content: "" }),
    event("assistant.message", { messageId: "answer", content: "Answer" }),
  ]);
  assert.equal(messages(empty)[0].turnLead, true);
});

test("completed entries and old snapshots retain identity during active appends", () => {
  const initial = project([
    event("assistant.reasoning", { content: "Complete **markdown**" }),
    event("tool.execution_start", { toolCallId: "t" }),
    event("tool.execution_complete", { toolCallId: "t", result: "Result" }),
    event("assistant.message_delta", { messageId: "a", content: "Hello" }),
  ]);
  const serialized = JSON.stringify(initial.items);
  freezeItems(initial.items);
  const result = append(initial, event("assistant.message_delta", { messageId: "a", content: " world" }));
  assert.equal(result.items[0], initial.items[0]);
  assert.equal(result.items[1], initial.items[1]);
  assert.notEqual(result.items[2], initial.items[2]);
  assert.equal(JSON.stringify(initial.items), serialized);
  assert.equal(initial.items[2].content, "Hello");
});

test("independent concurrent branches never mutate shared maps, arrays, tools or text", () => {
  const base = project([
    event("tool.execution_start", { toolCallId: "t" }),
    event("assistant.message_delta", { messageId: "a", content: "base" }),
  ]);
  freezeItems(base.items);
  const left = append(base, event("tool.execution_progress", { toolCallId: "t", message: "left" }));
  const right = append(base, event("assistant.message_delta", { messageId: "a", content: " right" }));
  assert.deepEqual(base.items[0].progress, []);
  assert.deepEqual(left.items[0].progress, ["left"]);
  assert.deepEqual(right.items[0].progress, []);
  assert.equal(base.items[1].content, "base");
  assert.equal(left.items[1], base.items[1]);
  assert.equal(right.items[1].content, "base right");
});

test("metadata-only batches preserve the timeline and environment identity", () => {
  const base = project([event("assistant.reasoning", { content: "Done" })]);
  const result = append(base,
    event("assistant.streaming_delta", { role: "assistant" }),
    event("assistant.usage", { tokens: 100 }),
    event("model.messages_snapshot", { messages: [] }),
    event("assistant.streaming_delta", {}, { agentId: "unknown" }));
  assert.equal(result.items, base.items);
  assert.equal(result.state.environment, base.state.environment);
});

test("appending validates event identity without rereading old payloads", () => {
  let reads = 0;
  const old = event("assistant.reasoning", {});
  Object.defineProperty(old, "data", { get() { reads += 1; return { content: "Completed" }; } });
  const base = project([old]);
  const initialReads = reads;
  const result = append(base, event("assistant.message_delta", { messageId: "a", content: "Live" }));
  assert.equal(reads, initialReads);
  assert.equal(result.items[0], base.items[0]);
});

test("environment aggregation is incremental and independent of child environments", () => {
  let result = project([
    event("session.skills_loaded", { skills: ["one"] }),
    event("session.mcp_server_status_changed", { serverName: "tools", status: "connecting" }),
  ]);
  assert.equal(result.environmentStatus, "Loading 1 skill — waiting on MCP: tools");
  const prior = result.items;
  result = append(result, event("session.mcp_server_status_changed", { serverName: "tools", status: "ready" }),
    event("session.mcp_servers_loaded", { servers: [] }));
  assert.equal(result.environmentStatus, null);
  assert.equal(result.items, prior);
});

test("history prepend, replacement and session switch reset the projector", () => {
  const recent = event("user.message", { content: "Recent" });
  const first = project([recent], { sessionId: "a" });
  const prepended = projectTimeline(first, [event("user.message", { content: "Earlier" }), recent], first.options);
  assert.deepEqual(visible(prepended).map((item) => item.content), ["Earlier", "Recent"]);
  const replaced = projectTimeline(first, [{ ...recent, data: { content: "Replaced" } }], first.options);
  assert.equal(replaced.items[0].content, "Replaced");
  const switched = projectTimeline(first, first.events, { sessionId: "b" });
  assert.notEqual(switched.items, first.items);
  assert.notEqual(switched.items[0], first.items[0]);
});

test("existing visible anchor bounds history but never hides appended active output", () => {
  const early = event("user.message", { content: "Earlier" });
  const anchor = event("user.message", { content: "Requested anchor" });
  let result = project([early, anchor], { windowStartEventId: anchor.id });
  assert.deepEqual(result.items.map((item) => item.content), ["Requested anchor"]);
  result = append(result, event("assistant.message_delta", { messageId: "a", content: "Live" }));
  assert.deepEqual(result.items.map((item) => item.content), ["Requested anchor", "Live"]);
  const expanded = projectTimeline(result, result.events, { windowStartEventId: early.id });
  assert.deepEqual(expanded.items.map((item) => item.content), ["Earlier", "Requested anchor", "Live"]);
});

test("model provenance follows source events and doesn't backfill history from the current picker", () => {
  const result = project([
    event("user.message", { content: "Old unknown" }),
    event("assistant.reasoning", { content: "Unknown model" }),
    event("assistant.message", { content: "Old" }),
    event("session.model_change", { newModel: "historical-model" }),
    event("user.message", { content: "Known" }),
    event("assistant.reasoning", { content: "Known model" }),
    event("assistant.message", { content: "Known" }),
  ], { assistantModel: "current-picker" });
  assert.equal(reasoning(result)[0].model, undefined);
  assert.equal(reasoning(result)[1].model, "historical-model");
  const next = append(result, event("user.message", { content: "New" }),
    event("assistant.turn_start"),
    event("assistant.reasoning_delta", { reasoningId: "new", content: "New model" }));
  assert.equal(reasoning(next).at(-1).model, "current-picker");
  assert.equal(reasoning(next)[0], reasoning(result)[0]);
});

test("authoritative response model backfills its reasoning but not another turn", () => {
  const result = replay([
    event("user.message", { content: "Old" }),
    event("assistant.message", { content: "Old answer" }),
    event("user.message", { content: "New" }),
    event("assistant.reasoning", { content: "New reasoning" }),
    event("assistant.message", { content: "New answer", model: "actual-model" }),
  ]);
  assert.equal(messages(result)[0].model, undefined);
  assert.equal(reasoning(result)[0].model, "actual-model");
  assert.equal(reasoning(result)[0].turnLead, true);
  assert.equal(messages(result)[1].turnLead, false);
});

test("subagents retain grouping and child identities, models, previews and lifecycle status", () => {
  const initial = project([
    event("assistant.reasoning", { content: "Root" }),
    event("subagent.started", { toolCallId: "t", agentName: "Researcher", model: "child-model" }, { agentId: "child" }),
    event("assistant.reasoning", { content: "Child reasoning" }, { agentId: "child" }),
    event("assistant.message_delta", { messageId: "a", content: "Child" }, { agentId: "child" }),
  ]);
  freezeItems(initial.items);
  const child = initial.items[1];
  const result = append(initial,
    event("assistant.message_delta", { messageId: "a", content: " answer" }, { agentId: "child" }),
    event("assistant.message", { messageId: "a", content: "Child answer" }, { agentId: "child" }),
    event("subagent.completed", { toolCallId: "t", durationMs: 500 }));
  assert.equal(result.items[0], initial.items[0]);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[1].timeline[0], child.timeline[0]);
  assert.equal(child.timeline[1].content, "Child");
  assert.equal(result.items[1].timeline[1].content, "Child answer");
  assert.equal(result.items[1].timeline[0].model, "child-model");
  assert.equal(result.items[1].preview, "Child answer");
  assert.equal(result.items[1].status, "completed");
  assert.equal(result.items[1].name, "Researcher");
});

test("subagent context enriches groups without timestamp sorting root events", () => {
  const context = [event("subagent.started", { agentName: "Known child", model: "child-model" }, { agentId: "child" })];
  const events = [
    event("user.message", { content: "First" }, { timestamp: "2026-09-04T03:00:00Z" }),
    event("assistant.message", { content: "Child" }, { agentId: "child", timestamp: "2026-09-04T01:00:00Z" }),
    event("assistant.message", { content: "Last" }, { timestamp: "2026-09-04T00:00:00Z" }),
  ];
  const result = replay(events, { subagentContext: context });
  assert.deepEqual(result.items.map((item) => item.kind), ["message", "subagent", "message"]);
  assert.equal(result.items[1].name, "Known child");
  assert.equal(result.items[1].timeline[0].model, "child-model");
  const changed = projectTimeline(result, events, {
    subagentContext: [{ ...context[0], data: { agentName: "Updated child" } }],
  });
  assert.equal(changed.items[1].name, "Updated child");
});

test("same-id reasoning finals update canonical segments and preserve order", () => {
  const result = replay([
    event("assistant.reasoning_delta", { reasoningId: "r", content: "Too long " }),
    event("assistant.message", { content: "Commentary" }),
    event("assistant.reasoning_delta", { reasoningId: "r", content: "reasoning" }),
    event("assistant.reasoning", { reasoningId: "r", content: "Short" }),
    event("assistant.message", { content: "Answer", reasoningText: "Short" }),
  ]);
  assert.equal(reasoning(result).map((item) => item.content).join(""), "Short");
  assert.deepEqual(visible(result).map((item) => item.content), ["Short", "Commentary", "Answer"]);
});

test("text parts render but embedded non-text reasoning/tool parts don't become answer bubbles", () => {
  const result = replay([
    event("assistant.message", { content: [
      { type: "reasoning", text: "Private format" },
      { type: "tool_call", text: "Tool" },
      { type: "text", text: "Visible " },
      { type: "output_text", text: "answer" },
    ] }),
  ]);
  assert.deepEqual(messages(result).map((item) => item.content), ["Visible answer"]);
});

test("user attachment names support SDK file/blob and lightweight history shapes without exposing paths", () => {
  const result = project([event("user.message", {
    content: "Inspect these",
    attachments: [
      { type: "blob", displayName: "report.pdf", mimeType: "application/pdf", data: "PRIVATE_FILE_BYTES" },
      { type: "file", path: "C:\\private\\folder\\notes.txt" },
      { type: "directory", path: "/private/project" },
      { name: "lightweight.jpg" },
      "just-a-name.csv",
      null,
      {},
    ],
  })]);
  assert.deepEqual(result.items[0].attachments.map((attachment) => attachment.name),
    ["report.pdf", "notes.txt", "project", "lightweight.jpg", "just-a-name.csv"]);
  assert.doesNotMatch(JSON.stringify(result.items), /PRIVATE_FILE_BYTES|private/);
});

test("attachment-only user messages remain visible human turns", () => {
  const result = replay([event("user.message", {
    content: "", attachments: [{ displayName: "photo.jpg" }],
  })]);
  assert.equal(visible(result).length, 1);
  assert.equal(result.items[0].role, "user");
  assert.equal(result.items[0].attachments[0].name, "photo.jpg");
});

test("image projection accepts only bounded inline raster blobs, never file paths or remote URLs", () => {
  const png = Buffer.from("\x89PNG\r\n\x1a\n", "binary").toString("base64");
  const result = project([event("user.message", {
    attachments: [
      { type: "blob", displayName: "image.png", mimeType: "image/png", data: png },
      { type: "file", displayName: "local.png", mimeType: "image/png", path: "C:\\private\\local.png", data: png },
      { type: "blob", displayName: "vector.svg", mimeType: "image/svg+xml", data: "<svg/>" },
      { displayName: "remote.png", mimeType: "image/png", url: "https://example.invalid/private.png" },
      { type: "blob", displayName: "too-large.png", mimeType: "image/png", data: "A".repeat(12 * 1024 * 1024) },
    ],
  })]);
  const attachments = result.items[0].attachments;
  assert.equal(attachments[0].image.data, png);
  assert.ok(attachments.slice(1).every((attachment) => !attachment.image));
  assert.deepEqual([...decodeAttachmentImage(attachments[0])], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test("thumbnail decoding rejects malformed base64, spoofed raster bytes and unsupported mime types", () => {
  for (const [mimeType, data] of [
    ["image/png", "https://example.invalid/image.png"],
    ["image/png", Buffer.from("<svg/>").toString("base64")],
    ["image/svg+xml", Buffer.from("<svg/>").toString("base64")],
    ["image/jpeg", Buffer.from("not jpeg").toString("base64")],
    ["image/gif", Buffer.from("not gif").toString("base64")],
    ["image/webp", Buffer.from("not webp").toString("base64")],
  ]) {
    assert.equal(decodeAttachmentImage({ name: "image", image: { mimeType, data } }), undefined);
  }
});

test("attachments are ignored outside user.message and stable across subsequent streaming batches", () => {
  const input = [{ displayName: "report.txt" }];
  const initial = project([
    event("user.message", { content: "Prompt", attachments: input }),
    event("assistant.message", { content: "Answer", attachments: input }),
  ]);
  assert.equal(initial.items[1].attachments, undefined);
  freezeItems(initial.items);
  const next = append(initial, event("assistant.message_delta", { messageId: "live", content: "More" }));
  assert.equal(next.items[0], initial.items[0]);
  assert.equal(next.items[0].attachments, initial.items[0].attachments);
});
