import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  getAbortReason,
  resolveTimeoutMs,
} from "@/lib/api/cold-start-retry";

/** Bound authentication, fetch and response decoding with the same signal. */
export async function withRequestDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  const effectiveTimeoutMs = resolveTimeoutMs(
    timeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const controller = new AbortController();
  const abort = () => controller.abort(getAbortReason(signal));
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(new DOMException("Request timed out", "TimeoutError")),
    effectiveTimeoutMs,
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
