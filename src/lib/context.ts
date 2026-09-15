export interface ContextEntry {
  id: string;
  name: string;
  category: string;
  tokens: number | null;
  parentId?: string;
  toolName?: string;
  aggregate: boolean;
}

export interface ContextCategory {
  name: string;
  label: string;
  tokens: number;
}

export interface ContextAttribution {
  status: "available";
  entries: ContextEntry[];
  categories: ContextCategory[];
  totalTokens: number | null;
  limit: number | null;
  promptTokenLimit: number | null;
  bufferTokens: number | null;
  windowFreeSpace: number | null;
  compactionThreshold: number | null;
  compactions: number | null;
}

export type ContextSnapshot =
  | ContextAttribution
  | { status: "unavailable"; reason: string };

const categoryLabels: Record<string, string> = {
  systemPrompt: "System instructions",
  system: "System instructions",
  instructions: "Instructions",
  customInstructions: "Custom instructions",
  systemTools: "Built-in & custom tool definitions",
  mcpTools: "MCP tool definitions",
  toolDefinitions: "Tool definitions",
  tools: "Tool definitions",
  messages: "Conversation",
  conversation: "Conversation",
  history: "Conversation history",
  user: "User messages",
  assistant: "Assistant messages",
  toolResults: "Tool results",
  files: "Files",
  skills: "Skills",
  skill: "Skill",
  subagent: "Subagent",
  mcpServer: "MCP server",
  tool: "Tool calls",
  toolDefinition: "Tool definition",
  plugin: "Plugin",
  memory: "Memory",
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function contextCategoryLabel(name: string): string {
  return categoryLabels[name] ?? name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

export function normalizeContext(value: unknown): ContextSnapshot {
  const envelope = record(value);
  const data = envelope && "contextAttribution" in envelope
    ? record(envelope.contextAttribution)
    : envelope;
  if (!data) {
    return { status: "unavailable", reason: "Context attribution is not available for this session yet." };
  }
  if (typeof data.error === "string") {
    return { status: "unavailable", reason: data.error };
  }
  const hasEntries = Array.isArray(data.entries);
  if (!hasEntries && count(data.totalTokens) === null && !record(data.categories) && !Array.isArray(data.categories)) {
    return { status: "unavailable", reason: "The runtime did not provide a recognized context attribution snapshot." };
  }
  const entries: ContextEntry[] = [];
  const visit = (raw: unknown, index: number, parentId?: string) => {
    const entry = record(raw);
    if (!entry) return;
    const category = text(entry.kind) ?? text(entry.category) ?? text(entry.type) ?? "other";
    const name = text(entry.label) ?? text(entry.name) ?? text(entry.path) ?? contextCategoryLabel(category);
    const id = text(entry.id) ?? `${parentId ?? "entry"}:${index}`;
    const children = Array.isArray(entry.children) ? entry.children : [];
    entries.push({
      id,
      name,
      category,
      tokens: count(entry.tokens) ?? count(entry.tokenCount),
      parentId: text(entry.parentId) ?? parentId,
      toolName: text(entry.toolName) ?? text(entry.canonicalName) ??
        (id.startsWith("toolDefinition:") ? id.slice("toolDefinition:".length) : undefined),
      aggregate: children.length > 0 || entry.aggregate === true || category === "toolDefinitions",
    });
    children.forEach((child, childIndex) => visit(child, childIndex, id));
  };
  if (hasEntries) (data.entries as unknown[]).forEach((entry, index) => visit(entry, index));
  const parents = new Set(entries.map((entry) => entry.parentId).filter(Boolean));
  for (const entry of entries) if (parents.has(entry.id)) entry.aggregate = true;

  const categories: ContextCategory[] = [];
  const addCategory = (name: string, raw: unknown) => {
    // These SDK header buckets are window capacity, not occupied context.
    if (name === "freeSpace" || name === "buffer") return;
    const object = record(raw);
    const tokens = count(raw) ?? count(object?.tokens) ?? count(object?.tokenCount);
    if (tokens !== null) categories.push({ name, label: contextCategoryLabel(name), tokens });
  };
  if (Array.isArray(data.categories)) {
    data.categories.forEach((raw) => {
      const category = record(raw);
      const name = text(category?.name) ?? text(category?.category) ?? text(category?.type);
      if (name) addCategory(name, raw);
    });
  } else {
    Object.entries(record(data.categories) ?? {}).forEach(([name, raw]) => addCategory(name, raw));
  }
  if (categories.length === 0) {
    const groups = new Map<string, number>();
    // Parent aggregates already include their descendants. Flat tool-definition
    // children can also be reported alongside an aggregate without parentId.
    const hasToolAggregate = entries.some((entry) => entry.category === "toolDefinitions" && entry.tokens !== null);
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const hasCountedAncestor = (entry: ContextEntry) => {
      let parentId = entry.parentId;
      const visited = new Set([entry.id]);
      while (parentId && !visited.has(parentId)) {
        visited.add(parentId);
        const parent = byId.get(parentId);
        if (parent?.tokens !== null && parent?.tokens !== undefined) return true;
        parentId = parent?.parentId;
      }
      return false;
    };
    for (const entry of entries) {
      if (entry.tokens === null || hasCountedAncestor(entry)) continue;
      if (hasToolAggregate && entry.category !== "toolDefinitions" && isToolContextEntry(entry)) continue;
      groups.set(entry.category, (groups.get(entry.category) ?? 0) + entry.tokens);
    }
    groups.forEach((tokens, name) => categories.push({ name, label: contextCategoryLabel(name), tokens }));
  }
  return {
    status: "available",
    entries,
    categories: categories.sort((a, b) => b.tokens - a.tokens),
    // Only an explicit runtime total is a trustworthy budget measurement.
    totalTokens: count(data.totalTokens),
    limit: count(data.limit),
    promptTokenLimit: count(data.promptTokenLimit),
    bufferTokens: count(data.bufferTokens),
    windowFreeSpace: count(record(data.categories)?.freeSpace),
    compactionThreshold: count(data.compactionThreshold),
    compactions: count(data.compactions) ?? count(record(data.compactions)?.count) ??
      (Array.isArray(data.compactions) ? data.compactions.length : null),
  };
}

export function isToolContextEntry(entry: ContextEntry): boolean {
  return Boolean(entry.toolName) || /^(toolDefinition|mcpTool|customTool|builtinTool)$/i.test(entry.category);
}

export function contextBudget(context: ContextAttribution) {
  const promptLimit = context.promptTokenLimit;
  return {
    used: context.totalTokens,
    free: promptLimit !== null && context.totalTokens !== null
      ? Math.max(0, promptLimit - context.totalTokens) : null,
    output: context.limit !== null && promptLimit !== null
      ? Math.max(0, context.limit - promptLimit) : null,
    usedPercent: promptLimit !== null && promptLimit > 0 && context.totalTokens !== null
      ? Math.min(100, 100 * context.totalTokens / promptLimit) : null,
    overBudget: promptLimit !== null && context.totalTokens !== null && context.totalTokens > promptLimit,
    beforeCompaction: context.compactionThreshold !== null && context.totalTokens !== null
      ? Math.max(0, context.compactionThreshold - context.totalTokens) : null,
  };
}

export function toolTokenCounts(context: ContextSnapshot | null): Map<string, number> {
  const totals = new Map<string, number>();
  if (context?.status !== "available") return totals;
  for (const entry of context.entries) {
    if (entry.aggregate || !isToolContextEntry(entry) || entry.tokens === null) continue;
    const name = entry.toolName;
    if (!name) continue;
    totals.set(name, (totals.get(name) ?? 0) + entry.tokens);
  }
  return totals;
}

export function correlateToolTokenCounts(
  tools: readonly { id: string; runtimeName?: string }[],
  attribution: ReadonlyMap<string, number>,
): Map<string, number> {
  const candidates = new Map<string, string[]>();
  const owners = new Map<string, Set<string>>();
  const result = new Map<string, number>();
  for (const tool of tools) {
    // These are display-only aliases. Strip only the documented leading source
    // qualifier, never a server namespace or the ID used by mutation requests.
    const aliases = [...new Set([
      tool.id,
      tool.id.replace(/^(builtin|mcp|custom):/, ""),
      ...(tool.runtimeName ? [tool.runtimeName] : []),
    ])]
      .filter((name) => attribution.has(name));
    candidates.set(tool.id, aliases);
    for (const alias of aliases) {
      const ids = owners.get(alias) ?? new Set<string>();
      ids.add(tool.id);
      owners.set(alias, ids);
    }
  }
  for (const tool of tools) {
    const alias = candidates.get(tool.id)?.find((name) => owners.get(name)?.size === 1);
    if (alias !== undefined) result.set(tool.id, attribution.get(alias)!);
  }
  return result;
}

export function paginate<T>(items: readonly T[], limit: number, pageSize = 30) {
  const safeSize = Math.max(1, Math.floor(pageSize));
  const count = Number.isFinite(limit) ? Math.max(safeSize, Math.floor(limit)) : safeSize;
  return { items: items.slice(0, count), remaining: Math.max(0, items.length - count), nextLimit: count + safeSize };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "The request failed. Please try again.";
}

export interface ReadObserver<T> {
  loading: () => void;
  value: (value: T) => void;
  error: (error: unknown) => void;
}

export function createSingleflightReader<T>(
  read: (signal: AbortSignal) => Promise<T>,
  observer: ReadObserver<T>,
) {
  let disposed = false;
  let busy = false;
  let queued = false;
  let generation = 0;
  let controller: AbortController | undefined;
  async function refresh() {
    if (disposed) return;
    if (busy) { queued = true; return; }
    busy = true;
    const current = ++generation;
    controller = new AbortController();
    observer.loading();
    try {
      const value = await read(controller.signal);
      if (!disposed && generation === current) observer.value(value);
    } catch (error) {
      if (!disposed && generation === current) observer.error(error);
    } finally {
      busy = false;
      if (!disposed && queued) {
        queued = false;
        void refresh();
      }
    }
  }
  return {
    refresh,
    replace(value: T) {
      generation++;
      queued = false;
      controller?.abort();
      if (!disposed) observer.value(value);
    },
    dispose() {
      disposed = true;
      queued = false;
      controller?.abort();
    },
  };
}
