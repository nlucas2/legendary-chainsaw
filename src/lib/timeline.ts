import type { SessionEvent } from "./types.ts";

export interface TimelineAttachment {
  name: string;
  image?: { mimeType: string; data: string };
}

export type TimelineItem =
  | {
      kind: "message";
      id: string;
      role: "user" | "assistant";
      content: string;
      attachments?: readonly TimelineAttachment[];
      streaming?: boolean;
      streamId?: string;
      hidden?: boolean;
      turnLead?: boolean;
      model?: string;
    }
  | {
      kind: "reasoning";
      id: string;
      content: string;
      streaming: boolean;
      streamId?: string;
      hidden?: boolean;
      turnLead?: boolean;
      model?: string;
    }
  | {
      kind: "tool";
      id: string;
      callId: string;
      name: string;
      state: "preparing" | "running" | "done" | "failed";
      detail?: string;
      arguments?: unknown;
      inputBuffer?: string;
      result?: unknown;
      progress: string[];
    }
  | {
      kind: "command";
      id: string;
      command: string;
      result: unknown;
    }
  | {
      kind: "subagent";
      id: string;
      name: string;
      description: string;
      model?: string;
      status: "running" | "completed" | "failed" | "cancelled" | "unknown";
      durationMs?: number;
      error?: string;
      timeline: readonly TimelineItem[];
      preview?: string;
    }
  | { kind: "status"; id: string; label: string };

type SubagentItem = Extract<TimelineItem, { kind: "subagent" }>;

interface Environment {
  seen: boolean;
  mcpLoaded: boolean;
  instructions?: number;
  agents?: number;
  plugins?: number;
  skills?: number;
  mcp: ReadonlyMap<string, string>;
  label: string | null;
}

interface TimelineState {
  items: readonly TimelineItem[];
  positions: ReadonlyMap<string, number>;
  tools: ReadonlyMap<string, string>;
  reasoning: ReadonlyMap<string, readonly string[]>;
  messages: ReadonlyMap<string, readonly string[]>;
  pendingReasoning: ReadonlyMap<string, string>;
  pendingMessages: ReadonlyMap<string, string>;
  agents: ReadonlyMap<string, string>;
  agentsByTool: ReadonlyMap<string, string>;
  children: ReadonlyMap<string, TimelineState>;
  contextApplied: ReadonlySet<string>;
  environment: Environment;
  activeModel?: string;
  lastMessageId?: string;
  cycle: number;
  cycleItems: readonly string[];
  cycleReasoning: readonly string[];
  interactionReasoning: readonly string[];
  turnHasLead: boolean;
}

export interface TimelineOptions {
  sessionId?: string;
  windowStartEventId?: string;
  subagentContext?: readonly SessionEvent[];
  /** Current selection is used for newly appended turns, never old history. */
  assistantModel?: string;
}

export interface TimelineProjection {
  readonly events: readonly SessionEvent[];
  readonly items: readonly TimelineItem[];
  readonly environmentStatus: string | null;
  readonly options: TimelineOptions;
  readonly state: TimelineState;
  readonly windowStart: number;
}

const EMPTY_EVENTS: readonly SessionEvent[] = [];

function emptyState(model?: string): TimelineState {
  return {
    items: [],
    positions: new Map(),
    tools: new Map(),
    reasoning: new Map(),
    messages: new Map(),
    pendingReasoning: new Map(),
    pendingMessages: new Map(),
    agents: new Map(),
    agentsByTool: new Map(),
    children: new Map(),
    contextApplied: new Set(),
    environment: { seen: false, mcpLoaded: false, mcp: new Map(), label: null },
    activeModel: model,
    cycle: 0,
    cycleItems: [],
    cycleReasoning: [],
    interactionReasoning: [],
    turnHasLead: false,
  };
}

function samePrefix(previous: readonly SessionEvent[], next: readonly SessionEvent[]): boolean {
  return previous === next ||
    (previous.length <= next.length && previous.every((event, index) => event === next[index]));
}

