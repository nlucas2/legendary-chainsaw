import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeToolControls, serverTools, toolAvailability, toolControlDisabledReason, serverControlState,
  filterTools, toolMutationArgs, serverMutationArgs, toolControlChecked, toolAdoptionArgs,
} from "../src/lib/toolControls.ts";

const base = {
  tools: [
    { id: "bash", name: "Shell", description: "Run a command", source: "builtin", enabled: true, deferred: false },
    { id: "opaque-search-1", name: "Search", description: "Search north", source: "mcp", serverName: "north", enabled: true, deferred: false },
    { id: "opaque-fetch-2", name: "Fetch", source: "mcp", serverName: "north", enabled: false, deferred: true },
    { id: "north-adjacent", name: "Search", source: "mcp", serverName: "north-other", enabled: true, deferred: true },
    { id: "local-custom", name: "My tool", source: "custom", enabled: true },
  ],
  servers: [{ name: "north", status: "connected" }, { name: "north-other", status: "disabled" }],
  excludedTools: ["opaque-fetch-2"],
};
const snapshot = () => normalizeToolControls(structuredClone(base));

test("normalizes actual session inventory, distinguishing offered, deferred, off and unknown", () => {
  const data = snapshot();
  assert.equal(data.tools.length, 5);
  assert.equal(toolAvailability(data.tools[0]), "offered");
  assert.equal(toolAvailability(data.tools[2]), "off");
  assert.equal(toolAvailability(data.tools[3]), "deferred");
  assert.equal(toolAvailability(data.tools[4]), "enabled");
  assert.equal(data.tools[2].description, "");
});

test("missing or malformed inventory fails explicitly instead of showing zero tools", () => {
  for (const value of [null, {}, { tools: [] }, { tools: [], servers: [] }, { ...base, tools: [{ name: "missing identity" }] }]) {
    assert.throws(() => normalizeToolControls(value));
  }
  assert.equal(normalizeToolControls({ tools: [], servers: [], excludedTools: [] }).tools.length, 0);
});

test("MCP grouping uses serverName, not canonical tool ID prefixes or display names", () => {
  const data = snapshot();
  assert.deepEqual(serverTools(data, "north").map((tool) => tool.id), ["opaque-search-1", "opaque-fetch-2"]);
  assert.deepEqual(serverControlState(data.servers[0], data), {
    enabled: 1, total: 2, checked: true, known: true, mixed: true, disabledReason: undefined,
  });
  assert.equal(serverTools(data, "opaque").length, 0);
  assert.deepEqual(toolMutationArgs("session-a", data.tools[1], false), { sessionId: "session-a", toolId: "opaque-search-1", enabled: false });
  assert.deepEqual(serverMutationArgs("session-a", data.servers[0], true), { sessionId: "session-a", serverName: "north", enabled: true });
});

test("policy-locked tools and server controls expose why changes are disabled", () => {
  const data = normalizeToolControls({
    ...structuredClone(base),
    tools: base.tools.map((tool) => tool.id === "opaque-search-1" ? { ...tool, canToggle: false, disabledReason: "Managed by policy" } : tool),
  });
  assert.equal(toolControlDisabledReason(data.tools[1], data), "Managed by policy");
  assert.equal(serverControlState(data.servers[0], data).disabledReason, undefined);
  const serverPolicy = normalizeToolControls({ ...base, servers: [{ name: "north", status: "connected", policyLocked: true }] });
  assert.match(serverControlState(serverPolicy.servers[0], serverPolicy).disabledReason, /policy/);
});

test("unsupported runtime capabilities disable native mutation switches", () => {
  const data = normalizeToolControls({ ...base, capabilities: { setToolEnabled: false, setMcpEnabled: false } });
  assert.match(toolControlDisabledReason(data.tools[0], data), /not supported/);
  assert.match(serverControlState(data.servers[0], data).disabledReason, /not supported/);
  const policy = normalizeToolControls({ ...base, disabledReason: "Session is read-only" });
  assert.equal(toolControlDisabledReason(policy.tools[0], policy), "Session is read-only");
  assert.equal(serverControlState(policy.servers[0], policy).disabledReason, "Session is read-only");
});

test("backend effective enabled state is authoritative over server-scoped configuration names", () => {
  const data = normalizeToolControls({ ...base, availableTools: ["bash", "north"] });
  assert.equal(data.tools.length, 5);
  assert.equal(toolAvailability(data.tools[0]), "offered");
  assert.equal(toolAvailability(data.tools[1]), "offered");
  assert.equal(toolAvailability(data.tools[2]), "off");
  const noAllowList = normalizeToolControls({ ...base, availableTools: null });
  assert.equal(toolAvailability(noAllowList.tools[1]), "offered");
  const denyAll = normalizeToolControls({ ...base, availableTools: [], tools: base.tools.map((tool) => ({ ...tool, enabled: false })) });
  assert.equal(toolAvailability(denyAll.tools[0]), "off");
});

test("search includes canonical IDs, descriptions and exact source filtering", () => {
  const data = snapshot();
  assert.deepEqual(filterTools(data, " OPAQUE-SEARCH ").map((tool) => tool.id), ["opaque-search-1"]);
  assert.equal(filterTools(data, "north", "mcp").length, 3);
  assert.equal(filterTools(data, "north", "builtin").length, 0);
  assert.equal(filterTools(data, "run a command").length, 1);
  assert.deepEqual(filterTools(data, "", "custom").map((tool) => tool.id), ["local-custom"]);
  const aliased = normalizeToolControls({ ...base, tools: [{ ...base.tools[1], runtimeName: "current_runtime_alias" }] });
  assert.equal(aliased.tools[0].runtimeName, "current_runtime_alias");
  assert.equal(filterTools(aliased, "current_runtime_alias").length, 1);
  assert.equal(data.tools[1].runtimeName, undefined);
});

