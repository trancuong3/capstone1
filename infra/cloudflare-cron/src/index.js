/**
 * Cardless Cloudflare Workers Cron Trigger for ViRead scheduled maintenance & email jobs.
 *
 * Step 1: Warms up Render Free with idempotent GET /health (30s first attempt, 45s retry)
 *         before invoking the heavy cron sweep so cold-start latency never eats into the
 *         50s backend cron budget (DEFAULT_CRON_TOTAL_BUDGET_SECONDS = 50.0).
 * Step 2: Invokes POST /internal/cron/dispatch with DISPATCH_TIMEOUT_MS = 60_000 using
 *         X-ViRead-Cron-Token, retrying at most once ONLY on 502/504 or non-AbortError
 *         network TypeError — NEVER on AbortError timeout (preventing overlapping sweeps).
 */
export const HEALTH_FIRST_TIMEOUT_MS = 30_000;
export const HEALTH_RETRY_TIMEOUT_MS = 45_000;
export const DISPATCH_TIMEOUT_MS = 60_000;
export const RETRY_BACKOFF_MS = 2_000;

const RETRYABLE_STATUSES = new Set([502, 504]);
const HEALTH_FAIL_FAST_STATUSES = new Set([401, 403, 404]);

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortFailure(error, signal) {
  return Boolean(
    (signal && signal.aborted) || (error && error.name === "AbortError"),
  );
}

async function cancelBodyQuietly(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // Ignore stream cancellation errors on discarded responses.
  }
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (
      isAbortFailure(error, controller.signal) &&
      (!error || error.name !== "AbortError")
    ) {
      const abortErr = new Error(`Request timed out after ${timeoutMs}ms`);
      abortErr.name = "AbortError";
      throw abortErr;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function warmUpBackendHealth(baseUrl, config) {
  const {
    fetchImpl,
    sleepImpl,
    backoffMs,
    healthFirstTimeoutMs,
    healthRetryTimeoutMs,
  } = config;

  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const timeoutMs =
      attempt === 0 ? healthFirstTimeoutMs : healthRetryTimeoutMs;
    let response;
    try {
      response = await fetchWithTimeout(
        fetchImpl,
        `${baseUrl}/health`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
          },
        },
        timeoutMs,
      );
    } catch (error) {
      lastError = error;
      if (attempt === 1) {
        throw error;
      }
      await sleepImpl(backoffMs);
      continue;
    }

    await cancelBodyQuietly(response);

    if (HEALTH_FAIL_FAST_STATUSES.has(response.status)) {
      throw new Error(`Health warm-up failed with HTTP ${response.status}`);
    }

    if (response.status < 500 || response.status === 503) {
      return;
    }

    if (!RETRYABLE_STATUSES.has(response.status) || attempt === 1) {
      throw new Error(`Health warm-up failed with HTTP ${response.status}`);
    }

    await sleepImpl(backoffMs);
  }

  throw lastError || new Error("Health warm-up failed");
}

export async function runCronDispatch(env, options = {}) {
  const baseUrl = String(env?.VIREAD_BACKEND_URL || "")
    .trim()
    .replace(/\/+$/, "");
  const token = String(env?.VIREAD_CRON_DISPATCH_TOKEN || "").trim();
  if (!baseUrl || !baseUrl.startsWith("https://")) {
    throw new Error(
      "VIREAD_BACKEND_URL must be configured as an https:// URL.",
    );
  }
  if (token.length < 32) {
    throw new Error(
      "VIREAD_CRON_DISPATCH_TOKEN secret (>= 32 chars) is missing.",
    );
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sleepImpl = options.sleepImpl ?? defaultSleep;
  const backoffMs = options.backoffMs ?? RETRY_BACKOFF_MS;
  const healthFirstTimeoutMs =
    options.healthFirstTimeoutMs ?? HEALTH_FIRST_TIMEOUT_MS;
  const healthRetryTimeoutMs =
    options.healthRetryTimeoutMs ?? HEALTH_RETRY_TIMEOUT_MS;
  const dispatchTimeoutMs = options.dispatchTimeoutMs ?? DISPATCH_TIMEOUT_MS;

  await warmUpBackendHealth(baseUrl, {
    fetchImpl,
    sleepImpl,
    backoffMs,
    healthFirstTimeoutMs,
    healthRetryTimeoutMs,
  });

  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response;
    try {
      response = await fetchWithTimeout(
        fetchImpl,
        `${baseUrl}/internal/cron/dispatch`,
        {
          method: "POST",
          headers: {
            "X-ViRead-Cron-Token": token,
            Accept: "application/json",
          },
        },
        dispatchTimeoutMs,
      );
    } catch (error) {
      lastError = error;
      const isRetryableNetworkTypeError =
        error instanceof TypeError && error.name !== "AbortError";
      if (!isRetryableNetworkTypeError || attempt === 1) {
        throw error;
      }
      await sleepImpl(backoffMs);
      continue;
    }

    if (response.ok) {
      return await response.json();
    }

    await cancelBodyQuietly(response);

    if (!RETRYABLE_STATUSES.has(response.status) || attempt === 1) {
      throw new Error(`Cron dispatch failed with HTTP ${response.status}`);
    }

    await sleepImpl(backoffMs);
  }

  throw lastError || new Error("Cron dispatch failed");
}

export default {
  async scheduled(_event, env, ctx) {
    const run = runCronDispatch(env);
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(run);
    }
    return run;
  },
};
