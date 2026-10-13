/** Combine cancellation sources on Node 18 as well as newer runtimes. */
export function linkAbortSignals(signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const sources = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  const abort = () => controller.abort();
  for (const source of sources) {
    if (source.aborted) abort();
    else source.addEventListener('abort', abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const source of sources) source.removeEventListener('abort', abort);
    },
  };
}
