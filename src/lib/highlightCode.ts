let worker: Worker | undefined;
let sequence = 0;
const pending = new Map<number, { resolve: (html: string | null) => void; reject: (error: Error) => void }>();

function reset(reason: string) {
  worker?.terminate();
  worker = undefined;
  for (const request of pending.values()) request.reject(new Error(reason));
  pending.clear();
}

export function highlightCode(source: string, language: string, signal: AbortSignal): Promise<string | null> {
  if (signal.aborted) return Promise.reject(new Error("Highlight cancelled."));
  if (!worker) {
    worker = new Worker(new URL("./highlight.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<{ id: number; html: string | null; error?: string }>) => {
      const request = pending.get(event.data.id);
      if (!request) return;
      pending.delete(event.data.id);
      if (event.data.error) request.reject(new Error(event.data.error));
      else request.resolve(event.data.html);
    };
    worker.onerror = () => reset("Syntax highlighting is unavailable; showing source.");
  }
  const id = ++sequence;
  return new Promise<string | null>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", cancel); pending.delete(id); };
    const cancel = () => { cleanup(); reject(new Error("Highlight cancelled.")); };
    const timer = setTimeout(() => reset("Syntax highlighting timed out; showing source."), 5000);
    signal.addEventListener("abort", cancel, { once: true });
    pending.set(id, {
      resolve: (html) => { cleanup(); resolve(html); },
      reject: (error) => { cleanup(); reject(error); },
    });
    try { worker!.postMessage({ id, source, language }); }
    catch (cause) { cleanup(); reject(cause instanceof Error ? cause : new Error("Could not start syntax highlighting.")); }
  });
}
