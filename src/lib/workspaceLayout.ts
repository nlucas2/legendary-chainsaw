export type TerminalDock = "right" | "top" | "bottom";
export interface TerminalLayout {
  dock: TerminalDock;
  width: number;
  height: number;
}
export const DEFAULT_TERMINAL_LAYOUT: TerminalLayout = { dock: "top", width: 520, height: 320 };

export function normalizeTerminalLayout(raw: unknown): TerminalLayout {
  const data = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const size = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value)
    ? Math.round(Math.max(180, Math.min(1800, value))) : fallback;
  return {
    dock: data.dock === "bottom" || data.dock === "right" || data.dock === "top" ? data.dock : DEFAULT_TERMINAL_LAYOUT.dock,
    width: size(data.width, DEFAULT_TERMINAL_LAYOUT.width),
    height: size(data.height, DEFAULT_TERMINAL_LAYOUT.height),
  };
}

export function terminalSizeLimits(dock: TerminalDock, width: number, height: number) {
  const compact = width <= 1120;
  const stacked = dock !== "right";
  const total = stacked ? height : width - (compact ? 230 : 272);
  const min = stacked ? 180 : compact ? 340 : 240;
  const remaining = stacked ? 240 : compact ? 330 : 380;
  return { min, max: Math.max(min, Math.floor(Math.min(total * .72, total - remaining - 5))) };
}

export function resizedTerminal(dock: TerminalDock, current: number, delta: number, width: number, height: number) {
  const { min, max } = terminalSizeLimits(dock, width, height);
  return Math.round(Math.max(min, Math.min(max, current + (dock === "top" ? delta : -delta))));
}