function sameEvents(previous: readonly SessionEvent[], next: readonly SessionEvent[]): boolean {
  return previous.length === next.length && samePrefix(previous, next);
}

/**
 * Pure append projection. A discarded/concurrent React render can keep or reuse
 * any prior snapshot: neither its items nor its lookup tables are ever mutated.
 * Prepend, replacement, session and visible-anchor changes rebuild deliberately.
 */
export function projectTimeline(
  previous: TimelineProjection | undefined,
  events: readonly SessionEvent[],
  options: TimelineOptions = {},
): TimelineProjection {
  const context = options.subagentContext ?? EMPTY_EVENTS;
  const append = previous !== undefined &&
    previous.options.sessionId === options.sessionId &&
    previous.options.windowStartEventId === options.windowStartEventId &&
    sameEvents(previous.options.subagentContext ?? EMPTY_EVENTS, context) &&
    samePrefix(previous.events, events);
  if (append && previous.events === events &&
      previous.options.assistantModel === options.assistantModel) return previous;

  const windowStart = append
    ? previous.windowStart
    : Math.max(0, options.windowStartEventId
      ? events.findIndex((event) => event.id === options.windowStartEventId)
      : 0);
  const draft = new Draft(append ? previous.state : emptyState());
  const start = append ? previous.events.length : 0;
  let visibleIds: Set<string> | undefined;
  for (let index = start; index < events.length; index += 1) {
    const event = events[index];
    if (index < windowStart) {
      if (!event.agentId) {
        draft.environment(event);
        draft.model(event);
      }
      continue;
    }
    // Context enriches only child groups. Root event order is authoritative,
    // including clocks that move backwards or equal timestamps.
    if (context.length && event.agentId && !draft.state.contextApplied.has(event.agentId)) {
      draft.contextApplied().add(event.agentId);
      visibleIds ??= new Set(events.slice(windowStart).map((entry) => entry.id));
      for (const contextual of context) {
        if (contextual.agentId === event.agentId && !visibleIds.has(contextual.id)) {
          draft.event(contextual);
        }
      }
    }
    draft.event(event, append ? options.assistantModel : undefined);
  }
  return {
    events,
    options,
    items: draft.state.items,
    state: draft.state,
    environmentStatus: draft.state.environment.label,
    windowStart,
  };
}

type MapKey = "positions" | "tools" | "reasoning" | "messages" |
  "pendingReasoning" | "pendingMessages" | "agents" | "agentsByTool" | "children";

class Draft {
  state: TimelineState;
  private copied = new Set<string>();

  constructor(previous: TimelineState) {
    this.state = { ...previous };
  }

  private map<K extends MapKey>(key: K): Map<
    string, TimelineState[K] extends ReadonlyMap<string, infer V> ? V : never
  > {
    if (!this.copied.has(key)) {
      this.state[key] = new Map(this.state[key] as ReadonlyMap<string, never>) as TimelineState[K];
      this.copied.add(key);
    }
    return this.state[key] as Map<
      string, TimelineState[K] extends ReadonlyMap<string, infer V> ? V : never
    >;
  }

  contextApplied(): Set<string> {
    if (!this.copied.has("contextApplied")) {
      this.state.contextApplied = new Set(this.state.contextApplied);
      this.copied.add("contextApplied");
    }
    return this.state.contextApplied as Set<string>;
  }

  private items(): TimelineItem[] {
    if (!this.copied.has("items")) {
      this.state.items = this.state.items.slice();
      this.copied.add("items");
    }
    return this.state.items as TimelineItem[];
  }

  private get(id: string | undefined): TimelineItem | undefined {
    const index = id === undefined ? undefined : this.state.positions.get(id);
    return index === undefined ? undefined : this.state.items[index];
  }

