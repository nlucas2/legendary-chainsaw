export const CHAT_WIDTH_KEY = "copilot-sessions.chat-width";
export type ChatWidth = "readable" | "full";
export function normalizeChatWidth(value: unknown): ChatWidth {
  return value === "full" ? "full" : "readable";
}
