export interface KeyBinding {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export const KEYBINDINGS_KEY = "copilot-sessions.keybindings";
export const binding = (key: string, modifiers: Partial<Omit<KeyBinding, "key">> = {}): KeyBinding =>
  ({ key: key.length === 1 ? key.toLowerCase() : key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers });
const ctrl = (key: string, shiftKey = false) => binding(key, { ctrlKey: true, shiftKey });
const primary = (key: string, shiftKey = false) => [ctrl(key, shiftKey), binding(key, { metaKey: true, shiftKey })];
const alt = (key: string) => binding(key, { altKey: true });

export const SHORTCUT_ACTIONS = [
  { id: "nextSession", label: "Next session", group: "Navigation", description: "Cycle forward in sidebar order. Inactive sessions preview until Enter.", defaults: [ctrl("Tab"), binding("ArrowDown", { ctrlKey: true, altKey: true })] },
  { id: "previousSession", label: "Previous session", group: "Navigation", description: "Cycle backward in sidebar order. Inactive sessions preview until Enter.", defaults: [ctrl("Tab", true), binding("ArrowUp", { ctrlKey: true, altKey: true })] },
  { id: "toggleTerminal", label: "Toggle terminal", group: "Navigation", description: "Show or hide the terminal, including when the terminal has focus.", defaults: primary("t", true) },
  { id: "toggleSidebar", label: "Toggle sessions sidebar", group: "Navigation", description: "Show or hide the session list.", defaults: primary("b", true) },
  { id: "newSession", label: "New session", group: "Navigation", description: "Open the new-session dialog; does not create a session until confirmed.", defaults: primary("n") },
  { id: "focusPrompt", label: "Focus prompt", group: "Navigation", description: "Focus the parent or selected subagent composer, outside other text fields.", defaults: primary("k") },
  { id: "nextRegion", label: "Next workspace region", group: "Navigation", description: "Move focus through prompt, conversation, session search, and terminal.", defaults: [binding("F6")] },
  { id: "previousRegion", label: "Previous workspace region", group: "Navigation", description: "Move focus backward through workspace regions.", defaults: [binding("F6", { shiftKey: true })] },
  { id: "showShortcuts", label: "Keyboard shortcuts", group: "Navigation", description: "Open this editor from outside text fields.", defaults: [binding("?", { shiftKey: true }), ...primary("/")] },
  { id: "stopTurn", label: "Stop current turn", group: "Conversation", description: "Stop the current parent turn. Dialog Escape still closes dialogs. Ctrl C only stops outside text fields when nothing is selected.", defaults: [binding("Escape"), ...primary("."), ctrl("c")] },
  { id: "toggleReasoning", label: "Toggle reasoning", group: "Conversation", description: "Expand or collapse reasoning in the parent transcript.", defaults: primary("t") },
  { id: "toggleTools", label: "Toggle tool details", group: "Conversation", description: "Expand or collapse tool details, outside text fields.", defaults: primary("o") },
  { id: "expandDetails", label: "Expand transcript details", group: "Conversation", description: "Expand reasoning and tool details, outside text fields.", defaults: primary("e") },
  { id: "removeQueued", label: "Remove newest queued prompt", group: "Conversation", description: "Remove the newest native queued item from this session.", defaults: primary("Backspace", true) },
  { id: "interactiveMode", label: "Interactive mode", group: "Composer", description: "Switch the parent session to Interactive mode.", defaults: [alt("1")] },
  { id: "planMode", label: "Plan mode", group: "Composer", description: "Switch the parent session to Plan mode.", defaults: [alt("2")] },
  { id: "autopilotMode", label: "Autopilot mode", group: "Composer", description: "Switch the parent session to Autopilot mode; existing permission policy is unchanged.", defaults: [alt("3")] },
  { id: "cycleMode", label: "Cycle agent mode", group: "Composer", description: "Cycle Interactive, Plan, and Autopilot while the parent composer is focused.", defaults: [binding("Tab"), binding("Tab", { shiftKey: true })] },
  { id: "queuePrompt", label: "Send or enqueue prompt", group: "Composer", description: "Submit the parent draft with Queue delivery, even while a turn is running.", defaults: primary("q") },
  { id: "steerPrompt", label: "Steer the running turn", group: "Composer", description: "Submit the parent draft as immediate guidance. Plain Enter still follows the composer delivery setting.", defaults: primary("Enter") },
  { id: "stashPrompt", label: "Stash or restore draft", group: "Composer", description: "Swap the current parent draft with its stashed draft.", defaults: primary("s") },
  { id: "olderPrompt", label: "Earlier prompt", group: "Composer", description: "Recall earlier session input at the first visual composer line. Draft and attachments are preserved.", defaults: [binding("ArrowUp")] },
  { id: "newerPrompt", label: "Later prompt", group: "Composer", description: "Recall later input at the last visual composer line, eventually restoring your draft.", defaults: [binding("ArrowDown")] },
  { id: "openCommands", label: "Open command palette", group: "Composer", description: "Start a slash command outside text fields. Typing / in a prompt always remains ordinary input.", defaults: [binding("/")] },
] as const;

export type ShortcutAction = typeof SHORTCUT_ACTIONS[number]["id"];
export type KeybindingOverrides = Partial<Record<ShortcutAction, KeyBinding[]>>;
export type KeyEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey"> & {
  isComposing?: boolean;
  getModifierState?: (key: string) => boolean;
};