  private put(item: TimelineItem, before?: string): void {
    const index = this.state.positions.get(item.id);
    if (index !== undefined) {
      const previous = this.state.items[index];
      if (Object.keys(item).every((key) =>
        item[key as keyof TimelineItem] === previous[key as keyof TimelineItem])) return;
      this.items()[index] = item;
      return;
    }
    const insert = before === undefined ? undefined : this.state.positions.get(before);
    const items = this.items();
    if (insert === undefined) {
      this.map("positions").set(item.id, items.length);
      items.push(item);
    } else {
      items.splice(insert, 0, item);
      const positions = this.map("positions");
      for (let offset = insert; offset < items.length; offset += 1) {
        positions.set(items[offset].id, offset);
      }
    }
    if (item.kind === "reasoning" || (item.kind === "message" && item.role === "assistant")) {
      this.state.cycleItems = [...this.state.cycleItems, item.id];
    }
  }

  private lead(): boolean {
    const lead = !this.state.turnHasLead;
    this.state.turnHasLead = true;
    return lead;
  }

  private text(ids: readonly string[]): string {
    return ids.map((id) => this.get(id))
      .map((item) => item?.kind === "message" || item?.kind === "reasoning" ? item.content : "")
      .join("");
  }

  private finish(ids: readonly string[]): void {
    for (const id of ids) {
      const item = this.get(id);
      if (item?.kind === "message" || item?.kind === "reasoning") {
        if (item.streaming) this.put({ ...item, streaming: false });
      }
    }
  }

  private reconcile(ids: readonly string[], content: string): void {
    // Retain chronological slots for reasoning and matching response prefixes.
    // A rewritten response belongs in its final slot, with all draft tails gone.
    let offset = 0;
    let lostLead = false;
    const streamed = this.text(ids);
    const preserveSegments = this.get(ids[0])?.kind === "reasoning" ||
      content.startsWith(streamed) || streamed.startsWith(content);
    ids.forEach((id, index) => {
      const item = this.get(id);
      if (item?.kind !== "message" && item?.kind !== "reasoning") return;
      const text = !preserveSegments
        ? index === ids.length - 1 ? content : ""
        : index === ids.length - 1
          ? content.slice(offset)
          : content.slice(offset, offset + item.content.length);
      offset += text.length;
      const hidden = !text.trim();
      lostLead ||= hidden && item.turnLead === true;
      this.put({ ...item, content: text, hidden, streaming: false,
        turnLead: hidden ? false : item.turnLead });
    });
    if (lostLead) {
      const items = this.state.items;
      let start = items.length - 1;
      while (start >= 0 && !(items[start].kind === "message" &&
        (items[start] as Extract<TimelineItem, { kind: "message" }>).role === "user")) start -= 1;
      const first = items.slice(start + 1).find((item) =>
        (item.kind === "reasoning" || (item.kind === "message" && item.role === "assistant")) &&
        !item.hidden && item.content.trim());
      this.state.turnHasLead = !!first;
      if (first?.kind === "reasoning" || first?.kind === "message") {
        this.put({ ...first, turnLead: true });
      }
    }
  }

  private addReasoning(
    event: SessionEvent, content: string, streamId: string, streaming: boolean, before?: string,
  ): string {
    const first = this.get(before);
    const takeLead = first?.kind === "message" && first.turnLead === true;
    if (takeLead) this.put({ ...first, turnLead: false });
    const id = `${event.id}-reasoning`;
    this.put({
      kind: "reasoning", id, content, streamId, streaming,
      turnLead: takeLead || this.lead(), model: this.state.activeModel,
    }, before);
    this.map("reasoning").set(streamId, [...(this.state.reasoning.get(streamId) ?? []), id]);
    this.state.cycleReasoning = [...this.state.cycleReasoning, id];
    this.state.interactionReasoning = [...this.state.interactionReasoning, id];
    return id;
  }

