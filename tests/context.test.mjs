import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeContext, contextBudget, toolTokenCounts, correlateToolTokenCounts, paginate, createSingleflightReader,
} from "../src/lib/context.ts";

const attribution = {
  totalTokens: 12000,
  limit: 20000,
  promptTokenLimit: 16000,
  bufferTokens: 6000,
  compactionThreshold: 14000,
  compactions: { count: 2 },
  categories: { systemPrompt: 1000, customInstructions: 100, systemTools: 400, mcpTools: 500, messages: 10000, freeSpace: 2000, buffer: 6000 },
  entries: Array.from({ length: 210 }, (_, index) => ({
    kind: "toolDefinition", id: `toolDefinition:canonical-${index}`, label: `Display name ${index}`, tokens: index,
  })),
};

test("wrapped SDK context attribution exposes all 210 rows and budget fields", () => {
  const wrapped = normalizeContext({ contextAttribution: attribution });
  assert.equal(wrapped.status, "available");
  assert.equal(wrapped.entries.length, 210);
  assert.deepEqual(wrapped, normalizeContext(attribution));
  assert.equal(wrapped.compactions, 2);
  assert.equal(wrapped.windowFreeSpace, 2000);
  assert.equal(wrapped.entries[0].category, "toolDefinition");
  assert.deepEqual(contextBudget(wrapped), {
    used: 12000, free: 4000, output: 4000, usedPercent: 75, overBudget: false, beforeCompaction: 2000,
  });
});

test("missing/null/unrecognized attribution is unavailable, never a fake empty snapshot", () => {
  for (const raw of [null, undefined, {}, { contextAttribution: null }, { contextAttribution: undefined }, { irrelevant: [] }]) {
    assert.equal(normalizeContext(raw).status, "unavailable");
  }
  assert.equal(normalizeContext({ entries: [], totalTokens: 0 }).status, "available");
  const missingTotals = normalizeContext({ entries: [] });
  assert.equal(missingTotals.totalTokens, null);
  assert.equal(contextBudget(missingTotals).used, null);
  assert.equal(contextBudget(missingTotals).free, null);
});

test("SDK header capacity buckets are not counted as occupied context", () => {
  const context = normalizeContext(attribution);
  assert.deepEqual(context.categories.map((entry) => entry.name).sort(), ["customInstructions", "mcpTools", "messages", "systemPrompt", "systemTools"]);
  assert.equal(context.categories.reduce((sum, entry) => sum + entry.tokens, 0), 12000);
  assert.equal(context.totalTokens, 12000);
});

test("toolDefinitions parent and individual children never double-count category totals", () => {
  const context = normalizeContext({ totalTokens: 1300, entries: [
    { kind: "system", id: "system:toolDefinitions", label: "Tool definitions", tokens: 1000 },
    { kind: "toolDefinition", id: "toolDefinition:alpha", label: "Friendly alpha", parentId: "system:toolDefinitions", tokens: 600 },
    { kind: "toolDefinition", id: "toolDefinition:beta", label: "Friendly beta", parentId: "system:toolDefinitions", tokens: 400 },
    { kind: "messages", id: "messages:conversation", tokens: 300 },
  ] });
  assert.equal(context.categories.reduce((sum, entry) => sum + entry.tokens, 0), 1300);
  assert.equal(context.entries[0].aggregate, true);
  assert.equal(context.totalTokens, 1300);
  assert.deepEqual([...toolTokenCounts(context)], [["alpha", 600], ["beta", 400]]);
});

test("rollup nesting skips a grandchild even if its immediate parent has no count", () => {
  const context = normalizeContext({ entries: [
    { id: "root", kind: "system", tokens: 100 },
    { id: "middle", kind: "system", parentId: "root" },
    { id: "leaf", kind: "toolDefinition", parentId: "middle", tokens: 60 },
  ] });
  assert.equal(context.categories.reduce((sum, entry) => sum + entry.tokens, 0), 100);
  assert.equal(context.totalTokens, null);
});

test("canonical ID supplies definition costs, never display labels or tool execution costs", () => {
  const context = normalizeContext({ entries: [
    { kind: "toolDefinition", id: "toolDefinition:mcp__north__search", label: "Localized search", tokens: 180 },
    { kind: "tool", id: "tool:mcp__north__search", label: "Search result", tokens: 900 },
    { kind: "toolDefinition", label: "Ambiguous display label", tokens: 70 },
  ] });
  const costs = toolTokenCounts(context);
  assert.equal(costs.get("mcp__north__search"), 180);
  assert.equal(costs.get("Localized search"), undefined);
  assert.equal(costs.size, 1);
  assert.equal(toolTokenCounts({ status: "unavailable", reason: "No context yet" }).size, 0);
});

test("display token correlation keeps qualified IDs separate from runtime-name aliases", () => {
  const counts = new Map([["bash", 100], ["north-search", 180], ["mcp:unrelated-tool", 70]]);
  const tools = [
    { id: "builtin:bash", name: "bash" },
    { id: "mcp:north-search", name: "north-search" },
    { id: "mcp:unrelated-tool", name: "a-different-runtime-name" },
  ];
  assert.deepEqual([...correlateToolTokenCounts(tools, counts)], [["builtin:bash", 100], ["mcp:north-search", 180], ["mcp:unrelated-tool", 70]]);
  assert.equal(correlateToolTokenCounts([...tools, { id: "mcp:other-bash", name: "bash" }], counts).has("builtin:bash"), true);
  assert.equal(correlateToolTokenCounts([...tools, { id: "mcp:other-bash", runtimeName: "bash" }], counts).has("builtin:bash"), false);
});

