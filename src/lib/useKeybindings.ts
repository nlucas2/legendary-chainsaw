import { useEffect, useState } from "react";
import { KEYBINDINGS_KEY, readKeybindings, validateBindings, type KeyBinding, type KeybindingOverrides, type ShortcutAction } from "./keybindings";

export function useKeybindings() {
  const [state, setState] = useState(() => {
    try { return readKeybindings(localStorage.getItem(KEYBINDINGS_KEY)); }
    catch (cause) { return { overrides: {}, error: `Could not read shortcuts: ${String(cause)}. Using defaults.` }; }
  });
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== null && event.key !== KEYBINDINGS_KEY) return;
      try {
        if (event.storageArea === localStorage) setState(readKeybindings(event.newValue));
      } catch (cause) { setState((current) => ({ ...current, error: `Could not sync shortcuts: ${String(cause)}` })); }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  function save(overrides: KeybindingOverrides): boolean {
    const invalid = validateBindings(overrides);
    if (invalid) { setState((current) => ({ ...current, error: invalid })); return false; }
    try {
      if (Object.keys(overrides).length) localStorage.setItem(KEYBINDINGS_KEY, JSON.stringify({ version: 1, bindings: overrides }));
      else localStorage.removeItem(KEYBINDINGS_KEY);
      setState({ overrides, error: "" });
    } catch (cause) {
      setState({ overrides, error: `Could not save shortcuts: ${String(cause)}. Changes apply only to this window.` });
    }
    return true;
  }
  return {
    ...state,
    setBindings(action: ShortcutAction, keys: KeyBinding[]) { return save({ ...state.overrides, [action]: keys }); },
    reset(action: ShortcutAction) {
      const next = { ...state.overrides };
      delete next[action];
      return save(next);
    },
    resetAll() { return save({}); },
  };
}

export type KeybindingsController = ReturnType<typeof useKeybindings>;
