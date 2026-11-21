# ViRead Next.js production HTTPS — approval-gated hosting plan

**Status:** Code/configuration ready for PR review, **not deployed**. This document
does not authorize creating a production project, spending money, adding DNS
records, changing Supabase settings, or setting Android `VIREAD_FRONTEND_URL`.
The live Next.js origin is **not yet verified**; Issue #152 must remain BLOCKED.

## Findings grounded in the current repository and connected services

- **Frontend:** `frontend/` is Next.js **16.3.4** with App Router, server-side
  role checks, `proxy.ts`, Supabase `@supabase/ssr` cookie refresh,
  `/auth/callback` PKCE code exchange, and client API requests with Bearer
  access tokens. `frontend/app/page.tsx` redirects `/` to `/login`.
- **Supabase:** Connected project is active and has a public Supabase URL;
  its publishable key is NOT retrieved or committed. The application uses the
  public URL and publishable key on both browser/server, and verifies roles
  server-side against `profiles.role`. Do not expose any secret/service-role key.
- **FastAPI:** The connected Render workspace contains one **Free Python**
  web service, `https://capstone1-ssd8.onrender.com`, running
  `backend/app/sever.py`. It is **not** the Next.js frontend.
- **Android:** A native WebView loads a *server-backed HTTPS Next.js origin*;
  the GitHub Pages Project Hub is only a dashboard. Android's verification
  requires a real ViRead `/login` page, and its APK workflow must stay
  skipped until a real host is approved and verified.
- **CORS:** FastAPI `CORS_ALLOWED_ORIGINS` is an exact comma-separated
  allowlist; it rejects `*`. Browser API traffic goes directly to FastAPI
  with an Authorization bearer header and `credentials: "omit"`.
- **Production limitations:** Existing CI builds with dummy Supabase/API
  values to validate compilation; this does **not** establish working
  production Supabase Auth, API availability, or microphone/camera on Android.

## Free-hosting decision — as of 21 November 2026

| Provider | Full Next.js SSR? | Free-plan limitation | Decision |
|---|---|---|---|
| **Vercel Hobby** | Native Next.js SSR/proxy/route handlers | **Non-commercial personal use only**, quotas and restrictions; no promise of 24/7 production SLA | **Preferred for an academic, non-commercial ViRead demo** after account/usage approval |
| Netlify Free | Next.js SSR via serverless + edge adapter | Credit-based: 300 credits/month for new Free accounts; deploy and compute consumption can pause a site | Viable fallback after reviewing usage |
| Render Free Web Service | Native Node.js `next start` SSR | 750 Free instance hours **shared by a workspace/month**; existing backend already uses a Free service; two continuously active services may exhaust allowance | Avoid adding a second always-running instance to the same free workspace |
| Cloudflare Workers Free | Supports Next.js through Workers adapter/runtime translation | Free request/CPU/runtime limits, adapter compatibility work for Node APIs | Not the lowest-risk first path for this existing app |
| GitHub Pages / Render Static Site | Static files only | Cannot execute dynamic SSR cookie proxy and server-side authorization | **Not appropriate** |

References (official):
- Vercel Hobby personal/non-commercial restriction:
  https://vercel.com/docs/plans/hobby
- Render free instance hours: https://render.com/docs/free
- Netlify credit plan: https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/
- Cloudflare Next.js: https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/
- Next.js hosting options: https://nextjs.org/docs/app/getting-started/deploying
- Supabase SSR cookie/Proxy behavior: https://supabase.com/docs/guides/auth/server-side/creating-a-client

Vercel Hobby is allowed **only if** this project/deployment meets the provider's
non-commercial use rules; otherwise choose a suitable authorized plan/provider.
There is no guarantee of permanently free, unlimited operation.

## Prepared code (does not deploy)

- `frontend/vercel.json`: framework `nextjs`, `npm ci`, and
  `npm run build:hosting`. Do not configure `output: "export"`,
  `distDir` as `out`, or disable `proxy.ts`.
- `npm run build:hosting` first executes
  `node scripts/verify-hosting-env.mjs` to reject unsafe/missing production
  environment, then runs the regular `next build`.
- Local/build CI uses the existing `npm run build` with **isolated fixtures**
  for compilation only. No production credentials are needed in GitHub PR CI.
- The preflight does not make network calls and does not echo keys.