test("only explicit current runtimeName is a token alias; stale display names never correlate", () => {
  const counts = new Map([["model_alias", 125]]);
  const tool = { id: "mcp:server-key-read_file", name: "model_alias", runtimeName: "model_alias" };
  assert.equal(correlateToolTokenCounts([tool], counts).get(tool.id), 125);
  assert.equal(correlateToolTokenCounts([{ id: tool.id, name: tool.name }], counts).has(tool.id), false);
  assert.equal(correlateToolTokenCounts([tool, { id: "custom:other", runtimeName: tool.runtimeName }], counts).size, 0);
});

test("token correlation strips only known leading source qualifiers and rejects ambiguous aliases", () => {
  const tools = [
    { id: "builtin:powershell", name: "Shell display" },
    { id: "mcp:server-fetch", name: "Fetch display" },
    { id: "custom:inspect", name: "Inspect display" },
    { id: "unknown:other", name: "Other display" },
    { id: "mcp:server-mcp:nested", name: "Nested display" },
  ];
  const counts = new Map([["powershell", 10], ["server-fetch", 20], ["inspect", 30], ["other", 40], ["server-mcp:nested", 50]]);
  assert.deepEqual([...correlateToolTokenCounts(tools, counts)], [
    ["builtin:powershell", 10], ["mcp:server-fetch", 20], ["custom:inspect", 30], ["mcp:server-mcp:nested", 50],
  ]);
  assert.equal(correlateToolTokenCounts([...tools, { id: "custom:powershell", name: "Another shell" }], counts).has("builtin:powershell"), false);
  const exact = new Map([...counts, ["builtin:powershell", 99]]);
  assert.equal(correlateToolTokenCounts(tools, exact).get("builtin:powershell"), 99);
});

test("over-budget and invalid numeric fields stay bounded without inventing data", () => {
  const context = normalizeContext({ entries: [], totalTokens: 18000, promptTokenLimit: 16000, limit: NaN, compactionThreshold: 14000, bufferTokens: -1 });
  const budget = contextBudget(context);
  assert.equal(budget.free, 0);
  assert.equal(budget.usedPercent, 100);
  assert.equal(budget.overBudget, true);
  assert.equal(budget.beforeCompaction, 0);
  assert.equal(budget.output, null);
  assert.equal(context.bufferTokens, null);
});

test("load more reaches every entry beyond the previous hard 80 cap", () => {
  const entries = normalizeContext(attribution).entries;
  let limit = 30;
  let page;
  do {
    page = paginate(entries, limit);
    assert.equal(page.items.length + page.remaining, 210);
    limit = page.nextLimit;
  } while (page.remaining);
  assert.equal(page.items.length, 210);
  assert.equal(page.items.at(-1).id, "toolDefinition:canonical-209");
  assert.equal(paginate(entries, -1).items.length, 30);
  assert.equal(paginate(entries, NaN).items.length, 30);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("singleflight reader coalesces burst refreshes and preserves a trailing invalidation", async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const values = [];
  const reader = createSingleflightReader(() => (++calls === 1 ? first.promise : second.promise), {
    loading() {}, value(value) { values.push(value); }, error(error) { throw error; },
  });
  const pending = reader.refresh();
  void reader.refresh();
  void reader.refresh();
  assert.equal(calls, 1);
  first.resolve("first");
  await pending;
  assert.equal(calls, 2);
  second.resolve("fresh");
  await tick();
  assert.deepEqual(values, ["first", "fresh"]);
  reader.dispose();
});

test("disposed session cannot publish results or errors even when transport ignores abort", async () => {
  const pending = deferred();
  const values = [];
  let signal;
  const reader = createSingleflightReader((abortSignal) => { signal = abortSignal; return pending.promise; }, {
    loading() {}, value(value) { values.push(value); }, error(error) { values.push(error); },
  });
  const request = reader.refresh();
  reader.dispose();
  assert.equal(signal.aborted, true);
  pending.resolve("old session");
  await request;
  assert.deepEqual(values, []);
});

test("mutation snapshot replaces and invalidates an older in-flight read", async () => {
  const pending = deferred();
  const values = [];
  const reader = createSingleflightReader(() => pending.promise, {
    loading() {}, value(value) { values.push(value); }, error(error) { values.push(error); },
  });
  const request = reader.refresh();
  reader.replace("mutated");
  pending.resolve("stale");
  await request;
  assert.deepEqual(values, ["mutated"]);
  reader.dispose();
});

test("read errors are explicit and a later refresh can recover", async () => {
  const failure = new Error("Runtime unavailable");
  let fail = true;
  const values = [];
  const errors = [];
  const reader = createSingleflightReader(async () => { if (fail) throw failure; return "ok"; }, {
    loading() {}, value(value) { values.push(value); }, error(error) { errors.push(error); },
  });
  await reader.refresh();
  assert.deepEqual(errors, [failure]);
  fail = false;
  await reader.refresh();
  assert.deepEqual(values, ["ok"]);
  reader.dispose();
});
