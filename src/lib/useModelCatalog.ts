import { useEffect, useState } from "react";
import { daemonInvoke } from "./daemon";
import { DEFAULT_MODEL_SELECTION, normalizeModelOptions, type ModelOption, type ModelSelectionValue } from "./models";

interface CatalogState {
  active: boolean;
  scope: string;
  loading: boolean;
  error: string;
  options: ModelOption[];
  current: ModelSelectionValue | null;
}

export function useModelCatalog(active: boolean, sessionId?: string) {
  const scope = sessionId ?? "";
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<CatalogState>({ active: false, scope, loading: true, error: "", options: [], current: null });
  useEffect(() => {
    if (!active) {
      setState((previous) => previous.active ? { ...previous, active: false, loading: true, error: "" } : previous);
      return;
    }
    const controller = new AbortController();
    setState((previous) => ({ active: true, scope, loading: true, error: "", options: previous.scope === scope ? previous.options : [], current: null }));
    void daemonInvoke<{ models?: unknown[]; current?: Partial<ModelSelectionValue>; available?: { list?: unknown[] } }>(
      sessionId ? "model_info" : "available_models", sessionId ? { sessionId } : {}, controller.signal,
    ).then((result) => {
      if (controller.signal.aborted) return;
      const models = sessionId ? result.available?.list : result.models;
      if (!Array.isArray(models)) throw new Error("The runtime did not return a model catalog.");
      const current = result.current;
      if (sessionId && (!current || typeof current.modelId !== "string" || !current.modelId)) {
        throw new Error("The runtime did not identify the current session model.");
      }
      if (current && ((current.reasoningEffort != null && typeof current.reasoningEffort !== "string") ||
          (current.contextTier != null && typeof current.contextTier !== "string") ||
          (current.reasoningSummary != null && !["none", "concise", "detailed"].includes(current.reasoningSummary)))) {
        throw new Error("The runtime returned invalid model configuration.");
      }
      setState({ active: true, scope, loading: false, error: "", options: normalizeModelOptions(models),
        current: current && typeof current.modelId === "string" ? { modelId: current.modelId, reasoningEffort: current.reasoningEffort ?? "",
          contextTier: current.contextTier === "default" ? "" : current.contextTier ?? "",
          reasoningSummary: current.reasoningSummary ?? DEFAULT_MODEL_SELECTION.reasoningSummary } : null });
    }).catch((cause) => {
      if (!controller.signal.aborted) setState((previous) => ({ ...previous, loading: false,
        error: cause instanceof Error ? cause.message : String(cause) }));
    });
    return () => controller.abort();
  }, [active, scope, sessionId, revision]);
  return { ...(state.scope === scope && state.active === active ? state : { scope, loading: true, error: "", options: [], current: null }),
    refresh: () => setRevision((value) => value + 1) };
}
