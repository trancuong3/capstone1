# ViRead Android — server-backed debug APK

## Decision / why no static Capacitor export

The existing frontend uses Next.js 16 App Router on a real server: middleware/proxy refreshes Supabase SSR cookies and blocks unauthenticated routes; parent/admin layouts perform server-side role verification; /auth/callback exchanges OAuth codes; browser actions call a deployed FastAPI service. A full static export would silently bypass/break this flow. Capacitor's default local asset server also changes the origin, breaking the current Supabase PKCE/cookie contract. Do not put the Next.js build into android assets.

The first Android implementation is an **isolated native WebView shell** serving the original, deployed HTTPS Next.js origin. It keeps routing and server-side checks on the server and avoids distributing database/service-role secrets. It is NOT an offline app. A static/demo APK is explicitly prohibited.

## Verified repository facts (2026-11-20)

- Next.js frontend: frontend/proxy.ts; frontend/lib/supabase/{client,server,proxy}.ts; frontend/app/(app)/layout.tsx; frontend/app/auth/callback/route.ts.
- Parent/admin role checks run on server via frontend/lib/auth/server-authorization.ts.
- Camera: frontend/components/reading/camera-preview.tsx and device-permission-service.ts.
- Recording: frontend/hooks/use-speech-recorder.ts (MediaRecorder), karaoke microphone capture; audio uses HTMLAudioElement.
- FastAPI deploy found in Render workspace: https://capstone1-ssd8.onrender.com. This is **NOT** a Next.js frontend origin.
- A fresh check on 21/11/2026 of the connected Render workspace found one Python/FastAPI service (`capstone1-ssd8.onrender.com`) and **no verified Next.js frontend service**. No other production frontend origin was established from the repository. This does not rule out an unconnected external host. The app is **not ready for an end-to-end APK** until a real frontend URL is supplied and independently verified.

## Requirements before a real APK can be built and used

1. Deploy the actual Next.js server (not static export) to a publicly reachable HTTPS origin; set NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and NEXT_PUBLIC_API_URL **during frontend deployment** to proper public HTTPS services. The backend URL above is not a substitute for NEXT_PUBLIC_FRONTEND_URL. Check API CORS and live backend reachability separately.
2. Verify the frontend origin: `GET /` normally returns HTTP **307** redirecting to **same-origin `/login`** (see `frontend/app/page.tsx`). `GET /login` must return **HTTP 200** `text/html` for the actual ViRead Next.js page containing `/_next/`. A 307 at `/` is *not* evidence of an outage. The Android preflight now validates both routes, rejects cross-origin redirects, HTTP, SSL errors, placeholder HTML and backend-only hosts. Then independently test email/password sign-in, SSR cookies, `/dashboard` authorization, API requests and book reading. Static HTML checks alone do **not** prove session/auth/media readiness. Make sure the Supabase site URL / redirect allowlist permits the HTTPS origin.
3. Set repository **Actions variable** VIREAD_FRONTEND_URL to that origin (repository Settings > Secrets and variables > Actions > Variables). This is a public URL, **never** a secret. Or run workflow_dispatch supplying frontend_url when dispatch is available. The CI uses the configured URL only for debug APK.
4. Push/PR triggers a JVM unit test + Android compilation/lint job. If no valid HTTPS Next.js deployment is configured, the **APK job is skipped**, and no misleading artifact is produced. If configured, CI requests the real HTTPS Next.js page, builds :app:assembleDebug, and uploads **viread-android-debug-apk** as an Actions artifact (14-day retention).
5. Download the artifact ZIP, unzip app-debug.apk and install locally. Android may require allowing installation from the app used to open the APK. Never upload release-signing credentials to public CI artifacts.

Local build on Windows with JDK 17, Android SDK platform 35, Gradle 8.11.1:

~~~powershell
$env:VIREAD_FRONTEND_URL = "https://YOUR-REAL-NEXTJS-FRONTEND.example"
python .\android\scripts\verify_frontend.py  # read-only HTTPS /login and root preflight
.\android\scripts\build-android.ps1
# APK: android\app\build\outputs\apk\debug\app-debug.apk
~~~

