/**
 * Cardless Cloudflare Workers Cron Trigger for ViRead scheduled maintenance & email jobs.
 * Invokes POST /internal/cron/dispatch every 30 minutes using X-ViRead-Cron-Token,
 * retrying once only on cold-start 502/504 or transient network errors (never 401/503/timeout).
 */
const RETRYABLE_STATUSES = new Set([502, 504]);
const FIRST_ATTEMPT_TIMEOUT_MS = 50_000;
const RETRY_ATTEMPT_TIMEOUT_MS = 35_000;
const RETRY_BACKOFF_MS = 2_000;

async function postCronDispatchOnce(baseUrl, token, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${baseUrl}/internal/cron/dispatch`, {
      method: "POST",
      headers: {
        "X-ViRead-Cron-Token": token,
        "Accept": "application/json",
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

export default {
  async scheduled(_event, env, ctx) {
    const baseUrl = String(env.VIREAD_BACKEND_URL || "").trim().replace(/\/+$/, "");
    const token = String(env.VIREAD_CRON_DISPATCH_TOKEN || "").trim();
    if (!baseUrl || !baseUrl.startsWith("https://")) {
      throw new Error("VIREAD_BACKEND_URL must be configured as an https:// URL.");
    }
    if (token.length < 32) {
      throw new Error("VIREAD_CRON_DISPATCH_TOKEN secret (>= 32 chars) is missing.");
    }

    const run = (async () => {
      let lastError = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const timeoutMs =
          attempt === 0 ? FIRST_ATTEMPT_TIMEOUT_MS : RETRY_ATTEMPT_TIMEOUT_MS;
        let response;
        try {
          response = await postCronDispatchOnce(baseUrl, token, timeoutMs);
        } catch (error) {
          lastError = error;
          if ((error && error.name === "AbortError") || attempt === 1) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
          continue;
        }
        if (response.ok) {
          return await response.json();
        }
        if (!RETRYABLE_STATUSES.has(response.status) || attempt === 1) {
          throw new Error(`Cron dispatch failed with HTTP ${response.status}`);
        }
        await response.body?.cancel().catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
      }
      throw lastError || new Error("Cron dispatch failed");
    })();

    ctx.waitUntil(run);
  },
};
