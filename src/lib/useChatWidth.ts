import { useEffect, useState } from "react";
import { CHAT_WIDTH_KEY, normalizeChatWidth, type ChatWidth } from "./chatWidth";

export function useChatWidth() {
  const [initial] = useState<{ width: ChatWidth; error: string }>(() => {
    try { return { width: normalizeChatWidth(localStorage.getItem(CHAT_WIDTH_KEY)), error: "" }; }
    catch (cause) { return { width: "readable", error: `Could not read chat layout: ${String(cause)}` }; }
  });
  const [width, setWidth] = useState(initial.width);
  const [error, setError] = useState(initial.error);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== null && event.key !== CHAT_WIDTH_KEY) return;
      try {
        if (event.storageArea !== localStorage) return;
        setWidth(normalizeChatWidth(event.newValue));
        setError("");
      } catch (cause) { setError(`Could not sync chat layout: ${String(cause)}`); }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  return {
    width, error,
    setWidth: (value: ChatWidth) => {
      const next = normalizeChatWidth(value);
      setWidth(next);
      try { localStorage.setItem(CHAT_WIDTH_KEY, next); setError(""); }
      catch (cause) { setError(`Could not save chat layout: ${String(cause)}. Change applies only to this window.`); }
    },
  };
}
