/**
 * Cardless Cloudflare Workers Cron Trigger for ViRead scheduled email jobs.
 * Invokes POST /internal/cron/dispatch every 30 minutes using X-ViRead-Cron-Token.
 */
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

    const controller = new AbortController();
    // 90s timeout accommodates Render Free 50-60s cold starts before failing.
    const timeoutId = setTimeout(() => controller.abort(), 90_000);
    const run = (async () => {
      try {
        const response = await fetch(`${baseUrl}/internal/cron/dispatch`, {
          method: "POST",
          headers: {
            "X-ViRead-Cron-Token": token,
            "Accept": "application/json",
          },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Cron dispatch failed with HTTP ${response.status}`);
        }
        return await response.json();
      } finally {
        clearTimeout(timeoutId);
      }
    })();

    ctx.waitUntil(run);
  },
};
