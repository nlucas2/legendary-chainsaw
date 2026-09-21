export type TerminalDock = "right" | "top" | "bottom";
export interface TerminalLayout {
  dock: TerminalDock;
  width: number;
  height: number;
}
export const DEFAULT_TERMINAL_LAYOUT: TerminalLayout = { dock: "top", width: 520, height: 320 };
export const SIDEBAR_WIDTH_KEY = "copilot-sessions.sidebar-width";

export function normalizeSidebarWidth(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? Math.round(Math.max(200, Math.min(560, raw))) : null;
}

export function sidebarSizeLimits(viewportWidth: number, terminalBeside: boolean) {
  const remaining = terminalBeside ? (viewportWidth <= 1120 ? 330 : 380) + 240 + 5 : 420;
  return { min: 200, max: Math.max(200, Math.min(560, viewportWidth - remaining)) };
}

export function sidebarSize(preferred: number | null, viewportWidth: number, terminalBeside: boolean) {
  const { min, max } = sidebarSizeLimits(viewportWidth, terminalBeside);
  return Math.round(Math.max(min, Math.min(max, preferred ?? (viewportWidth <= 1120 ? 230 : 272))));
}

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

export function terminalSizeLimits(dock: TerminalDock, width: number, height: number, sidebarWidth = width <= 1120 ? 230 : 272) {
  const compact = width <= 1120;
  const stacked = dock !== "right";
  const total = stacked ? height : width - sidebarWidth;
  const remaining = stacked ? 240 : compact ? 330 : 380;
  const min = stacked ? 180 : Math.max(180, Math.min(compact ? 340 : 240, total - remaining - 5));
  return { min, max: Math.max(min, Math.floor(Math.min(total * .72, total - remaining - 5))) };
}

export function resizedTerminal(dock: TerminalDock, current: number, delta: number, width: number, height: number, sidebarWidth?: number) {
  const { min, max } = terminalSizeLimits(dock, width, height, sidebarWidth);
  return Math.round(Math.max(min, Math.min(max, current + (dock === "top" ? delta : -delta))));
}
