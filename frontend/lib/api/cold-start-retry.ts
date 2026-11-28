export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_UPLOAD_TIMEOUT_MS = 90_000;

export const COLD_START_RETRY_STATUSES: ReadonlySet<number> = new Set([
  502, 504, 520, 521, 522, 523, 524, 525, 526, 527, 528, 529, 530,
]);

export const COLD_START_RETRY_DELAY_MS = 600;

export function isColdStartRetryableStatus(status: number): boolean {
  return COLD_START_RETRY_STATUSES.has(status);
}

export function resolveTimeoutMs(
  timeoutMs: number | undefined,
  fallbackMs: number,
): number {
  return typeof timeoutMs === "number" &&
    Number.isFinite(timeoutMs) &&
    timeoutMs > 0
    ? timeoutMs
    : fallbackMs;
}

export function getAbortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("Aborted", "AbortError");
}

export function isAbortOrTimeoutError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

export async function cancelResponseBodyQuietly(
  response: Response,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return;
  }
  try {
    const cancelPromise = response.body?.cancel?.();
    if (!cancelPromise) {
      return;
    }
    await (signal ? raceWithSignal(cancelPromise, signal) : cancelPromise);
  } catch {
    // Ignore stream cancellation errors when discarding a retryable response.
  }
}

export function delayWithSignal(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason ?? new DOMException("Aborted", "AbortError"),
    );
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface LinkedAttemptHandle {
  readonly signal: AbortSignal;
  readonly didTimeout: () => boolean;
  readonly cleanup: () => void;
}

export function createLinkedAttemptController(
  timeoutMs: number,
  parentSignal?: AbortSignal,
): LinkedAttemptHandle {
  const controller = new AbortController();
  let timedOut = false;

  const onParentAbort = () => {
    controller.abort(
      parentSignal?.reason ?? new DOMException("Aborted", "AbortError"),
    );
  };

  if (parentSignal?.aborted) {
    onParentAbort();
  } else if (parentSignal) {
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }

  const effectiveTimeoutMs = resolveTimeoutMs(
    timeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const timeoutId = setTimeout(
    () => {
      timedOut = true;
      controller.abort(new DOMException("Request timed out", "TimeoutError"));
    },
    Math.max(1, effectiveTimeoutMs),
  );

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timeoutId);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}

export function raceWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(
      signal.reason ?? new DOMException("Aborted", "AbortError"),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function extractResponseErrorDetail(
  response: Response,
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted) {
    throw getAbortReason(signal);
  }
  try {
    const jsonPromise = response.clone().json();
    const payload: unknown = signal
      ? await raceWithSignal(jsonPromise, signal)
      : await jsonPromise;
    if (typeof payload === "object" && payload !== null) {
      if ("detail" in payload) {
        if (typeof payload.detail === "string") {
          return payload.detail;
        }
        if (
          typeof payload.detail === "object" &&
          payload.detail !== null &&
          "code" in payload.detail &&
          typeof payload.detail.code === "string"
        ) {
          return payload.detail.code;
        }
      }
      if ("code" in payload && typeof payload.code === "string") {
        return payload.code;
      }
    }
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    // Non-JSON error bodies (e.g. Cloudflare 520-530 HTML or proxy 502/504)
  }
  return null;
}

export async function shouldRetryColdStartResponse(
  response: Response,
  isKnownDomainDetail?: (detail: string) => boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!COLD_START_RETRY_STATUSES.has(response.status)) {
    return false;
  }
  const detail = await extractResponseErrorDetail(response, signal);
  if (detail === null) {
    return true;
  }
  return isKnownDomainDetail ? !isKnownDomainDetail(detail) : true;
}