### Provider setup **only after explicit deployment approval**

1. Use a separate **non-commercial Vercel Hobby project**, if eligible.
   Import `https://github.com/trancuong3/capstone1`, set **Root Directory
   to `frontend`**, Framework Preset **Next.js**, Node **22.x**,
   Install `npm ci`, Build `npm run build:hosting`, and use the
   **default Next.js output directory**. Do not set a static export output.
   Avoid linking or enabling automatic production deployments before approval.
2. Configure these **three browser-public** build environment variables in
   Vercel project settings (Production and only approved Preview scopes):
   - `NEXT_PUBLIC_SUPABASE_URL`: the connected project's actual public
     Supabase URL (not an invented placeholder).
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`: the project's **publishable**
     key (or a verified legacy `anon` JWT); never a secret/service-role key.
   - `NEXT_PUBLIC_API_URL`: the verified FastAPI HTTPS origin, currently
     advertised by Render as `https://capstone1-ssd8.onrender.com`.
3. Confirm none of `PLAYWRIGHT_AUTH_FIXTURES`,
   `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SECRET_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `SMTP_APP_PASSWORD`,
   or other backend secrets are included in the **frontend** build context.
   **NEXT_PUBLIC variables are baked into client JavaScript at build time.**
4. Record the exact resulting HTTPS frontend domain and confirm the page
   displays real ViRead login—not an SPA/static placeholder.
5. In Supabase Auth URL Configuration, review the existing Site URL before
   changing anything. On an approved production cutover set the exact
   frontend origin as Site URL and allow **exact** routes needed for
   `/auth/callback`, `/reset-password`, `/login`, and `/profile`
   as applicable. Do not broaden wildcard redirects to arbitrary domains.
   Changes can affect existing web logins; plan a rollback.
6. On the Render **backend** service, review (but do not blindly overwrite)
   `CORS_ALLOWED_ORIGINS`: add the exact production frontend origin to its
   existing comma-separated list. No `*`, and do not log bearer tokens.
   A backend redeploy may be needed; get approval first.
7. Check the provider plan consumption, deploy budget, health and error
   logs without displaying cookie/JWT/session data.

Vercel setup details: https://vercel.com/docs/monorepos ,
https://vercel.com/docs/project-configuration/vercel-json ,
https://vercel.com/docs/environment-variables .
Supabase exact redirect guidance:
https://supabase.com/docs/guides/auth/redirect-urls .

## Post-deployment acceptance (do not claim these yet)

1. **Route/TLS:** from the verified origin, `GET /` is a same-origin redirect
   to `/login` (typically 307), and `GET /login` returns HTTP 200
   `text/html` with ViRead Next.js `/_next/` assets. A 200 splash page
   alone does **not** prove SSR.
2. **Auth:** use a **consenting, non-production test account** to check
   sign-in, protected `/dashboard`, role isolation, session persistence,
   logout and restoration. Check OAuth/PKCE and password recovery separately;
   an Android WebView cannot assume external browser/deep-link OAuth works.
3. **Backend:** verify FastAPI HTTPS readiness, explicit CORS preflight
   for the deployed `Origin`/Authorization header, authenticated and
   unauthenticated responses, and realistic Render cold start behavior.
4. **No leaks:** audit browser network responses, JS assets and hosting logs;
   verify no secret/service-role credential, private user data, or test
   fixture environment was deployed.
5. **Mobile:** after approval, set GitHub Actions **variable**
   `VIREAD_FRONTEND_URL` to the verified **frontend** domain, run
   `python android/scripts/verify_frontend.py` with the same URL,
   then build a debug APK using the existing conditional Android workflow.
   Confirm on emulator and physical device (login, microphone, camera,
   audio, session, CORS); do not publish to Google Play by default.
6. **Rollback:** remove the frontend deploy or revert to the previously
   approved domain; restore the exact previous Supabase Auth redirect settings
   and backend CORS list if changed. Never silently reset project secrets.

## Verification without a deployment

From repository root:

```powershell
node --test frontend/scripts/verify-hosting-env.test.mjs
cd frontend
npm ci
npm run verify
npm run build
```

The existing frontend workflow runs its standard isolated production build;
the new tests verify the stricter hosting preflight without touching live
Supabase, Render settings or launching a Vercel project.

**Issue #152 stays BLOCKED until the real domain and runtime checks are verified.**