  private finalReasoning(event: SessionEvent, content: string, streamId?: string, before?: string): void {
    const explicit = streamId ? this.state.reasoning.get(streamId) : undefined;
    if (!content.trim()) {
      if (explicit) this.finish(explicit);
      return;
    }
    if (explicit?.length) {
      this.reconcile(explicit, content);
      return;
    }
    const cycleIds = this.state.cycleReasoning;
    const cycle = this.text(cycleIds);
    // SDKs may send both assistant.reasoning and final-message reasoningText.
    // Only exact earlier content is a duplicate; distinct later cycles survive.
    const duplicate = this.state.interactionReasoning.some((id) => {
      const item = this.get(id);
      return item?.kind === "reasoning" && item.content === content;
    }) || this.text(this.state.interactionReasoning) === content || cycle === content;
    if (duplicate) {
      this.finish(cycleIds);
      if (streamId && cycle === content) this.map("reasoning").set(streamId, cycleIds);
      return;
    }
    if (cycle && content.startsWith(cycle)) {
      this.reconcile(cycleIds, content);
      if (streamId) this.map("reasoning").set(streamId, cycleIds);
      return;
    }
    if (cycle.startsWith(content)) {
      // An unkeyed summary can repeat only the first of several streams.
      // Unlike an explicit reasoningId final, it cannot discard later reasoning.
      this.finish(cycleIds);
      return;
    }
    this.finish(cycleIds);
    this.addReasoning(event, content, streamId || `${event.id}-summary`, false, before);
  }

  model(event: SessionEvent): void {
    const data = event.data ?? {};
    let model = "";
    if (event.type === "session.model_change" || event.type === "session.model_changed") {
      model = stringValue(data, "newModel", "modelId", "model");
    } else if (event.type === "session.auto_mode_resolved") {
      model = stringValue(data, "chosenModel");
    } else if (event.type === "session.start" || event.type === "session.resume") {
      model = stringValue(data, "model", "modelId", "selectedModel");
    }
    if (model) this.state.activeModel = model;
  }

  environment(event: SessionEvent): void {
    const data = event.data ?? {};
    const current = this.state.environment;
    let next: Environment;
    const countKey = ({
      "session.instructions_loaded": "instructions",
      "session.custom_agents_updated": "agents",
      "session.plugins_loaded": "plugins",
      "session.extensions_loaded": "plugins",
      "session.skills_loaded": "skills",
    } as const)[event.type as "session.instructions_loaded"];
    if (countKey) {
      const value = data[countKey] ?? data.extensions;
      next = { ...current, seen: true, [countKey]: Array.isArray(value) ? value.length : undefined };
    } else if (event.type === "session.mcp_server_status_changed") {
      const mcp = new Map(current.mcp);
      const name = stringValue(data, "serverName", "name");
      if (name) mcp.set(name, stringValue(data, "status"));
      next = { ...current, seen: true, mcp };
    } else if (event.type === "session.mcp_servers_loaded") {
      const mcp = new Map(current.mcp);
      if (Array.isArray(data.servers)) {
        for (const entry of data.servers) {
          if (!entry || typeof entry !== "object") continue;
          const server = entry as Record<string, unknown>;
          const name = stringValue(server, "name", "serverName");
          if (name) mcp.set(name, stringValue(server, "status"));
        }
      }
      next = { ...current, seen: true, mcpLoaded: true, mcp };
    } else return;
    const waiting = [...next.mcp].filter(([, status]) =>
      status === "pending" || status === "connecting").map(([name]) => name);
    const counts = (["instructions", "agents", "plugins", "skills"] as const)
      .filter((key) => next[key] !== undefined)
      .map((key) => `${next[key]} ${next[key] === 1 ? key.slice(0, -1) : key}`);
    const loaded = counts.join(", ") || "session environment";
    next.label = next.mcpLoaded && waiting.length === 0 ? null : waiting.length
      ? `Loading ${loaded} — waiting on MCP: ${waiting.join(", ")}`
      : `Loading ${loaded}…`;
    this.state.environment = next;
  }

