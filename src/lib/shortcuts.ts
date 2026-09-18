type ShortcutEvent = Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "isComposing">;

export function isTerminalToggle(event: ShortcutEvent): boolean {
  if (event.isComposing || event.key.toLowerCase() !== "t") return false;
  return !event.altKey && event.shiftKey && (event.ctrlKey || event.metaKey);
}

export function isTerminalCopy(event: ShortcutEvent, hasSelection: boolean): boolean {
  return hasSelection && !event.isComposing && !event.altKey && !event.shiftKey
    && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c";
}
