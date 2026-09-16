import type { SessionEvent } from "./types.ts";

export interface MessageOrigin {
  kind: "human" | "agent" | "skill" | "unknown";
  label: string;
  description: string;
}

// The runtime's user role includes inter-agent prompts and injected context.
export function messageOrigin(source: unknown, subagentConversation = false): MessageOrigin {
  if (source === "user") return { kind: "human", label: "You", description: "User input." };
  if (source === undefined || source === null || source === "") {
    return subagentConversation
      ? { kind: "unknown", label: "Instruction", description: "The runtime did not record who sent this subagent input." }
      : { kind: "human", label: "You", description: "User input (default session source)." };
  }
  if (typeof source === "string" && source.startsWith("agent-") && source.length > 6) {
    return { kind: "agent", label: "Agent instruction", description: `Sent by an agent. Source: ${source}` };
  }
  if (typeof source === "string" && source.startsWith("skill-") && source.length > 6) {
    return { kind: "skill", label: "Skill instructions", description: `Injected skill context. Source: ${source}` };
  }
  return {
    kind: "unknown", label: "Input",
    description: typeof source === "string" ? `Sender not identified. Source: ${source}` : "The runtime supplied unrecognized source metadata.",
  };
}

export function isHumanMessage(event: SessionEvent): boolean {
  return event.type === "user.message" && !event.agentId && messageOrigin(event.data.source).kind === "human";
}