  private subagent(event: SessionEvent): boolean {
    const data = event.data ?? {};
    const lifecycle = event.type.startsWith("subagent.");
    if (!event.agentId && !lifecycle) return false;
    const callId = stringValue(data, "toolCallId");
    let id = (event.agentId ? this.state.agents.get(event.agentId) : undefined) ??
      (callId ? this.state.agentsByTool.get(callId) : undefined);
    if (!id) id = event.agentId || callId || event.id;
    let item = this.get(id) as SubagentItem | undefined;
    if (!item || item.kind !== "subagent") {
      item = {
        kind: "subagent", id, name: "Subagent",
        description: "Earlier subagent lifecycle history is not loaded.",
        status: "unknown", timeline: [],
      };
    }
    if (event.agentId) this.map("agents").set(event.agentId, id);
    if (callId && lifecycle) this.map("agentsByTool").set(callId, id);
    if (event.type === "subagent.started") {
      item = {
        ...item, name: stringValue(data, "agentDisplayName", "agentName") || item.name,
        description: stringValue(data, "agentDescription"),
        model: stringValue(data, "model") || item.model, status: "running",
      };
      this.put(item);
      return true;
    }
    if (event.type === "subagent.completed" || event.type === "subagent.failed") {
      this.put({
        ...item,
        status: event.type === "subagent.failed" ? "failed" :
          data.cancelled === true ? "cancelled" : "completed",
        durationMs: typeof data.durationMs === "number" ? data.durationMs : undefined,
        error: stringValue(data, "error") || undefined,
        model: stringValue(data, "model") || item.model,
      });
      return true;
    }
    if (lifecycle) return true;
    const prior = this.state.children.get(id) ?? emptyState(item.model);
    const child = new Draft(prior);
    child.event({ ...event, agentId: undefined });
    this.map("children").set(id, child.state);
    const finding = event.type === "assistant.message" ? assistantMessageContent(data) : "";
    if (prior.items !== child.state.items) {
      this.put({
        ...item, timeline: child.state.items,
        preview: finding ? finding.replace(/\s+/g, " ").slice(0, 120) : item.preview,
      });
    }
    return true;
  }

