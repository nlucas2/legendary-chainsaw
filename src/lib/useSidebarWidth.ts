import { useEffect, useState } from "react";
import { normalizeSidebarWidth, sidebarSize, sidebarSizeLimits, SIDEBAR_WIDTH_KEY } from "./workspaceLayout";

export function useSidebarWidth(viewportWidth: number, terminalBeside: boolean) {
  const [initial] = useState(() => {
    try { return { width: normalizeSidebarWidth(JSON.parse(localStorage.getItem(SIDEBAR_WIDTH_KEY) ?? "null")), error: "" }; }
    catch (cause) { return { width: null, error: `Could not load sidebar width: ${String(cause)}` }; }
  });
  const [preferred, setPreferred] = useState(initial.width);
  const [error, setError] = useState(initial.error);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== null && event.key !== SIDEBAR_WIDTH_KEY) return;
      try {
        if (event.storageArea !== localStorage) return;
        setPreferred(normalizeSidebarWidth(JSON.parse(event.newValue ?? "null")));
        setError("");
      } catch (cause) { setError(`Could not sync sidebar width: ${String(cause)}`); }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  return {
    width: sidebarSize(preferred, viewportWidth, terminalBeside),
    ...sidebarSizeLimits(viewportWidth, terminalBeside),
    error,
    setWidth: (value: number | null) => {
      const next = normalizeSidebarWidth(value);
      setPreferred(next);
      try {
        if (next === null) localStorage.removeItem(SIDEBAR_WIDTH_KEY);
        else localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
        setError("");
      } catch (cause) { setError(`Could not save sidebar width: ${String(cause)}. Change applies only to this window.`); }
    },
  };
}
