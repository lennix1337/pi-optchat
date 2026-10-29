/** Wraps `run` so that concurrent callers share the call in flight; the next call after it settles runs again. */
export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | null = null;
  return () => {
    running ??= run().finally(() => { running = null; });
    return running;
  };
}