export const isShortcutAction = (value: string): value is ShortcutAction => SHORTCUT_ACTIONS.some((action) => action.id === value);
export const keyId = (key: KeyBinding) => `${key.ctrlKey}/${key.altKey}/${key.shiftKey}/${key.metaKey}/${key.key}`;
export function actionBindings(overrides: KeybindingOverrides, action: ShortcutAction): readonly KeyBinding[] {
  return overrides[action] ?? SHORTCUT_ACTIONS.find((item) => item.id === action)!.defaults;
}

export function eventBinding(event: KeyEvent): KeyBinding | null {
  if (event.isComposing || event.getModifierState?.("AltGraph") ||
      ["Control", "Shift", "Alt", "Meta", "AltGraph", "Dead", "Process", "Unidentified"].includes(event.key)) return null;
  return binding(event.key, { ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey });
}

export function matchesAction(overrides: KeybindingOverrides, action: ShortcutAction, event: KeyEvent, desktop: boolean): boolean {
  const key = eventBinding(event);
  if (!key || (!desktop && key.key === "Tab" && key.ctrlKey)) return false;
  return actionBindings(overrides, action).some((candidate) => keyId(candidate) === keyId(key));
}

export function formatBinding(key: KeyBinding): string {
  const label = key.key === "Escape" ? "Esc" : key.key.startsWith("Arrow") ? key.key.slice(5)
    : key.key === " " ? "Space" : key.key.length === 1 ? key.key.toUpperCase() : key.key;
  return [key.ctrlKey && "Ctrl", key.metaKey && "Cmd", key.altKey && "Alt",
    key.shiftKey && key.key !== "?" && "Shift", label].filter(Boolean).join(" ");
}

export function ariaBindings(overrides: KeybindingOverrides, action: ShortcutAction): string | undefined {
  return actionBindings(overrides, action).map((key) =>
    [key.ctrlKey && "Control", key.metaKey && "Meta", key.altKey && "Alt", key.shiftKey && "Shift",
      key.key === " " ? "Space" : key.key].filter(Boolean).join("+")).join(" ") || undefined;
}

export function bindingWarning(key: KeyBinding): string | null {
  if (key.ctrlKey && key.key === "Tab") return "Desktop app only; the web app never handles Ctrl Tab.";
  if ((key.ctrlKey || key.metaKey) && ["n", "t", "w", "q", "r", "l", "p", "s", "f"].includes(key.key)) {
    return "A browser or operating system may reserve this combination.";
  }
  return null;
}

