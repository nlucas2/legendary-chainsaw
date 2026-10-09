import { useEffect, useState } from "react";
import { MODEL_DEFAULTS_KEY, readModelDefaults } from "./modelDefaults";
import type { ModelSelectionValue } from "./models";

export function useModelDefaults() {
  const [state, setState] = useState(() => {
    try { return readModelDefaults(localStorage.getItem(MODEL_DEFAULTS_KEY)); }
    catch (cause) { return { ...readModelDefaults(null), error: `Could not read the new-session model default: ${String(cause)}.` }; }
  });
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== null && event.key !== MODEL_DEFAULTS_KEY) return;
      try {
        if (event.storageArea === localStorage) setState(readModelDefaults(event.newValue));
      } catch (cause) { setState((current) => ({ ...current, error: `Could not sync the model default: ${String(cause)}.` })); }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  function save(value: ModelSelectionValue | null): boolean {
    try {
      if (value) localStorage.setItem(MODEL_DEFAULTS_KEY, JSON.stringify({ version: 1, selection: value }));
      else localStorage.removeItem(MODEL_DEFAULTS_KEY);
      setState(value ? { value, error: "" } : readModelDefaults(null));
      return true;
    } catch (cause) {
      setState((current) => ({ ...current, error: `Could not save the new-session model default: ${String(cause)}. The saved default was not changed.` }));
      return false;
    }
  }
  return { ...state, save: (value: ModelSelectionValue) => save(value), reset: () => save(null) };
}

export type ModelDefaultsController = ReturnType<typeof useModelDefaults>;
