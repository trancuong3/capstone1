# ViRead Cardless Cloudflare Workers Cron Dispatcher

Free-tier Cloudflare Workers Cron Triggers require no credit card and execute up to 5 cron triggers per worker (100,000 requests/day free).

## Setup

1. Configure `VIREAD_CRON_DISPATCH_TOKEN` (>= 32 random chars) on your ViRead backend.
2. Deploy from this folder:
   ```bash
   wrangler secret put VIREAD_CRON_DISPATCH_TOKEN
   wrangler deploy --var VIREAD_BACKEND_URL:https://your-backend-domain.example
   ```
3. The worker triggers `POST /internal/cron/dispatch` every 5 minutes (`*/5 * * * *`), protected by `X-ViRead-Cron-Token` and PostgreSQL advisory locks on the backend.