The validation job uses https://example.org only for Java compilation/lint/unit tests, **not** APK packaging. Offline Python unit tests verify the HTTPS-origin preflight and safe `/` → `/login` redirects. A successful compile is NOT evidence of a working app.

## WebView permissions and security

- Only navigation and WebRTC permissions from the configured exact HTTPS origin are trusted. Foreign HTTPS links open the system browser, not inside the authenticated WebView; http/file/intent/javascript top-level navigation is blocked.
- Camera/microphone require both Android runtime permission and a same-origin WebChromeClient permission request. Unknown resources are denied; no JavaScript bridge is exposed.
- Document/image selection uses Android ACTION_OPEN_DOCUMENT and returns content URIs to the HTML input. The current in-page scanner uses getUserMedia, not the file picker.
- JS/DOM storage/cookies are needed for Next + Supabase; mixed content and cleartext traffic are forbidden. SSL errors are canceled. Third-party cookies are disabled.
- Android onPause dispatches a background event; ViRead reading camera and speech-recorder hooks release active media. On return, camera may need reopening/restarting. No guarantee of continuous background recording.
- Browser playback (TTS, karaoke), MediaRecorder MIME support, page scanner framing, WebRTC capture, file upload, Android back handling, screen rotation, offline/errors MUST be checked on a real device.

## Known authentication limitations requiring an explicit second phase

Email/password in the embedded origin is the primary supported login candidate, **not yet confirmed on-device**. Google and some other OAuth providers block embedded webviews. The external browser has a separate cookie jar. PKCE email confirmation and password-recovery links opened in an external email/browser app likewise do not automatically return to the WebView's session/PKCE verifier. Do NOT claim those workflows work: use verified Android App Links plus assetlinks.json and a reviewed auth handoff/native PKCE implementation before enabling them as supported Android features. No custom deep-link/JS bridge is added in this first phase because it would risk account/session leaks without a deployed verified domain.

## Manual real-device acceptance matrix

- Install debug APK on Android 8+ and launch without SSL errors.
- Sign in via email/password; force close/reopen; verify parent SSR pages and logout clear session.
- Verify admin is not accepted as parent; test protected pages while logged out.
- Open book scanner and approve/deny camera; verify frames and server page match.
- Start/stop microphone recording, audio MIME, playback, Vietnamese TTS, karaoke and permission denial/retry.
- Navigate home/background during camera capture and recording: media tracks release and resume only upon user action; rotate screen.
- Choose image from Files/Photos, upload, handle canceled chooser.
- Open external HTTPS link; ensure no embedded foreign-origin permission/session.
- Test no network, expired session, backend cold starts, invalid TLS certificate.
- Treat OAuth, email recovery/confirmation handoff as UNSUPPORTED until separately verified/fixed.

## Cost and rollout

Android SDK, Gradle and GitHub Actions may be used within their free quotas; hosting a persistent Next.js server and FastAPI is an independent operational prerequisite and might carry costs or sleep/cold-start limits. No Google Play publishing, production configuration changes or release-signing keys are part of this branch. Debug builds use the SDK's standard debug signing only.

## P0 blocker tracking — Issue #152 (21/11/2026)

- **Proved in source:** `frontend/app/page.tsx` explicitly redirects `/` to `/login` using Next.js `redirect()`. The previous Android `verifyLiveFrontend` incorrectly required HTTP 200 at `/`; this fails on an otherwise valid 307 redirect. The Python/Gradle checks now accept a *strict same-origin* root-to-login redirect and require real ViRead HTML at `/login`.
- **Proved in connected Render:** `capstone1-ssd8.onrender.com` is a Python FastAPI web service, **not** a Next.js frontend. Project Hub at `trancuong3.github.io/capstone1/` is a static status dashboard, **not** a Next.js SSR host.
- **Unverified:** any other public Next.js frontend deployment, working auth/session, real device, or Android APK packaging. The `VIREAD_FRONTEND_URL` repository Actions variable must contain an independently verified origin; do not guess, use localhost, set the backend URL, or treat compilation with `example.org` as a live test.
- **Production readiness:** obtain a real, approved Next.js server deployment and confirm required browser-safe environment values, Supabase redirect settings and backend CORS separately before configuring the Android CI variable and running debug APK packaging. No production configuration is changed by this PR.
