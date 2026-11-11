/** Bound authentication, fetch and response decoding with the same signal. */
export async function withRequestDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(new DOMException("Request timed out", "TimeoutError")),
    timeoutMs,
  );
  let interrupt: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    interrupt = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", interrupt, { once: true });
  });
  try {
    controller.signal.throwIfAborted();
    return await Promise.race([operation(controller.signal), interrupted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (interrupt) controller.signal.removeEventListener("abort", interrupt);
  }
}