function bindingError(action: ShortcutAction, key: KeyBinding): string | null {
  const validKey = key.key.length === 1 || /^(?:F(?:[1-9]|1[0-9]|2[0-4])|Arrow(?:Up|Down|Left|Right)|Escape|Tab|Enter|Backspace|Delete|Home|End|PageUp|PageDown)$/.test(key.key);
  if (!validKey || /[\r\n\t]/.test(key.key)) return "Choose a supported key, not a modifier by itself.";
  if (key.ctrlKey && key.metaKey) return "Use Ctrl or Cmd, not both together.";
  if ((key.ctrlKey || key.metaKey) && !key.altKey && ["c", "v", "x", "a", "z", "y"].includes(key.key)) {
    if (!(action === "stopTurn" && key.ctrlKey && !key.metaKey && !key.shiftKey && key.key === "c")) {
      return "That combination is reserved for text selection, clipboard, or undo.";
    }
  }
  if (key.ctrlKey || key.metaKey || key.altKey || /^F\d+$/.test(key.key)) return null;
  if (key.key === "Escape") return action === "stopTurn" && !key.shiftKey ? null : "Escape is reserved for dismissal and Stop.";
  if (key.key === "Tab") return action === "cycleMode" ? null : "Plain Tab is reserved for focus and composer mode cycling.";
  if (key.key === "ArrowUp" && action === "olderPrompt" && !key.shiftKey) return null;
  if (key.key === "ArrowDown" && action === "newerPrompt" && !key.shiftKey) return null;
  if (key.key === "/" && action === "openCommands" && !key.shiftKey) return null;
  if (key.key === "?" && action === "showShortcuts") return null;
  return "Use Ctrl, Cmd, Alt, or a function key so normal typing and caret movement stay available.";
}

export function validateBindings(overrides: KeybindingOverrides): string | null {
  const owners = new Map<string, string>();
  for (const action of SHORTCUT_ACTIONS) {
    const keys = actionBindings(overrides, action.id);
    if (keys.length > 4) return `${action.label}: at most four bindings are supported.`;
    for (const key of keys) {
      const invalid = bindingError(action.id, key);
      if (invalid) return `${action.label}: ${invalid}`;
      const previous = owners.get(keyId(key));
      if (previous) return `${formatBinding(key)} is already assigned to ${previous}. Clear it there first.`;
      owners.set(keyId(key), action.label);
    }
  }
  return null;
}

export function readKeybindings(raw: string | null): { overrides: KeybindingOverrides; error: string } {
  if (raw === null) return { overrides: {}, error: "" };
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 ||
        !("bindings" in value) || !value.bindings || typeof value.bindings !== "object" || Array.isArray(value.bindings)) {
      throw new Error("Invalid shortcut settings format.");
    }
    const overrides: KeybindingOverrides = {};
    for (const [action, keys] of Object.entries(value.bindings)) {
      if (!isShortcutAction(action) || !Array.isArray(keys)) throw new Error("Unknown shortcut action or invalid bindings.");
      overrides[action] = keys.map((key: unknown) => {
        if (!key || typeof key !== "object" || !("key" in key) || typeof key.key !== "string" ||
            !("ctrlKey" in key) || typeof key.ctrlKey !== "boolean" || !("altKey" in key) || typeof key.altKey !== "boolean" ||
            !("shiftKey" in key) || typeof key.shiftKey !== "boolean" || !("metaKey" in key) || typeof key.metaKey !== "boolean") {
          throw new Error("Invalid shortcut key.");
        }
        return binding(key.key, { ctrlKey: key.ctrlKey, altKey: key.altKey, shiftKey: key.shiftKey, metaKey: key.metaKey });
      });
    }
    const invalid = validateBindings(overrides);
    if (invalid) throw new Error(invalid);
    return { overrides, error: "" };
  } catch (cause) {
    return { overrides: {}, error: `Could not load shortcuts: ${String(cause)} Using defaults.` };
  }
}