test("disabled servers can be enabled before their tool inventory is available", () => {
  const data = normalizeToolControls({ tools: [], servers: [{ name: "empty", status: "disabled" }], excludedTools: [], filterStateKnown: false });
  const state = serverControlState(data.servers[0], data);
  assert.equal(state.checked, false);
  assert.equal(state.known, true);
  assert.equal(state.disabledReason, undefined);
});

test("unknown filter state disables individual tool switches without blocking native MCP controls", () => {
  const data = normalizeToolControls({ ...base, filterStateKnown: false, warnings: ["Options read is unsupported"] });
  assert.deepEqual(data.warnings, ["Options read is unsupported"]);
  assert.match(toolControlDisabledReason(data.tools[0], data), /filter state is unavailable/);
  assert.equal(serverControlState(data.servers[0], data).disabledReason, undefined);
  assert.equal(serverControlState(data.servers[0], data).checked, true);
});

test("MCP connection state is not inferred from how many individual tools are offered", () => {
  const data = normalizeToolControls({ ...base, tools: base.tools.map((tool) => ({ ...tool, enabled: false })) });
  assert.equal(serverControlState(data.servers[0], data).checked, true);
  assert.equal(serverControlState(data.servers[1], data).checked, false);
  const unknown = normalizeToolControls({ ...base, servers: [{ name: "north", status: "new-unknown-state" }] });
  assert.equal(serverControlState(unknown.servers[0], unknown).known, false);
  assert.match(serverControlState(unknown.servers[0], unknown).disabledReason, /recognized server state/);
});

test("app-owned exclusions stay editable despite unknown runtime filter state", () => {
  const data = normalizeToolControls({ ...base, filterOwnership: "app", canEditTools: true, filterStateKnown: false });
  assert.equal(data.canEditTools, true);
  assert.equal(toolControlDisabledReason(data.tools[0], data), undefined);
  assert.equal(toolControlChecked(data.tools[0], data), true);
  assert.equal(toolControlChecked(data.tools[2], data), false);
  const ownershipFallback = normalizeToolControls({ ...base, filterOwnership: "app", filterStateKnown: false });
  assert.equal(ownershipFallback.canEditTools, true);
  const readOnly = normalizeToolControls({ ...base, filterOwnership: "app", filterStateKnown: false, canEditTools: false });
  assert.match(toolControlDisabledReason(readOnly.tools[0], readOnly), /read-only/);
});

test("removing an app exclusion is undoable for persisted stubs without inventing an offer", () => {
  const stub = { id: "mcp:missing-fetch", name: "missing-fetch", source: "mcp", serverName: "missing", enabled: false };
  const data = normalizeToolControls({
    tools: [stub], servers: [{ name: "missing", status: "disabled" }], excludedTools: [stub.id],
    filterOwnership: "app", canEditTools: true, filterStateKnown: false,
  });
  assert.equal(toolControlDisabledReason(data.tools[0], data), undefined);
  assert.equal(toolControlChecked(data.tools[0], data), false);
  assert.deepEqual(toolMutationArgs("session-a", data.tools[0], true), { sessionId: "session-a", toolId: stub.id, enabled: true });
  const refreshed = normalizeToolControls({ ...data, excludedTools: [], warnings: ["Still unavailable in current runtime metadata"] });
  assert.equal(toolControlChecked(refreshed.tools[0], refreshed), true);
  assert.equal(toolAvailability(refreshed.tools[0]), "off");
  assert.deepEqual(refreshed.warnings, ["Still unavailable in current runtime metadata"]);
});

test("existing sessions require explicit adoption without blocking independent MCP controls", () => {
  const data = normalizeToolControls({
    ...base, filterOwnership: "unknown", canEditTools: false, requiresAdoption: true, filterStateKnown: false,
  });
  assert.equal(data.requiresAdoption, true);
  assert.match(toolControlDisabledReason(data.tools[0], data), /Manage this session’s tool selection/);
  assert.equal(serverControlState(data.servers[0], data).disabledReason, undefined);
  assert.deepEqual(toolAdoptionArgs("session-existing"), { sessionId: "session-existing" });
  assert.equal(normalizeToolControls(base).requiresAdoption, false);
});

test("adopted finite selections keep catalog-only and future tools unselected until explicitly added", () => {
  const data = normalizeToolControls({
    ...base, filterOwnership: "app", canEditTools: true, requiresAdoption: false, filterStateKnown: false,
    availableTools: ["bash"], excludedTools: [],
  });
  assert.equal(toolControlChecked(data.tools[0], data), true);
  assert.equal(toolControlChecked(data.tools[1], data), false);
  assert.equal(toolControlChecked(data.tools[2], data), false);
  const added = normalizeToolControls({ ...data, availableTools: ["bash", "opaque-fetch-2"] });
  assert.equal(toolControlChecked(added.tools[2], added), true);
  assert.equal(toolAvailability(added.tools[2]), "off");
  assert.equal(toolControlChecked(added.tools[1], added), false);
  const noneSelected = normalizeToolControls({ ...data, availableTools: [] });
  assert.equal(toolControlChecked(noneSelected.tools[0], noneSelected), false);
  const newManagedSession = normalizeToolControls({ ...data, availableTools: undefined });
  assert.equal(toolControlChecked(newManagedSession.tools[1], newManagedSession), true);
});
