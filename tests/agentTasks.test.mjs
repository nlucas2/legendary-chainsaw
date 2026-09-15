import test from "node:test";
import assert from "node:assert/strict";
import { activeAgent, visibleAgents, normalizeAgentTasks, agentKey, agentRootEvents } from "../src/lib/agentTasks.ts";

const task = (id, status) => ({ id, status, name: "Duplicate name", agentType: "task", toolCallId: `tool-${id}`, canMessage: ["running", "idle"].includes(status) });

test("active agents include running and idle without mixing finished tasks", () => {
  const tasks = [task("a", "running"), task("b", "idle"), task("c", "completed"), task("d", "failed"), task("e", "cancelled")];
  assert.deepEqual(tasks.filter(activeAgent).map((task) => task.id), ["a", "b"]);
  assert.deepEqual(visibleAgents(tasks, false).map((task) => task.id), ["a", "b"]);
  assert.deepEqual(visibleAgents(tasks, true), tasks);
});

test("a selected agent does not vanish when its work finishes", () => {
  const tasks = [task("a", "running"), task("b", "completed")];
  assert.deepEqual(visibleAgents(tasks, false, "b"), tasks);
});

test("task identity and drafts are parent scoped even when task IDs or names collide", () => {
  assert.notEqual(agentKey("parent-a", "same"), agentKey("parent-b", "same"));
  assert.notEqual(agentKey("a:b", "c"), agentKey("a", "b:c"));
  assert.equal(normalizeAgentTasks({ sessionId: "a", tasks: [task("one", "idle"), task("two", "running")] }, "a").tasks.length, 2);
});

test("mismatched parent or malformed task metadata fails explicitly", () => {
  assert.throws(() => normalizeAgentTasks({ sessionId: "b", tasks: [] }, "a"));
  assert.throws(() => normalizeAgentTasks({ sessionId: "a", tasks: [{}] }, "a"));
  assert.throws(() => normalizeAgentTasks({ sessionId: "a", tasks: [task("one", "idle"), task("one", "idle")] }, "a"));
});

test("focused transcript uses only the exact authoritative event agent ID", () => {
  const events = [
    { id: "root", type: "user.message", data: {} },
    { id: "sibling", type: "assistant.message", agentId: "two", data: {} },
    { id: "child", type: "assistant.message_delta", agentId: "one", data: { content: "Streaming" } },
  ];
  assert.deepEqual(agentRootEvents(events, "one"), [
    { id: "child", type: "assistant.message_delta", data: { content: "Streaming" } },
  ]);
  assert.equal(events[2].agentId, "one");
  assert.deepEqual(agentRootEvents(events, undefined), []);
});

test("unchanged child events preserve renderer identity across live appends", () => {
  const first = { id: "1", type: "assistant.message", agentId: "a", data: { content: "Done" } };
  const before = agentRootEvents([first], "a");
  const next = agentRootEvents([first, { id: "2", agentId: "a", type: "assistant.message_delta", data: { content: "Next" } }], "a");
  assert.equal(before[0], next[0]);
  const replacement = { ...first, data: { content: "Corrected" } };
  assert.notEqual(agentRootEvents([replacement], "a")[0], before[0]);
});
