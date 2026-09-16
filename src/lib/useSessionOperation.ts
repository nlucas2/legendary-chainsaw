import { useCallback, useReducer, useState } from "react";
import { SessionOperations } from "./sessionOperations";

export function useSessionOperation() {
  const [operations] = useState(() => new SessionOperations());
  const [revision, redraw] = useReducer((revision: number) => revision + 1, 0);
  const start = useCallback((sessionId: string, value = "pending") => {
    const token = operations.start(sessionId, value);
    if (token) redraw();
    return token;
  }, [operations]);
  const finish = useCallback((sessionId: string, token: symbol) => {
    if (operations.finish(sessionId, token)) redraw();
  }, [operations]);
  return { operations, start, finish, revision };
}