  event(event: SessionEvent, liveModel?: string): void {
    if (this.subagent(event)) return;
    this.environment(event);
    this.model(event);
    const data = event.data ?? {};
    switch (event.type) {
      case "user.message": {
        this.finish(this.state.cycleItems);
        this.state.lastMessageId = undefined;
        this.state.turnHasLead = false;
        this.state.cycleItems = [];
        this.state.cycleReasoning = [];
        this.state.interactionReasoning = [];
        this.state.messages = new Map();
        this.state.reasoning = new Map();
        this.state.pendingMessages = new Map();
        this.state.pendingReasoning = new Map();
        const content = stringValue(data, "content", "message", "prompt");
        const attachments = userAttachments(data.attachments);
        if (content.trim() || attachments.length) {
          this.put({
            kind: "message", id: event.id, role: "user", content,
            ...(attachments.length ? { attachments } : {}),
          });
        }
        if (liveModel) this.state.activeModel = liveModel;
        break;
      }
      case "assistant.turn_start":
        this.finish(this.state.cycleItems);
        this.state.cycle += 1;
        this.state.cycleItems = [];
        this.state.cycleReasoning = [];
        this.state.lastMessageId = undefined;
        this.state.pendingMessages = new Map();
        this.state.pendingReasoning = new Map();
        if (liveModel) this.state.activeModel = liveModel;
        break;
      case "assistant.message_start":
        this.state.lastMessageId = stringValue(data, "messageId") || event.id;
        break;
      case "assistant.reasoning_delta": {
        let delta = stringValue(data, "deltaContent", "content");
        if (!delta) break;
        const streamId = stringValue(data, "reasoningId") || `reasoning-${this.state.cycle}`;
        const pending = this.state.pendingReasoning.get(streamId);
        if (pending) {
          delta = pending + delta;
          this.map("pendingReasoning").delete(streamId);
        }
        const last = this.state.items[this.state.items.length - 1];
        if (last?.kind === "reasoning" && last.streamId === streamId && last.streaming) {
          this.put({ ...last, content: last.content + delta });
        } else if (delta.trim()) this.addReasoning(event, delta, streamId, true);
        else this.map("pendingReasoning").set(streamId, delta);
        break;
      }
      case "assistant.message_delta": {
        let delta = stringValue(data, "deltaContent", "content", "text");
        if (!delta) break;
        const streamId = stringValue(data, "messageId") ||
          this.state.lastMessageId || `message-${this.state.cycle}`;
        const pending = this.state.pendingMessages.get(streamId);
        if (pending) {
          delta = pending + delta;
          this.map("pendingMessages").delete(streamId);
        }
        this.state.lastMessageId = streamId;
        const last = this.state.items[this.state.items.length - 1];
        if (last?.kind === "message" && last.role === "assistant" &&
            last.streamId === streamId && last.streaming) {
          this.put({ ...last, content: last.content + delta });
        } else if (delta.trim()) {
          const id = `${event.id}-message`;
          this.put({
            kind: "message", id, role: "assistant", content: delta,
            streamId, streaming: true, turnLead: this.lead(), model: this.state.activeModel,
          });
          this.map("messages").set(streamId, [...(this.state.messages.get(streamId) ?? []), id]);
        } else this.map("pendingMessages").set(streamId, delta);
        break;
      }
      case "assistant.reasoning":
        this.finalReasoning(event, stringValue(data, "content", "reasoningText"),
          stringValue(data, "reasoningId") || undefined);
        break;
      case "assistant.message": {
        const model = stringValue(data, "model", "modelId");
        if (model) {
          this.state.activeModel = model;
          for (const id of this.state.cycleItems) {
            const item = this.get(id);
            if ((item?.kind === "message" || item?.kind === "reasoning") && !item.model) {
              this.put({ ...item, model });
            }
          }
        }
        const streamId = stringValue(data, "messageId");
        const ids = streamId ? this.state.messages.get(streamId) ?? [] : [];
        const reasoning = stringValue(data, "reasoningText");
        if (reasoning.trim()) this.finalReasoning(event, reasoning, undefined, ids[0]);
        const content = assistantMessageContent(data);
        if (ids.length) this.reconcile(ids, content);
        else if (content.trim()) {
          this.put({
            kind: "message", id: event.id, role: "assistant", content,
            streamId: streamId || undefined, streaming: false,
            turnLead: this.lead(), model: this.state.activeModel,
          });
          if (streamId) this.map("messages").set(streamId, [event.id]);
        }
        this.state.lastMessageId = undefined;
        break;
      }
      case "assistant.turn_end":
      case "session.idle":
        this.finish(this.state.cycleItems);
        this.state.lastMessageId = undefined;
        break;
      case "assistant.tool_call_delta":
      case "tool.execution_start": {
        const callId = stringValue(data, "toolCallId", "callId", "id") || event.id;
        const existing = this.get(this.state.tools.get(callId));
        const previous = existing?.kind === "tool" ? existing : undefined;
        const preparing = event.type === "assistant.tool_call_delta";
        const delta = stringValue(data, "inputDelta", "deltaContent", "content");
        const args = data.arguments ?? data.input ?? parseToolInput(previous?.inputBuffer);
        const item: Extract<TimelineItem, { kind: "tool" }> = {
          ...(previous ?? {
            kind: "tool", id: event.id, callId, name: "tool", progress: [],
          }),
          name: stringValue(data, "toolName", "name") || previous?.name || "tool",
          state: preparing ? previous?.state ?? "preparing" : "running",
          ...(preparing
            ? { inputBuffer: `${previous?.inputBuffer ?? ""}${delta}` }
            : { arguments: args, detail: summarizeArguments(args) }),
        };
        this.put(item);
        if (!previous) this.map("tools").set(callId, item.id);
        break;
      }
      case "tool.execution_progress":
      case "tool.execution_partial_result":
      case "tool.execution_complete": {
        const callId = stringValue(data, "toolCallId", "callId", "id");
        const item = this.get(this.state.tools.get(callId));
        if (item?.kind !== "tool") break;
        if (event.type === "tool.execution_complete") {
          this.put({ ...item, state: data.success === false || data.error ? "failed" : "done",
            result: data.result ?? data.error });
        } else {
          const update = stringValue(data, "progressMessage", "partialOutput", "message");
          if (update) this.put({ ...item, progress: [...item.progress, update] });
        }
        break;
      }
      case "command.result":
        this.put({ kind: "command", id: event.id,
          command: stringValue(data, "command") || "Slash command", result: data.result });
        break;
      case "session.compaction_start":
        this.put({ kind: "status", id: event.id, label: "Compacting context" });
        break;
    }
  }
}

