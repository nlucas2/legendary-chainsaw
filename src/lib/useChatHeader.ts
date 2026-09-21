import { useEffect, useState } from "react";

const KEY = "copilot-sessions.chat-header";
function read(value: string | null) {
  return {
    collapsed: value === "compact",
    error: value === null || value === "expanded" || value === "compact" ? "" : "Saved chat header preference is invalid; showing the full header.",
  };
}

export function useChatHeader() {
  const [state, setState] = useState(() => {
    try { return read(localStorage.getItem(KEY)); }
    catch (cause) { return { collapsed: false, error: `Could not read chat header preference: ${String(cause)}` }; }
  });
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== null && event.key !== KEY) return;
      try {
        if (event.storageArea === localStorage) setState(read(event.newValue));
      } catch (cause) { setState((current) => ({ ...current, error: `Could not sync chat header preference: ${String(cause)}` })); }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  return {
    ...state,
    setCollapsed(collapsed: boolean) {
      try {
        localStorage.setItem(KEY, collapsed ? "compact" : "expanded");
        setState({ collapsed, error: "" });
      } catch (cause) {
        setState({ collapsed, error: `Could not save chat header preference: ${String(cause)}. Change applies only to this window.` });
      }
    },
  };
}
