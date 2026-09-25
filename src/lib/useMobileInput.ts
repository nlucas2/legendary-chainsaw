import { useEffect, useState } from "react";

function useMediaMatch(condition: string) {
  const [mobile, setMobile] = useState(() => window.matchMedia(condition).matches);
  useEffect(() => {
    const query = window.matchMedia(condition);
    const sync = () => setMobile(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, [condition]);
  return mobile;
}

export function useMobileInput() {
  return useMediaMatch("(max-width: 820px), (pointer: coarse)");
}

export function useNarrowLayout() {
  return useMediaMatch("(max-width: 820px)");
}