function parseToolInput(input?: string): unknown {
  if (!input) return undefined;
  try { return JSON.parse(input); } catch { return input; }
}

export function assistantMessageContent(data: Record<string, unknown>): string {
  const direct = stringValue(data, "content", "message");
  if (direct) return direct;
  for (const candidate of [data.message, data.response]) {
    if (!candidate || typeof candidate !== "object") continue;
    const content = stringValue(candidate as Record<string, unknown>, "content", "text");
    if (content) return content;
  }
  if (!Array.isArray(data.content)) return "";
  return data.content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    const value = part as Record<string, unknown>;
    if (typeof value.type === "string" && !["text", "output_text"].includes(value.type)) return "";
    return stringValue(value, "text", "content");
  }).join("");
}

function stringValue(data: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    if (typeof data[key] === "string") return data[key];
  }
  return "";
}

function summarizeArguments(value: unknown): string | undefined {
  if (!value) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 90 ? `${text.slice(0, 87)}...` : text;
}

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_BASE64_LENGTH = Math.ceil(8 * 1024 * 1024 / 3) * 4;

function userAttachments(value: unknown): TimelineAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    if (typeof entry === "string") {
      return entry.trim() ? [{ name: attachmentName(entry) }] : [];
    }
    if (!entry || typeof entry !== "object") return [];
    const attachment = entry as Record<string, unknown>;
    const path = stringValue(attachment, "path");
    const displayName = stringValue(attachment, "displayName", "name", "fileName", "filename");
    const mimeType = stringValue(attachment, "mimeType", "mediaType").toLowerCase();
    const blob = attachment.type === "blob";
    if (!displayName && !path && !blob) return [];
    const name = attachmentName(displayName || path ||
      (mimeType.startsWith("image/") ? `Image ${index + 1}` : `Attachment ${index + 1}`));
    const data = attachment.data;
    // Only explicit, bounded inline raster bytes are previewable. A file/path or
    // URL attachment is a name, never permission to read local or remote content.
    const image = blob && IMAGE_MIME_TYPES.has(mimeType) &&
      typeof data === "string" && data.length > 0 && data.length <= MAX_IMAGE_BASE64_LENGTH
      ? { mimeType, data } : undefined;
    return [{ name, ...(image ? { image } : {}) }];
  });
}

function attachmentName(value: string): string {
  const name = value.replace(/\\/g, "/").split("/").filter(Boolean).pop() || "Attachment";
  return name.length > 180 ? `${name.slice(0, 177)}…` : name;
}

/** Decoding is deferred by the view until the thumbnail approaches the viewport. */
export function decodeAttachmentImage(attachment: TimelineAttachment): Uint8Array | undefined {
  const image = attachment.image;
  if (!image || !IMAGE_MIME_TYPES.has(image.mimeType) || image.data.length > MAX_IMAGE_BASE64_LENGTH) {
    return undefined;
  }
  try {
    const binary = atob(image.data);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const valid = image.mimeType === "image/png"
      ? binary.startsWith("\x89PNG\r\n\x1a\n")
      : image.mimeType === "image/jpeg"
        ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        : image.mimeType === "image/gif"
          ? binary.startsWith("GIF87a") || binary.startsWith("GIF89a")
          : binary.startsWith("RIFF") && binary.slice(8, 12) === "WEBP";
    return valid ? bytes : undefined;
  } catch {
    return undefined;
  }
}
