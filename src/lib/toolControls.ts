export type ToolSource = "builtin" | "mcp" | "custom";

export interface SessionTool {
  id: string;
  name: string;
  runtimeName?: string;
  description: string;
  source: ToolSource;
  serverName?: string;
  enabled: boolean;
  deferred?: boolean;
  canToggle: boolean;
  disabledReason?: string;
}

export interface SessionToolServer {
  name: string;
  status: string;
  canToggle: boolean;
  disabledReason?: string;
}

export interface ToolControlsSnapshot {
  tools: SessionTool[];
  servers: SessionToolServer[];
  availableTools?: string[] | null;
  excludedTools: string[];
  filterStateKnown: boolean;
  filterOwnership?: string;
  canEditTools: boolean;
  requiresAdoption: boolean;
  inventoryLoading: boolean;
  metadataAvailable: boolean;
  metadataLoading: boolean;
  warnings: string[];
  canSetToolEnabled: boolean;
  canSetMcpEnabled: boolean;
  disabledReason?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function reason(value: Record<string, unknown>): string | undefined {
  return typeof value.disabledReason === "string" ? value.disabledReason
    : typeof value.reason === "string" ? value.reason : undefined;
}

export function normalizeToolControls(raw: unknown): ToolControlsSnapshot {
  const envelope = record(raw);
  const value = record(envelope?.toolControls) ?? envelope;
  if (!value || !Array.isArray(value.tools) || !Array.isArray(value.servers) || !strings(value.excludedTools)) {
    throw new Error("The runtime did not provide a valid session tool inventory.");
  }
  if (value.availableTools !== undefined && value.availableTools !== null && !strings(value.availableTools)) {
    throw new Error("The runtime returned an invalid session tool allow-list.");
  }
  const capabilities = record(value.capabilities);
  const tools = value.tools.map((rawTool): SessionTool => {
    const tool = record(rawTool);
    if (!tool || typeof tool.id !== "string" || !tool.id || typeof tool.name !== "string" ||
      typeof tool.enabled !== "boolean" || !["builtin", "mcp", "custom"].includes(String(tool.source))) {
      throw new Error("The runtime returned a tool without its identity, source, or enabled state.");
    }
    return {
      id: tool.id,
      name: tool.name,
      runtimeName: typeof tool.runtimeName === "string" && tool.runtimeName ? tool.runtimeName : undefined,
      description: typeof tool.description === "string" ? tool.description : "",
      source: tool.source as ToolSource,
      serverName: typeof tool.serverName === "string" ? tool.serverName : undefined,
      enabled: tool.enabled,
      deferred: typeof tool.deferred === "boolean" ? tool.deferred : undefined,
      canToggle: tool.canToggle !== false && tool.policyLocked !== true,
      disabledReason: reason(tool),
    };
  });
  if (new Set(tools.map((tool) => tool.id)).size !== tools.length) {
    throw new Error("The runtime returned duplicate canonical tool IDs.");
  }
  const servers = value.servers.map((rawServer): SessionToolServer => {
    const server = record(rawServer);
    if (!server || typeof server.name !== "string" || !server.name) {
      throw new Error("The runtime returned an MCP server without its name.");
    }
    return {
      name: server.name,
      status: typeof server.status === "string" ? server.status : "unknown",
      canToggle: server.canToggle !== false && server.policyLocked !== true,
      disabledReason: reason(server),
    };
  });
  return {
    tools,
    servers,
    availableTools: value.availableTools === null ? null : strings(value.availableTools),
    excludedTools: strings(value.excludedTools)!,
    filterStateKnown: value.filterStateKnown !== false,
    filterOwnership: typeof value.filterOwnership === "string" ? value.filterOwnership : undefined,
    canEditTools: typeof value.canEditTools === "boolean"
      ? value.canEditTools : value.filterOwnership === "app" || value.filterStateKnown !== false,
    requiresAdoption: value.requiresAdoption === true,
    inventoryLoading: value.inventoryLoading === true,
    metadataAvailable: value.metadataAvailable !== false,
    metadataLoading: value.metadataLoading === true,
    warnings: strings(value.warnings) ?? [],
    canSetToolEnabled: capabilities?.setToolEnabled !== false && value.canSetToolEnabled !== false,
    canSetMcpEnabled: capabilities?.setMcpEnabled !== false && value.canSetMcpEnabled !== false,
    disabledReason: reason(value),
  };
}

export function serverTools(snapshot: ToolControlsSnapshot, serverName: string): SessionTool[] {
  // The server name is not a tool ID prefix. Canonical IDs may use a different
  // namespace, and similarly named servers must not be changed together.
  return snapshot.tools.filter((tool) => tool.source === "mcp" && tool.serverName === serverName);
}

export function toolAvailability(tool: SessionTool): "off" | "deferred" | "offered" | "enabled" {
  // The backend resolves allow-list and exclusion rules into this effective
  // state. Configuration entries can name whole servers, not just tool IDs.
  if (!tool.enabled) return "off";
  if (tool.deferred === true) return "deferred";
  return tool.deferred === false ? "offered" : "enabled";
}

export function toolControlDisabledReason(tool: SessionTool, snapshot: ToolControlsSnapshot): string | undefined {
  if (snapshot.disabledReason) return snapshot.disabledReason;
  if (!snapshot.metadataAvailable) return "Current runtime availability is unknown; individual tool changes are paused until metadata is available.";
  if (snapshot.requiresAdoption) return "Choose “Manage this session’s tool selection” before changing its tools.";
  if (!snapshot.canSetToolEnabled) return snapshot.disabledReason ?? "Tool changes are not supported by this runtime.";
  if (!snapshot.canEditTools) return !snapshot.filterStateKnown && snapshot.filterOwnership !== "app"
    ? "Tool filter state is unavailable; changing it could overwrite existing exclusions."
    : "Tool exclusions are read-only for this session.";
  if (!tool.canToggle || tool.disabledReason) return tool.disabledReason ?? "This tool is managed by policy.";
  return undefined;
}

export function toolControlChecked(tool: SessionTool, snapshot: ToolControlsSnapshot): boolean {
  // An adopted session has a finite app-owned selection as well as exclusions.
  // Neither setting is a readback of external/runtime policy or an offer promise.
  return snapshot.filterOwnership === "app"
    ? (!Array.isArray(snapshot.availableTools) || snapshot.availableTools.includes(tool.id)) &&
      !snapshot.excludedTools.includes(tool.id)
    : tool.enabled;
}

export function toolAdoptionArgs(sessionId: string) {
  return { sessionId };
}

export function serverControlState(server: SessionToolServer, snapshot: ToolControlsSnapshot) {
  const tools = serverTools(snapshot, server.name);
  const enabled = tools.filter((tool) => toolAvailability(tool) !== "off").length;
  const status = server.status.toLowerCase();
  const checked = ["connected", "pending", "failed", "needs-auth"].includes(status);
  const known = checked || ["disabled", "stopped"].includes(status);
  const disabledReason = snapshot.disabledReason ?? (!snapshot.canSetMcpEnabled
    ? snapshot.disabledReason ?? "MCP server changes are not supported by this runtime."
    : !server.canToggle || server.disabledReason
      ? server.disabledReason ?? "This server is managed by policy."
      : !known ? "The runtime did not provide a recognized server state. Refresh before changing it." : undefined);
  // Native MCP enable/disable is independent of tool filters and must remain
  // usable for disabled servers whose tool inventory has not been loaded yet.
  return { enabled, total: tools.length, checked, known, mixed: enabled > 0 && enabled < tools.length, disabledReason };
}

export function filterTools(snapshot: ToolControlsSnapshot, query: string, source: ToolSource | "all" = "all"): SessionTool[] {
  const needle = query.trim().toLocaleLowerCase();
  return snapshot.tools.filter((tool) =>
    (source === "all" || tool.source === source) &&
    (!needle || [tool.id, tool.name, tool.runtimeName ?? "", tool.description, tool.serverName ?? ""].some((part) => part.toLocaleLowerCase().includes(needle))),
  );
}

export function toolMutationArgs(sessionId: string, tool: SessionTool, enabled: boolean) {
  return { sessionId, toolId: tool.id, enabled };
}

export function serverMutationArgs(sessionId: string, server: SessionToolServer, enabled: boolean) {
  return { sessionId, serverName: server.name, enabled };
}
