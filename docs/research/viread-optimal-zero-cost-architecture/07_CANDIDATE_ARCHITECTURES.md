# 07 — Candidate Architectures & End-to-End Storyboards (Options 1–8)

**Research Date:** `2026-11-25`  
**Worktree Baseline:** `F:\c1\capstone1-rc-zero-cost` (`feat/viread-rc-zero-cost-20261125`), extending [09_ALTERNATIVE_ARCHITECTURES.md](file:///F:/c1/capstone1-staging-release/docs/research/zero-cost-production-v2/09_ALTERNATIVE_ARCHITECTURES.md) and [23_ARCHITECTURE_DECISION_RECORD.md](file:///F:/c1/capstone1-staging-release/docs/research/zero-cost-production-v2/23_ARCHITECTURE_DECISION_RECORD.md).  
**Status Markers Used:** `VERIFIED`, `DOCUMENTED BUT NOT TESTED`, `CONDITIONAL`, `UNVERIFIED`, `FAILED`.

---

## 1. Architecture Portfolio Index (Options 1–8)

| Option | Prior v2 Mapping | Core Topology Summary | Cloud Cash / mo | True Economic TCO / mo | 24/7 Laptop-Off? | Verdict (`2026-11-25`) |
|---|---|---|---|---:|:---:|---|
| **Option 1** | `v2 A / H` | Laptop-Assisted Zero-Cloud Hybrid (Vercel Hobby + Render Free + Supabase Free + Laptop Voice/OCR/CPU Ollama + CF Tunnel; **1-Hardened** adds RC egress/security/cron fixes) | `0 VND` *(up to `10_DAU Typical` w/ RC opt.)* | `~12k–335k+ VND` EVN + laptop wear (+`~25k` opt. domain) | **No** | **Best `0 VND` Defense-Day Option (`CONDITIONAL` on laptop ON)** |
| **Option 2** | `v2 B` | Dedicated Free Cloud PaaS / Docker Host (Oracle A1 `2/12`, Render, Fly, Koyeb, Northflank, Leapcell, SnapDeploy, Back4App, HF Spaces, ClawCloud [terminated]) | `0 VND` *(or `$9` HF PRO)* | `0 VND` *(if unblocked)* | **Yes** | **`FAILED` / `BLOCKED`** (512MB OOMs AI; Oracle VN CC/OOC/`aarch64`; ClawCloud dead) |
| **Option 3** | `v2 C / E` | Hybrid Split (Laptop Voice/GPU + Free Cloud CPU OCR) or Multi-Sandbox Free Distribution | `0 VND` | `~12k–207k+ VND` EVN + wear | **No** *(Voice on laptop)* | **`FAILED`** (no free `>=2 GB` x86 OCR cloud; GTX 1650 `4 GiB` OOMs Ollama) |
| **Option 4** | `v2 D` | Serverless On-Demand Containers & CI/Notebooks (Modal `$30`, CF Containers `$5+`, Colab/Kaggle, GitHub Actions) | `0 VND` *(card req on Modal/CF)* | Card overage risk | **Yes** | **`FAILED`** (Colab/GHA ToS bans; Modal cold starts break `<=2s` Voice; CF Containers `$5+`) |
| **Option 5** | **Novel Optimal (`RC+WASM`)** | **Browser WASM `sherpa-onnx` STT (`34.22 MB`) + Precomputed Catalog MP3 TTS + Cardless CF Workers Cron + Proxyless Signed URLs + JPEG `q=85`** (OCR & dynamic TTS still need worker) | `0 VND` *(clears `10_DAU Peak` inside Free Tier!)* | `~7k–180k VND` EVN *(40% lower AI duty)* + `~45 MB` browser cache | **Partial** *(Catalog reading + WASM STT 100% ON; dynamic TTS & live scan OCR wait for worker)* | **`CONDITIONAL` (`DOCUMENTED BUT NOT TESTED` for WASM STT)** — #1 Egress & Bandwidth Reducer |
| **Option 6** | **Novel (`ONNX OCR`)** | **Single-Runtime ONNX OCR Offloading** (VietOCR + Paddle DBNet exported to `onnxruntime` CPU, `torch=false`, `paddle=false`) -> target `512 MB–1 GB` vs `2–4 GB` containers | `0 VND` *(if Leapcell/2GB)* | Depends on host | Depends on host | **`FAILED` for `512 MB–1 GB`** (`1,413.50 MB` measured peak RSS); **`VERIFIED` quality & `-49.8%` latency for `>=2–4 GB` Mini-PC / VPS / Leapcell** |
| **Option 7** | `v2 I-24/7-MiniPC` | **Owned Linux Mini-PC 24/7 Docker** (`x86_64` headless Linux, hardened `ocr_worker/Dockerfile`, `voice_worker`, CPU Ollama, all 10 crons, Named Tunnel, mini-UPS) | **`0 VND`** *(non-commercial academic)* | `~22k–120k VND` EVN + mini-UPS + domain (`0` Student Pack Y1) | **Yes (`100%`)** | **Best `0 VND` Cloud 24/7 Laptop-Off Architecture** (`DOCUMENTED BUT NOT TESTED` on physical Mini-PC; WSL2 Linux verified) |
| **Option 8** | `v2 I-24/7-VPS` | **Paid Singapore VPS Baseline** (Hetzner SG `4–8 GB` `~$6.50–$15/mo` vs Vultr/DO `$20–$48/mo` + Render Starter `$7/mo` / Vercel Pro `$20/mo` / Supabase Pro `$25/mo` when commercial/scale) | `~165k–1.7M VND/mo` (`$6.50–$67/mo`) | `~165k–1.7M VND/mo` *(zero home EVN/wear)* | **Yes (`100%`)** | **Best Commercial / Zero-Ops 24/7 Production Baseline** |

---

## 2. Detailed Storyboards Across All 9 Planes & Operational Dimensions

### Option 1 — Laptop-Assisted Hybrid (`1-Baseline` = v2 A/H; `1-Hardened` = RC `feat/viread-rc-zero-cost-20261125`)
- **Component Storyboard:**
  - **Web:** Vercel Hobby (`sin1`, Next.js 16 SSR, `ssr-auth-cache`, RC explicit CSP/frame/permissions headers, `auth/callback` origin allowlist).
  - **API:** Render Free (`512 MiB` / `0.1 CPU`, `requirements-web.txt`, `277.6 MB` peak RSS, `VIREAD_OCR_MODE=remote_worker`, `429` rate limiter, `Active==1` on `/voice/*` & `/support/feedback`, `12 MB` `match-page` cap, `0` duplicate OpenAPI routes).
  - **Auth + DB + Storage:** Supabase Free (`ap-south-1`, `500 MB` DB, `1 GB` Storage, `5 GB` Uncached + `5 GB` Cached Egress). In **1-Hardened**, private images use **Proxyless Signed URLs** (`PRIVATE_SIGNED_URL_TTL_SECONDS=300`, `is_private_storage_path_owned_by`), and `document_rasterizer_service.py` defaults to **JPEG `quality=85`** (`-62.01%` to `-90.42%` bytes, Exp C verified!).
  - **OCR:** Owner Windows laptop (`Python 3.12.10`, `ocr_worker :8020`, `BelowNormal`, `CPU_THREADS=2`, outbound `/internal/ocr-jobs/claim` every `2s`, zero DB keys). **1-Hardened** fixes `<pad>`/`<sos>`/`<eos>`/`<unk>` (`14/14` rasterizer pass), adds tenant-safe SHA-256 OCR result caching, and soft-delete `409` fencing.
  - **Voice:** Owner Windows laptop (`voice_worker.py :8010`, `AboveNormal`, `sherpa-onnx` + `VieNeu-TTS-v3-Turbo` `int8` `859.99 MB` child RSS / `1,634.41 MB` commit; `fp32` `1,446.99 MB` RSS optional on `>=16 GB` host; avoid `hybrid` `1,901.30 MB` on tight RAM) exposed via Cloudflare Tunnel. **1-Hardened** adds `500 MB` LRU `tts-cache`, `audio/mpeg` (`11.8x` smaller, WER `0.0909` unchanged) & `audio/ogg` negotiation, and VAD-gated STT (`INTERIM_STEP_MS=440`, `>=80 ms` new voiced speech, `-65%` inbound WAV).
  - **Ollama:** Local Windows CPU mode (`CUDA_VISIBLE_DEVICES="-1"`, `qwen3-vl:4b`, `ctx=4096`, `4,371.4 MiB` RSS, `keep_alive="2m"`, `VIREAD_POST_OCR_CONCURRENCY=1`).
  - **Background Jobs:** **1-Baseline** leaves 5 workers inactive. **1-Hardened** decouples `parent_book_submission` Stage 2/3 sweeper + `viread_ocr_outbox` + `viread_ocr_training` in `sever.py` (0 torch/paddle imports), adds `--once` + advisory lock to `reading_reminder_worker` & `reading_presence_alert_worker`, and triggers them via **cardless Cloudflare Workers Cron** (`infra/cloudflare-cron/`, `*/5` `POST /internal/cron/dispatch` -> eliminates GitHub Actions `render-keepalive.yml`'s `4,320 min/mo` quota breach!). `karaoke_processing_worker` remains manual/offline.
  - **Colab Flow 2:** Manual notebook (`ai/vietocr_v2/colab_worker.py`) using Drive/AppsScript PKCE bridge.
  - **Android:** `vn.viread.android` (`2.1 MB` pure HTTPS WebView shell, `NO_NATIVE_LIBS`) points to Vercel URL; inherits `audio/mpeg` + VAD-STT + CSP transparently.
- **Security & Limits:** Strongest in `1-Hardened` (RLS + Zero-DB shim + `429` + CSP + `Active==1` + `12 MB` cap). Quick Tunnel (`*.trycloudflare.com`) still rotates on restart and violates Cloudflare production guidance; upgrade to Named Tunnel when domain is owned.
- **Data Stored:** Postgres & Storage in Supabase (`ap-south-1`); adult TTS MP3/WAV LRU cache (`<=500 MB`) & VietOCR weights (`144.78 MB`) on laptop; **0** child STT audio persisted on disk/DB.
- **Schedule & Laptop-Off Behavior:** Laptop-on required for live Voice (`503` in `5s` connect timeout + frontend circuit breaker after 2 errors), live `scan-page-ocr`, and draining `ocr_inference_jobs`. Catalog reading + history + auth stay live (`5/22` features) while Render/Supabase are awake (`15m` Render sleep, `7d` Supabase pause prevented by CF Cron).
- **Cost & Failover:** Cloud **`0 VND`** (up to `10_DAU Typical` & `Defense_Day Peak` in `1-Hardened`!). True Economic TCO: **`~12,000–335,000+ VND/mo`** EVN + laptop depreciation (`~180–350k VND/mo`) + optional domain (`~250–300k/yr`). Failover: OCR queues durably (`120s` lease, `fencing_token`); Voice fails closed `503` (optional paid Google Cloud fallback disabled by default).
- **External Dependencies:** Vercel, Render, Supabase, Cloudflare Tunnel/Workers, VN home FTTH ISP + EVN grid.

---

### Option 2 — Dedicated Free Cloud PaaS / Docker Host (`v2 B`)
- **Storyboard:**
  - **Web:** Vercel Hobby / Netlify Free (`300 credits/mo`).
  - **API + OCR + Voice + Ollama + Crons:** Attempted inside one free cloud Docker/PaaS host (`Oracle A1` `2 OCPU / 12 GB`, `Render Free 512 MB`, `Koyeb 512 MB`, `Northflank ~512 MB`, `SnapDeploy 512 MB / 100h`, `Back4App 256 MB`, `Railway $1 / 512 MB`, `Fly.io <$5`, `HF Spaces $0 public / $9 PRO`, `ClawCloud Run [TERMINATED 2026-06-30]`).
  - **Auth + DB + Storage:** Supabase Free (or Koyeb 5h/mo PG / Render 30d PG — both unusable).
  - **Colab / Android:** Manual Colab; Android points to Vercel.
- **Why It Fails Every Sub-Candidate:**
  - **x86_64 Free PaaS (`256–512 MB`):** Instant `OOMKill` on stock OCR (`1,659–1,840 MB` RSS), ONNX OCR (`1,413.5 MB` RSS), Voice (`860 MB` RSS / `1,634 MB` commit), and Ollama (`4,371 MiB` RSS). SnapDeploy caps at `100h/mo`. ClawCloud permanently terminated `2026-06-30`.
  - **Hugging Face `cpu-basic` (`16 GB`):** Free accounts cannot create private/custom Docker compute Spaces (`$9/mo` PRO); Public Spaces leak child audio/private book endpoints (`VN PDP Law 91/2025` violation); `48h` sleep wipes disk caches.
  - **Oracle A1 (`2 OCPU / 12 GB` `aarch64`):** `BLOCKED` by physical international CC verification (VN debit/virtual cards rejected), chronic `Out of host capacity` in `ap-singapore-1`, 7-day idle reclamation, and missing PyPI `linux_aarch64` wheels for `paddlepaddle==2.6.2` (`paddleocr==2.7.3` `opencv<=4.6.0.66` conflict).
- **Cost & Verdict:** Cloud `0 VND` on paper -> **`FAILED / BLOCKED`** in practice (`0` verified deployable free hosts for full ViRead AI).

---

### Option 3 — Hybrid Split (Laptop Voice/GPU + Free Cloud CPU OCR) & Multi-Sandbox Distribution (`v2 C / E`)
- **Storyboard:**
  - **Web + API + DB/Storage:** Vercel + Render/Northflank (`512 MB`) + Supabase Free.
  - **OCR:** Offloaded to free cloud x86_64 container (`Render / Koyeb / Northflank 512 MB`, `GCP e2-micro / AWS / Azure 1 GB`, or `Leapcell up to 4 GB` serverless).
  - **Voice + Ollama:** Kept on owner Windows laptop (`GTX 1650 Max-Q 4 GiB`).
  - **Jobs / Colab / Android:** CF Workers Cron -> Render; Manual Colab; Android WebView.
- **Audit & Failure Points:**
  - Every always-on x86_64 free cloud host (`512 MB–1 GB`) **OOMKills** both stock OCR (`1,659 MB`) and ONNX OCR (`1,413.5 MB` — `viable_1gb=false` proven in Exp A!).
  - `GTX 1650 Max-Q 4 GiB` crashes Ollama CUDA (`0xc0000409` at `10,869 MiB` commit), forcing CPU Ollama anyway.
  - Laptop must stay ON for Voice (`503` if off), so it gains **zero** laptop-off availability while adding cross-border OCR latency/egress.
- **Cost & Verdict:** Cloud `0 VND` + Laptop EVN (`~12–207k VND/mo`) -> **`FAILED`** (except Leapcell `4 GB` ONNX OCR experimental note in Option 6).

---

### Option 4 — Serverless On-Demand AI Containers & Free CI/Notebooks (`v2 D`)
- **Storyboard:**
  - **Web + API + DB/Storage:** Vercel + Render + Supabase Free.
  - **OCR / Voice:** Deployed as serverless containers on **Modal Starter** (`$0 + $30/mo` credits, **credit card required**), **Cloudflare Containers** (**`$5/mo` Workers Paid required**), **Google Colab / Kaggle**, or **GitHub Actions** (`2,000 min/mo` private).
- **Audit & Failure Points:**
  - **Colab / Kaggle / GitHub Actions:** Explicit ToS prohibitions against hosting web APIs/proxies/tunnels (ban risk) + `12h` disconnects / `2,000 min/mo` exhaustion. Valid **only** for manual Flow 2 training & CI.
  - **Modal:** Card mandatory + overage billing risk past `$30/mo`; cold image/model load (`18.1s` ONNX cold_p0 to `33.4s` stock cold_p0, plus US/EU RTT) breaks realtime `TTS <= 2s` SLA and risks `25s` FastAPI timeout.
  - **Cloudflare Containers:** No free tier (`$5/mo` base + duration billing).
- **Cost & Verdict:** Card/billing risk + `>0 VND` for CF Containers -> **`FAILED`** for `0 VND` realtime Voice/live OCR.

---

### Option 5 — Novel Optimal Zero-Card Hybrid: Browser WASM `sherpa-onnx` STT + Precomputed Catalog TTS + Cardless CF Workers Cron + Proxyless Signed URLs
- **Architectural Breakthrough:** Eliminates **`100%`** of inbound STT WAV traffic (`~9.89–49.44 GB/mo` -> `0.00 GB/mo`), eliminates **`~85%`** of live server TTS synthesis & Render outbound TTS traffic (`~78x` Render outbound reduction vs baseline WAV!), replaces GitHub Actions `render-keepalive.yml` (`4,320 min/mo`) with cardless **Cloudflare Workers Cron** (`0` GHA mins), and eliminates Render private-image proxying via **Proxyless Signed URLs** + **JPEG `q=85`**!
- **Component Storyboard:**
  - **Web:** Vercel Hobby (`sin1`), serving a dedicated Web Worker bundle (`sherpa-onnx` WASM `~10–15 MB` raw / `~4 MB` gzip + `wasm-unsafe-eval` scoped CSP opt-in) with IndexedDB/CacheStorage persistence.
  - **API:** Render Free (`512 MiB`, `requirements-web.txt`) or Northflank Sandbox (`512 MB`, no 15m sleep).
  - **Auth + DB + Storage:** Supabase Free (`ap-south-1`) using Proxyless Signed URLs (`PRIVATE_SIGNED_URL_TTL_SECONDS=300` for private pages; reusable CDN-cacheable URLs for static catalog pages & precomputed MP3 clips) + JPEG `q=85`. Optional **Backblaze B2** (`10 GB` free, cardless basic test, `$0` egress via Cloudflare Bandwidth Alliance) holds static catalog MP3s + catalog images once Supabase `1 GB` Storage or `5 GB` Cached Egress is approached (`50_DAU Typical`).
  - **OCR:** Stays async on Windows Laptop / Mini-PC / VPS (`ocr_worker` outbound polling, `1,413.5 MB` ONNX or `1,659 MB` stock). **Never** in browser WASM (1.4–1.8 GB + native `tesseract-ocr-vie` would OOMKill mobile/browser tabs).
  - **Voice (Split Client/Server):**
    - **Client STT:** `sherpa-onnx` WASM + `sherpa-onnx-zipformer-vi-30M-int8-2026-02-09` (**`34.22 MB`**, verified in [OFFLINE_POC_ARCHITECTURE.md](file:///F:/c1/capstone1-rc-zero-cost/android/OFFLINE_POC_ARCHITECTURE.md)) downloaded once on reading opt-in (`~38–48 MB` compressed transfer) -> runs local microphone ASR in browser Web Worker (`~100–200 MB` RAM) with **`0` server STT uploads**!
    - **Catalog TTS (~85% of reading volume):** Pre-synthesized offline in batch using `VieNeu` (`fp32` for crisp minimal-pair tones!) -> stored as `audio/mpeg` (`64 kbps`) / `audio/ogg` (`32 kbps`) in Supabase/B2 CDN -> served as static audio (`0` `voice_worker` CPU, `0` Render bandwidth!).
    - **Dynamic/Unseen Private-Book TTS (~15%):** Routed to `voice_worker` via Render + Named Tunnel (`audio/mpeg` `11.8x` smaller).
  - **Ollama:** CPU `qwen3-vl:4b` on worker host (`keep_alive="2m"`).
  - **Background Jobs:** Cardless **Cloudflare Workers + Cron Triggers** (`infra/cloudflare-cron/wrangler.toml`, `*/5`) invokes `POST /internal/cron/dispatch` (`X-ViRead-Cron-Token`), executing `reading_reminder_worker` & `reading_presence_alert_worker` (`--once` + advisory lock) and keeping Render warm (`0` GHA mins).
  - **Colab Flow 2:** Manual notebook (`colab_worker.py`).
  - **Android (`vn.viread.android`):** Because Android System WebView lacks `webkitSpeechRecognition` and `VieNeu` (`738 MB` / `210.7 MB` min + Python phonemizer) is infeasible on-device, Android pairs the scoped allowlisted native bridge (`Sherpa-ONNX` `34.22 MB` JNI AAR, `OFFLINE_POC_ARCHITECTURE.md`) + pre-downloaded encrypted `audio/mpeg` catalog packs for true Airplane Mode catalog reading (`Honor X9d` `7.65 GB` RAM has ample headroom once native bridge is built; currently `NO_NATIVE_LIBS`).
- **Security, Limits & Data Stored:** Child audio **never leaves the child's browser/phone** during catalog reading (maximum VN PDP Law 91/2025 privacy!). Trade-off: shifts `~38–48 MB` one-time download + `~100–200 MB` browser RAM onto user devices (must verify low-end Android WebView memory/COOP-COEP headers; `Honor X9d` 7.65 GB handles it easily).
- **Schedule & Laptop-Off Behavior:** **Catalog reading + precomputed TTS + WASM STT + reading progress stay 100% operational when the laptop is completely OFF!** Only dynamic private-book TTS (`15%`), live `scan-page-ocr`, and new OCR queue draining wait for the laptop/worker.
- **Cost & Failover:** Cloud **`0 VND`** up through **`10_DAU Peak`** (`0.60 GB` Render, `2.62 GB` Supabase Uncached, `4.35 GB` Cached, `327.8 MB` Storage) and **`50_DAU Typical`** if static catalog audio uses Backblaze B2 (`Render 1.05 GB <= 5 GB`, `Uncached 2.52 GB <= 5 GB`!). Owner EVN drops ~40% (`~7k–180k VND/mo`) when laptop runs on-demand. Failover: WASM load failure falls back cleanly to server `/voice/speech-to-text` (VAD-gated).

---

### Option 6 — Single-Runtime ONNX OCR Offloading
- **Core Idea:** Export `VietOCR` (`vgg_transformer`) + `PaddleOCR` (`PP-OCRv4` DBNet/CRNN) to pure `onnxruntime` CPU (`torch=false`, `paddle=false`) alongside `pytesseract`, aiming to fit `ocr_worker` inside `512 MB – 1 GB` free cloud containers or unlock ARM64 compatibility.
- **Measured Feasibility Verdict (Grounded in `@ai-bench-pg-sre` Experiment A, `#19`):**
  - **RAM & Commit Measured (`threads=2`, Python 3.12):** `after_init_rss = 304.32 MB` (vs `875.77 MB` stock!), `after_cold_p0_rss = 854.50 MB` (`peak=896.27 MB`), **`peak_rss = 1,413.50 MB`** (`-245.91 MB` / `-14.82%` vs `1,659.41 MB` stock), **`peak_commit = 2,033.34 MB`** (`-1,061.42 MB` / `-34.30%` vs `3,094.76 MB` stock).
  - **Speed & Quality Measured:** `import = 4,855.94 ms`, `init = 3,075.73 ms`, `cold_p0 = 18,137.12 ms`, **`warm_p50 = 13,189.54 ms` (`-49.8%` faster than stock `26,289.99 ms`!)**, `warm_p95 = 22,512.02 ms`. **Exact quality parity:** `10/10` SHA-256 identical transcripts (`CER 0.020644`, `WER 0.082418`, `IoU@0.50 geom F1 = 0.977505`).
  - **Container Viability:**
    - **`512 MB` (Render / Koyeb / Northflank / SnapDeploy):** **`FAILED`** (`viable_512mb=false`; `1,413.50 MB > 512 MB`).
    - **`1 GB` (GCP `e2-micro` / AWS `t3.micro` / Azure `B1s` / OCI `E2.1.Micro`):** **`FAILED`** (`viable_1gb=false`; `1,413.50 MB > 1,024 MB`).
    - **`2–4 GB` Host / Leapcell Hobby (`up to 4 GB` serverless) / ARM64 Oracle A1:** **`VIABLE / CONDITIONAL`**! Dropping `torch` + `paddlepaddle` eliminates the `paddlepaddle==2.6.2` missing-`aarch64`-wheel blocker (`onnxruntime==1.32.0` has official `linux_aarch64` PyPI wheels!), shrinks container image size dramatically, cuts P50 OCR latency by **49.8%**, and runs comfortably inside a `2 GB` swap-enabled or `4 GB` container!
- **Storyboard Summary:** Identical Web/API/Supabase/Voice/Cron/Colab/Android planes as Option 1-Hardened or Option 5, substituting ONNX-exported `ocr_worker` on a `2–4 GB` Linux host (or experimental Leapcell `4 GB` / ARM64 `aarch64` container once HTTP endpoint wrapper is built and tested).

---

### Option 7 — Owned Linux Mini-PC 24/7 Docker (`v2 I-24/7-MiniPC`)
- **Component Storyboard:**
  - **Web:** Vercel Hobby (`sin1`, academic) or Netlify Free.
  - **API:** Render Free (`requirements-web.txt`, kept warm by cardless CF Workers Cron `*/5`!) OR co-hosted on the Mini-PC behind Cloudflare Named Tunnel (eliminating Render `5 GB/mo` & `15m` sleep completely!).
  - **Auth + DB + Storage:** Supabase Free (`ap-south-1`, Proxyless Signed URLs, JPEG `q=85`), backed by automated nightly `pg_dump` to Mini-PC SSD (`0.67s` dump / `15.93s` restore verified on PG16!).
  - **OCR:** Dedicated headless `x86_64` Linux Mini-PC (`8–16 GB` RAM, e.g., used i5-8500T) running hardened non-root `ocr_worker/Dockerfile` (`USER appuser`, `read_only`, `cap_drop: [ALL]`, `--index-url https://download.pytorch.org/whl/cpu`, `imgaug --no-deps`, sole `opencv-python-headless==4.10.0.84`; WSL2 Linux canary verified `1,438.39 MB` maxrss!) — or Option 6 ONNX OCR (`1,413.5 MB`, `-49.8%` latency).
  - **Voice:** Co-located `voice_worker.py` (`nice -n -5`, `int8` `860 MB` RSS or `fp32` `1,447 MB` RSS on `16 GB` box, `500 MB` LRU `tts-cache`, `audio/mpeg` / `audio/ogg`) behind **Cloudflare Named Tunnel** + Access Service Token.
  - **Ollama:** CPU `qwen3-vl:4b` (`4,371 MiB` RSS, `keep_alive="2m"`, serialized) on `16 GB` Mini-PC (disabled on `8 GB` unless swap/idle-gated).
  - **Background Jobs:** Local `systemd` timers / Docker sidecar running **all 10 workers** (`reading_reminder`, `reading_presence_alert`, `karaoke_processing`, `outbox`, `auto_training`, `parent_book_submission`, `book_quality`, `admin_ai_workflow`, `ocr_worker`, `voice_worker`) + **CF Workers Cron** backup!
  - **Colab Flow 2 & Android:** Manual Colab (`>=6 GB` VRAM needed for training); `vn.viread.android` points to Vercel HTTPS origin.
- **Schedule, Laptop-Off, Cost & Failover:** **100% 24/7 Laptop-Off** (personal laptop stays completely OFF!). Cloud cash **`0 VND`**. Owner costs: **`~22,000–120,000 VND/mo` EVN electricity** (`15–40W` Mini-PC) + `0 VND` Year-1 domain via GitHub Student Pack (or `~250–300k VND/yr`) + optional `~350–500k VND` router mini-UPS (`~15–25k/mo` amortized) + `0 VND` capex if owned (`~2–4M VND` if buying used office Mini-PC). Single-ISP FTTH outage mitigated only via optional 4G failover.

---

### Option 8 — Paid Singapore VPS Baseline (`v2 I-24/7-VPS`)
- **Component Storyboard:**
  - **Web:** Vercel Hobby (`0 VND` academic) -> **Vercel Pro (`$20/user/mo` `~508k VND`)** upon any commercial/school deployment.
  - **API + OCR + Voice + All 10 Workers:** Single Singapore `x86_64` Docker Compose VPS (`Hetzner SG CX23` `4 GB` `~$6.50/mo` for OCR+Voice+Web without Ollama; or `8 GB` `~$12–$15/mo` with CPU Ollama; vs `Vultr/DigitalOcean SG` `4 GB` `$20–$24/mo` / `8 GB` `$40–$48/mo`). Runs `uvicorn`, `voice_worker`, `ocr_worker`, and all scheduled workers in one Singapore datacenter (`~30–40 ms` RTT to Vietnam & `~60 ms` to Mumbai Supabase, eliminating Render Oregon `<->` Mumbai `1.86s` cross-ocean waterfalls and eliminating Cloudflare Tunnel hop if backend sits on VPS!).
  - **Auth + DB + Storage:** Supabase Free (`$0` up to `500 MB` DB / `1 GB` Storage / `5 GB` Uncached Egress) -> **Supabase Pro (`$25/mo` `~635k VND`)** when hitting `500 MB` DB / `>5 GB` Egress / automated backups / Leaked Password Protection.
  - **Colab Flow 2 & Android:** Manual Colab (`$0` or `$9.99/mo` Colab Pro); Android APK points to Vercel origin.
- **Cost & Failover:**
  - **Minimal Academic 24/7 VPS (`Hetzner SG 4 GB + Vercel Hobby + Supabase Free`):** **`~$6.50/mo` (`~165,100 VND/mo`)** cloud, `0 VND` home EVN, `0` laptop wear, `99.9%` datacenter power/network SLA!
  - **Full Commercial Production (`Vercel Pro $20 + Hetzner SG 8 GB ~$15 + Supabase Pro $25`):** **`~$60/mo` (`~1,524,000 VND/mo`)** (or `~$72–$93/mo` on DigitalOcean/Vultr SG).
  - **External Dependencies:** Credit card required (`NOT 0 VND`), VN PDP Law 91/2025 CBIA dossier required for Singapore/Mumbai cross-border processing.
