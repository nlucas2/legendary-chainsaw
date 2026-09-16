import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import {
  DEFAULT_TYPOGRAPHY,
  TYPOGRAPHY_STORAGE_KEY,
  normalizeTypography,
  parseTypographyPreferences,
  readTypographyPreferences,
  typographyAttributes,
  typographyVariables,
  writeTypographyPreferences,
  type TypographyLoadResult,
  type TypographySettings,
} from "./typography";
import "../typography.css";

export interface TypographyController {
  settings: TypographySettings;
  setSettings: (value: SetStateAction<TypographySettings>) => void;
  error: string;
  reset: () => void;
}

function load(): TypographyLoadResult {
  if (typeof window === "undefined") return { settings: { ...DEFAULT_TYPOGRAPHY }, error: "" };
  try {
    return readTypographyPreferences(window.localStorage);
  } catch (cause) {
    return { settings: { ...DEFAULT_TYPOGRAPHY }, error: `Could not load typography: ${String(cause)}` };
  }
}

export function useTypography(): TypographyController {
  const [initial] = useState(load);
  const [settings, updateSettings] = useState(initial.settings);
  const [error, setError] = useState(initial.error);
  const current = useRef(settings);

  const setSettings = useCallback((value: SetStateAction<TypographySettings>) => {
    const next = normalizeTypography(typeof value === "function" ? value(current.current) : value);
    current.current = next;
    updateSettings(next);
    try {
      setError(writeTypographyPreferences(window.localStorage, next));
    } catch (cause) {
      setError(`Could not save typography: ${String(cause)}. Changes apply only to this window.`);
    }
  }, []);

  const reset = useCallback(() => {
    const next = { ...DEFAULT_TYPOGRAPHY };
    current.current = next;
    updateSettings(next);
    try {
      window.localStorage.removeItem(TYPOGRAPHY_STORAGE_KEY);
      setError("");
    } catch (cause) {
      setError(`Could not reset saved typography: ${String(cause)}. Reset applies only to this window.`);
    }
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== TYPOGRAPHY_STORAGE_KEY) return;
      try {
        if (event.storageArea !== window.localStorage) return;
        const next = parseTypographyPreferences(event.newValue);
        current.current = next.settings;
        updateSettings(next.settings);
        setError(next.error);
      } catch (cause) {
        setError(`Could not sync typography: ${String(cause)}`);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const variables = typographyVariables(settings);
    const attributes = typographyAttributes(settings);
    const previousAttributes = Object.keys(attributes).map((key) => [key, root.getAttribute(key)] as const);
    const previous = Object.keys(variables).map((key) => [key, root.style.getPropertyValue(key)] as const);
    for (const [key, value] of Object.entries(attributes)) root.setAttribute(key, value);
    for (const [key, value] of Object.entries(variables)) root.style.setProperty(key, value);
    return () => {
      for (const [key, value] of previous) {
        if (value) root.style.setProperty(key, value);
        else root.style.removeProperty(key);
      }
      for (const [key, value] of previousAttributes) {
        if (value === null) root.removeAttribute(key);
        else root.setAttribute(key, value);
      }
    };
  }, [settings]);

  return { settings, setSettings, error, reset };
}
