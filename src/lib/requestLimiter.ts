interface PendingRead<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  cancel: () => void;
}

export function createRequestLimiter<T>(concurrency = 3) {
  let running = 0;
  const pending: PendingRead<T>[] = [];
  const pump = () => {
    while (running < concurrency && pending.length) {
      const next = pending.shift()!;
      next.signal.removeEventListener("abort", next.cancel);
      if (next.signal.aborted) { next.reject(next.signal.reason); continue; }
      running++;
      Promise.resolve().then(next.run).then(next.resolve, next.reject).finally(() => { running--; pump(); });
    }
  };
  return (run: () => Promise<T>, signal: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const item: PendingRead<T> = { run, resolve, reject, signal, cancel: () => {
      const index = pending.indexOf(item);
      if (index >= 0) pending.splice(index, 1);
      reject(signal.reason);
    } };
    signal.addEventListener("abort", item.cancel, { once: true });
    pending.push(item);
    pump();
  });
}
