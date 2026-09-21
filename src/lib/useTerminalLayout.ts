import { useEffect, useState } from "react";
import { DEFAULT_TERMINAL_LAYOUT, normalizeTerminalLayout, resizedTerminal, type TerminalLayout } from "./workspaceLayout";

const KEY = "copilot-sessions.terminal-layout";
export function useTerminalLayout() {
  const [error, setError] = useState("");
  const [layout, setLayout] = useState<TerminalLayout>(DEFAULT_TERMINAL_LAYOUT);
  const [ready, setReady] = useState(false);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved) setLayout(normalizeTerminalLayout(JSON.parse(saved)));
    } catch (cause) { setError(`Could not load terminal layout: ${String(cause)}`); }
    setReady(true);
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => {
      try { localStorage.setItem(KEY, JSON.stringify(layout)); }
      catch (cause) { setError(`Could not save terminal layout: ${String(cause)}`); }
    }, 250);
    return () => clearTimeout(timer);
  }, [layout, ready]);
  return {
    layout, setLayout, error, viewport,
    width: resizedTerminal("right", layout.width, 0, viewport.width, viewport.height),
    height: resizedTerminal("bottom", layout.height, 0, viewport.width, viewport.height),
  };
}
