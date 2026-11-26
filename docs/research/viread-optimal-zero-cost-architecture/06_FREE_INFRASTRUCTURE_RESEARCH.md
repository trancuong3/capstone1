# 06 — 2026 Zero-Cost, Cardless & Low-Resource Infrastructure Research

**Research Date:** `2026-11-25`  
**Worktree Scope:** `F:\c1\capstone1-rc-zero-cost` (extending and updating prior v2 research in [06_WINDOWS_CLOUDFLARE_RESEARCH.md](file:///F:/c1/capstone1-staging-release/docs/research/zero-cost-production-v2/06_WINDOWS_CLOUDFLARE_RESEARCH.md), [07_FREE_CLOUD_RESEARCH.md](file:///F:/c1/capstone1-staging-release/docs/research/zero-cost-production-v2/07_FREE_CLOUD_RESEARCH.md), and [08_FREE_HOSTING_COMPARISON.csv](file:///F:/c1/capstone1-staging-release/docs/research/zero-cost-production-v2/08_FREE_HOSTING_COMPARISON.csv) without duplicating unchanged sections).  
**Status Markers Used:** `VERIFIED`, `DOCUMENTED BUT NOT TESTED`, `CONDITIONAL`, `UNVERIFIED`, `FAILED`, `TERMINATED`.

---

## 1. Executive Summary of 2026 Zero-Cost & Cardless Findings

1. **No Unblocked, Cardless, Always-On 24/7 Free Cloud Host Can Run ViRead's Stock AI Stack Today:**
   - Stock 3-engine OCR (`ocr_worker`, `t=2`) peaks at **`1,839.82 MB` RSS (`2,464.57 MB` commit)** and Voice Worker (`voice_worker`, `sherpa-onnx` + `vieneu`) runs at **`841.7–851.93 MB` warm RSS (`2,040.88 MB` cumulative peak RSS, `3,934.97 MB` commit)** per [05_RESOURCE_REQUIREMENTS.md](file:///F:/c1/capstone1-staging-release/docs/research/zero-cost-production-v2/05_RESOURCE_REQUIREMENTS.md).
   - **ClawCloud Run** (formerly cited in older 2024–2025 free-container lists) wound down its container free tier in **May 2026** and **permanently terminated all ClawCloud hosting on `2026-06-30`**.
   - **Render Free (`512 MiB` / `0.1 CPU`)**, **Koyeb (`512 MB`)**, **SnapDeploy (`512 MB` / `100 container-h/mo`)**, **Back4App (`256 MB`)**, **Railway (`512 MB` / `$1/mo`)**, and **Northflank Sandbox (`~512 MB`)** all OOMKill stock `ocr_worker` and `voice_worker`.
   - **Leapcell Hobby** (`$0/mo`, cardless, up to `3 vCPU / 4 GB RAM` serverless) is the **only** new cardless platform whose per-invocation memory limit exceeds `1 GB`, **but** it operates on a read-only rootfs (`/tmp` only), scale-to-zero request model (`<=15m` per request) with shared monthly free quota rather than an always-on daemon VPS (`CONDITIONAL` for short-lived stateless APIs / experimental single-runtime ONNX OCR, `FAILED` for persistent Voice/Cron daemons).
   - **Oracle Cloud Always Free (`VM.Standard.A1.Flex`)** remains downgraded to **`2 OCPUs / 12 GB RAM`** (`1,500 OCPU-h + 9,000 GB-h/mo`, down from legacy `4/24`), requires a physical international credit card (frequently rejecting VN debit/virtual cards), suffers chronic `Out of host capacity` in `ap-singapore-1`, reclaims idle instances after 7 days, and lacks standard PyPI `linux_aarch64` wheels for `paddlepaddle==2.6.2`.
2. **Cardless Cloudflare Workers + Cron Triggers vs. Card-Gated Cloudflare R2 & Containers:**
   - **Cloudflare Workers + Cron Triggers** (`$0/mo`, **cardless**, `100,000 req/day`, `10 ms` CPU, `5` Cron Triggers/account at `>=1 min` cadence) provide a free, zero-card replacement for GitHub Actions `render-keepalive.yml` (which burns `~4,320 min/mo` > GitHub's `2,000 min/mo` private repo quota when scheduled every 10 minutes!) and for triggering lightweight `/internal/cron/*` jobs.
   - **Cloudflare R2** (`10 GB-mo`, `0` egress) **requires a credit card on file** (`Error 10042` without payment method) because R2 allows billable overages. **Cloudflare Containers** have **no free tier** (`$5/mo` Workers Paid plan mandatory).
   - **Backblaze B2** offers `10 GB` always-free storage + `3x` free egress (unlimited free egress via Cloudflare Bandwidth Alliance) without requiring a credit card for basic 10 GB testing, though pay-as-you-go rates rose from `$6` to **`$6.95/TB/mo`** effective `2026-05-01`.
3. **Academic & OSS Grants Unlock Missing Pieces Legally at `0 VND` (If Eligible):**
   - **GitHub Student Developer Pack** includes a **free 1-year custom domain** (`.me` / `.tech`), eliminating the Year-1 `~250k–300k VND` domain cost for a **Cloudflare Named Tunnel**.
   - **Azure for Students** grants **`$100` for 12 months with NO credit card**, providing a temporary 1-year `x86_64` VM runway for verified university students (not perpetual post-graduation).

---

## 2. Delta Audit of Prior v2 Platforms (`2026-11-25` Re-Verification)

Unchanged baseline details in [07_FREE_CLOUD_RESEARCH.md](file:///F:/c1/capstone1-staging-release/docs/research/zero-cost-production-v2/07_FREE_CLOUD_RESEARCH.md) and [06_WINDOWS_CLOUDFLARE_RESEARCH.md](file:///F:/c1/capstone1-staging-release/docs/research/zero-cost-production-v2/06_WINDOWS_CLOUDFLARE_RESEARCH.md) remain valid; below are the re-verified 2026 limits and operational deltas relevant to ViRead RC:

| Platform | 2026 Verified Limits & Billing Model | Card Required? | Auto-Bill Risk | Key Operational Impact on ViRead RC | Status |
|---|---|---|---|---|---|
| **Oracle Cloud (`Ampere A1` + `E2.1.Micro`)** | `A1.Flex`: `1,500 OCPU-h + 9,000 GB-h/mo` = **`2 OCPUs / 12 GB`** (enforced on legacy `4/24` accounts); `2× E2.1.Micro` (`1 GB` AMD); `200 GB` disk; `10 TB/mo` egress; 7-day idle reclamation (`<10–20%`) | **Yes** (Physical CC; VN cards often rejected) | Low unless PAYG upgraded | Chronic `ap-singapore-1` OOC; `paddlepaddle==2.6.2` has **no** PyPI `linux_aarch64` wheel; `paddleocr==2.7.3` pins `opencv<=4.6.0.66` (no `cp312` wheels) | `CONDITIONAL` (blocked/unverified) |
| **Render Free** | Web: **`512 MiB` RAM**, **`0.1 CPU`**, `750h/mo` workspace pool, **`5 GB/mo` Hobby bandwidth** (`$0.15/GB` if card added), `15m` sleep (`50–60s` cold start); Free PG (`256 MB / 1 GB`) **deleted after 30 days** | **No** | None without card (suspends at `5 GB`) | **`VERIFIED`** for Light Web API (`277.6 MB` RSS); `5 GB/mo` bandwidth exhausts on Day 19 at `10_DAU Typical` unless Option G/5 egress fixes apply | `VERIFIED` (Light Web only) |
| **Vercel Hobby** | `$0/mo`, `100 GB/mo` Fast Data Transfer, `1M` invocations, `4` active CPU-h/mo, `360 GB-h`, `300s` max duration; **strictly non-commercial personal use only** | **No** | None (pauses on cap) | **`VERIFIED`** for academic/non-commercial Next.js 16 SSR (`sin1`); commercial launch requires Pro (`$20/user/mo`) | `VERIFIED` (Academic only) |
| **Netlify Free** | **`300 credits/mo`**; builds, SSR compute, and bandwidth consume credits; site pauses at `0` credits | **No** | None | Viable Next.js SSR fallback if Vercel Hobby quota pauses; `@supabase/ssr` `proxy.ts` parity untested | `DOCUMENTED BUT NOT TESTED` |
| **Supabase Free** | `$0/mo`, `2` active projects, `500 MB` DB, `1 GB` Storage, **`5 GB` Uncached + `5 GB` Cached Egress/mo**, `50k` MAU, **auto-pauses after `7 days` inactivity**, `0` backups, no Leaked Password Protection | **No** | None (hard caps) | Verified for DB/Auth/Storage; proxyless signed URLs + JPEG q=85 prevent premature `5 GB` Uncached Egress & `1 GB` Storage exhaustion | `VERIFIED` |
| **Koyeb Free** | `1` Free Web Service (`0.1 vCPU`, `512 MB` RAM, `2 GB` SSD, FRA/WAS), `1h` idle sleep; Free PG capped at **`5 active hours/mo`**; no custom domain | **Often Yes** (`$29` pre-auth anti-abuse) | Low on Free | Light Web fallback only (`512 MB` OOMs AI; high VN latency vs `sin1`/Oregon) | `CONDITIONAL` (Light Web) |
| **Northflank Sandbox** | `$0/mo`, `2` services, `1` DB, `2` crons, `~0.2 vCPU / ~512 MB`, **always-on (does NOT sleep)** | **No** | None | Strongest cardless **no-sleep** backup for Light Web API (`277.6 MB` RSS); `512 MB` cannot host OCR/Voice | `CONDITIONAL` (Light Web) |
| **Fly.io** | Always-free VMs **discontinued**; `$1` 7-day no-card trial; bills `<$5/mo` waived *only* if card on file (`>$5` bills full total) | **Yes** (after 7d) | **HIGH** (`>$5` cliff) | `256–512 MB` VMs fail AI; billing cliff violates zero-bill-risk mandate | `CONDITIONAL` / `FAILED` |
| **Railway** | 30-day `$5` trial (no card) -> **Free Plan (`$1/mo` credit)**, `<= 1 vCPU / 512 MB` per service, sleeps `5–10m` idle, no custom domain | **No** | None (stops at `$1`) | `$1/mo` depletes rapidly on steady backend; `512 MB` fails AI | `FAILED` |
| **Hugging Face Spaces** | `cpu-basic` (`2 vCPU / 16 GB / 50 GB` ephemeral, `48h` sleep) is `$0/hr` hardware, **but** custom Docker & Private Spaces require **`$9/mo` PRO**; Public Spaces expose code/logs | **Yes** (for PRO `$9/mo`) | Recurring `$9/mo` | Public Spaces violate VN PDP Law 91/2025 child privacy; zero-cost private Docker not permitted | `FAILED` |
| **GitHub Actions** | Public repos unlimited; Private repos **`2,000` Linux min/mo** (`500 MB` artifacts, `6h`/job, minimum 1-min billing granularity per run) | **No** | None (blocks at limit) | **Trap Found:** Current [.github/workflows/render-keepalive.yml](file:///F:/c1/capstone1-rc-zero-cost/.github/workflows/render-keepalive.yml) (`*/10` cron) runs `4,320x/mo` = **`4,320 min/mo` > `2,000 min/mo` private quota**! Move keepalive/crons to CF Workers Cron | `VERIFIED` (CI/APK only) |
| **Colab / Kaggle** | Colab Free: dynamic T4 (`<=12h`, idle disconnect); Kaggle: `30h/wk` T4/P100 (`<=12h`, phone verification). **Both ToS-prohibit web hosting/tunnels/proxies** | **No** | None | Strictly manual Flow 2 VietOCR training (`ai/vietocr_v2/colab_worker.py`); banned for live OCR/Voice | `CONDITIONAL` (Training only) |
| **GCP / AWS / Azure / IBM** | **GCP:** `e2-micro` (`1 GB` RAM, US-only, `1 GB/mo` egress). **AWS (2026 update):** `$100` sign-up + up to `$100` activity credits on **6-month Free Plan** (auto-closes on expiry; legacy 12-mo `1 GB` EC2). **Azure:** `$200` 30d + 12-mo `1 GB` VM. **IBM:** Code Engine (`100k` vCPU-s/mo `~27.7h`) mandates PAYG CC + auto-bills | **Yes** | **HIGH** (GCP/IBM/post-trial) | `1 GB` RAM fails AI; `1 GB/mo` GCP egress & 6–12 mo expiry disqualify perpetual `0 VND` hosting | `FAILED` |

---

## 3. New & Expanded 2026 Platform Audits

### 3.1 ClawCloud Run — `TERMINATED (2026-06-30)`
- **Verification (`2026-11-25`):** ClawCloud wound down its free **ClawCloud Run** container service starting in **April–May 2026** (free tier ended `2026-05-11` due to resource abuse) and formally terminated **all** ClawCloud VPS/VDS and hosting infrastructure effective **`2026-06-30 24:00`** (stopping all new registrations/renewals on `2026-06-01` and permanently deleting remaining instances on `2026-06-30`).
- **Verdict:** **`TERMINATED / FAILED`** — must never be listed as a viable 2026 hosting option.

### 3.2 Leapcell (Hobby Free Tier)
- **Pricing & Card Policy:** **`$0/mo`**, **no credit card required** to start on the Hobby plan.
- **Specs & Quotas (`leapcell.io`):**
  - Up to **`20` projects** simultaneously, scalable per project up to **`3 vCPUs / 4 GB RAM`** (drawn from a shared free monthly serverless compute pool), `10 GB` max container image size, `100 MB` max HTTP payload, **`15-minute` max single-request timeout**, `100` concurrent executions, `1` Free shared PostgreSQL DB, custom domains + SSL supported.
  - **Build & Filesystem Reality:** Uses native GitOps sandbox builds (`apt-get` supported in Build Command for OS libraries/binaries such as `tesseract-ocr` + `tesseract-ocr-vie`), `<250 ms` serverless cold start, **read-only rootfs except `/tmp`** (ephemeral between cold starts).
- **ViRead Compatibility Assessment:**
  - **Light Web API:** Fits cleanly (`277.6 MB` RSS, `100 MB` payload, Asia region available), though shared free monthly compute/egress pool (`~2–10 GB/mo` base egress depending on tier, `$0.30/GB` if upgraded) and serverless idle freeze mean it cannot run continuous background `asyncio` loops (`ocr_worker` 2s poll loop or `voice_worker` resident model).
  - **Voice Worker (`voice_worker`):** **`FAILED`** — serverless HTTP scale-to-zero cannot sustain persistent `848 MB` `VieNeu` + `Sherpa` HF cache without re-downloading models into ephemeral `/tmp` on cold starts and exhausting free GB-hours/egress (`48 kHz` WAV).
  - **ONNX OCR (Option 6 Experimental):** **`CONDITIONAL` (`DOCUMENTED BUT NOT TESTED`)** — `4 GB` RAM peak ceiling + `15-min` request timeout + `apt-get` support *could* theoretically host an on-demand HTTP ONNX OCR function if weights fit inside the `10 GB` image (baked at build time, not downloaded to `/tmp`), **pending** `@ai-bench-pg-sre`'s Experiment A RSS/latency proof and Leapcell's undocumented shared free compute exhaustion threshold.

### 3.3 SnapDeploy (Free Tier)
- **Pricing & Card Policy:** **`$0/mo`**, **no credit card required**.
- **Specs & Quotas:** Up to **`4` containers**, **`512 MB` RAM per container**, **`100 container-hours/month`** workspace limit, `10` deploys/day, **`15-minute` inactivity sleep** (`~60s` wake), HTTPS subdomain (`always-on` starts at `$12/mo/container`, managed Postgres starts at `$29/mo`).
- **ViRead Compatibility Assessment:** **`FAILED`** — `512 MB` OOMKills OCR/Voice immediately, and `100 container-hours/month` covers only **`~13.9%`** of a `720h` month (unusable even for 24/7 Light Web API).

### 3.4 Back4App Containers (Free Tier)
- **Pricing & Card Policy:** **`$0/mo`**, **no credit card required**.
- **Specs & Quotas:** **`256 MB` RAM**, **`0.25 vCPU`** shared, `100 GB` transfer. Paid tiers start at `$5/mo` (`512 MB`) and jump to `$25–$50/mo` (`2 GB`) / `$100/mo` (`4 GB`).
- **ViRead Compatibility Assessment:** **`FAILED`** — `256 MB` RAM is below ViRead's measured **`277.6 MB`** peak RSS for the lightweight web API alone (`OOMKill` risk even without AI).

### 3.5 Cloudflare Workers + Cron Triggers vs. Cloudflare R2 vs. Cloudflare Containers
| Cloudflare Product | Free Tier? | Card Required? | Exact Verified Limits (`2026-11-25`) | Role in ViRead RC |
|---|---|---|---|---|
| **Workers + Cron Triggers** | **Yes** (`$0/mo`) | **No** (hard stop at quota -> `Error 1027`, zero billing) | `100,000 req/day`, **`10 ms` CPU time/invocation**, **`128 MB` RAM/isolate**, `50` subrequests, **`5` Cron Triggers/account** (`>=1 min` frequency) | **KEY OPTION 5 ENABLER:** Cardless `*/10` Render keepalive (saving `4,320 min/mo` GHA quota!) + scheduled trigger calling authenticated Render `/internal/cron/*` endpoints (`reading_reminder`, `reading_presence_alert`, cache prune). Cannot run Python ML or raw TCP `asyncpg` (`10 ms` / Pyodide). |
| **Cloudflare R2** | Free tier (`$0` inside allowance) | **YES — Credit Card REQUIRED** (`Error 10042` without payment method) | `10 GB-month` storage, `1M` Class A ops/mo, `10M` Class B ops/mo, **`$0` egress**; soft-stop bills overages past free tier | **Disqualified for strictly cardless deployments.** Viable **only** if owner accepts putting a card on file (with billing alerts) to offload >`1 GB` catalog PNG/JPEG & precomputed MP3/Opus audio from Supabase Storage. |
| **Cloudflare Containers** | **NO Free Tier** | **YES** (Workers Paid **`$5/mo` base** required) | Base `$5/mo` includes `375 vCPU-min` (`22,500s`), `25 GiB-h` RAM, `200 GB-h` disk, `500 GB–1 TB` egress; instances `lite` (`256 MiB`) to `standard-4` (`4 vCPU / 12 GiB / 20 GB`); allocated RAM/disk bill while awake | **Disqualified for `0 VND` tier** (`>=$5/mo` fixed base + overage metering; e.g. 24/7 `standard-1` `4 GiB` awake costs `~$26/mo+` in memory duration alone unless scaled-to-zero aggressively). |

### 3.6 Modal (Starter Free Plan)
- **Pricing & Card Policy:** `$0/mo` base + **`$30/month` free compute credits** (resets monthly, non-rollover), `1 TiB/mo` egress, `100` concurrent containers, `10` GPU concurrency. **HOWEVER, a valid credit card on file is REQUIRED** even for the Starter plan, and usage past `$30` bills automatically unless a hard workspace budget cap is enforced.
- **Resource & Latency Math:** Per-second billing (`~$0.0000131/core-sec` CPU, `~$0.00000222/GiB-sec` RAM, `1.15x+` region multiplier, `~3x` sandbox multiplier). `$30/mo` covers `~635` core-hours of 1-core CPU (`~18` days if always-on 1C/4GB -> runs out before month-end if never scaled to zero!). Cold starts (`~16.3s` ML import + model init) break interactive `<=2s` TTS SLA; US/EU edge latency adds cross-border RTT from Vietnam.
- **Verdict:** **`CONDITIONAL` (burst async OCR only if card + budget cap accepted)** / **`FAILED` for strictly cardless `0 VND` or realtime Voice SLA**.

### 3.7 Backblaze B2 (Object Storage)
- **Pricing & Card Policy (`2026-05-01` update):** First **`10 GB` storage ALWAYS FREE**; pay-as-you-go above `10 GB` updated from `$6.00` to **`$6.95/TB/month`** (`$0.00695/GB/mo`). Free egress up to **`3x` average monthly stored volume** (`30 GB/mo` at `10 GB` stored), **`$0.01/GB`** thereafter, OR **unlimited `$0` egress via Cloudflare / Fastly / Bunny Bandwidth Alliance**. Standard Class A/B/C API calls are free. Basic signup does **not** require a credit card to test the `10 GB` free tier (though certain public/scale features or post-10 GB usage require billing setup).
- **ViRead Role Suitability:** Strongest **near-cardless `10 GB` static/audio offload target** if Supabase's `1 GB` Storage cap fills up with precomputed Catalog TTS audio (`Opus`/`MP3`) or catalog images — especially when paired with a Cloudflare custom domain (Bandwidth Alliance = `0 VND` egress). Private parent books should remain on Supabase Storage (`ap-south-1`, single-vendor RLS/signed URLs) unless multi-GB scale demands migration.

### 3.8 Academic & Open-Source Grants (`2026-11-25`)
| Program | Grant Value & Card Requirement | Eligibility & Terms | ViRead Applicability |
|---|---|---|---|
| **GitHub Student Developer Pack** | GitHub Pro + Copilot Student + **1-year free domain** (`.me` via Namecheap, Name.com, `.TECH`) — **No card** (student ID / `.edu` verification) | Enrolled student `>=13` yrs | **Solves Year-1 Custom Domain (`~250–300k VND`)** for Cloudflare Named Tunnel (`voice.domain.tld`) at `0 VND`! Renews/expires after Year 1. |
| **Azure for Students** | **`$100` Azure credit for 12 months** + 25 free services — **No credit card required** | Verified student `>=18` yrs | Can fund a `~12 months` Singapore (`Southeast Asia`) `B2s`/`B2ms` (`4–8 GB` RAM) VM (~`$8–$30/mo` consuming `$100` credit over `3–12` mo) for capstone/pilot — **expires after credit/12 mo** (`NOT` perpetual). |
| **Vercel Open Source Program** | Up to **`$3,600` platform credits** (1–3 yr cohorts) | Active public OSI-licensed OSS with measurable ecosystem impact & CoC | Eligible **only** if ViRead is released as an active public OSS project and passes quarterly cohort selection; otherwise academic non-commercial stays on Vercel Hobby (`$0`). |
| **Cloudflare Project Alexandria** | Free Pro/Business plans, higher Workers/R2 limits | Non-profit OSI-licensed OSS; **payment method on file required** for account verification | Useful only if open-sourced non-profit + card on file. |
| **Supabase OSS / Hackathons** | No standing OSS credit grant; Launch Week OSS hackathon prizes or Stripe Atlas (`$500` startup credit) | Public OSS hackathon submissions or incorporated startups | Stick to Supabase Free (`$0`) + Option 5 egress optimizations. |

---

## 4. Complete 2026 Platform Comparison Matrix

| Platform | Monthly Cash | Card Req? | Auto-Bill Risk? | Compute / RAM | Storage / Egress | Sleep / Runtime Limit | ViRead Role Verdict |
|---|---:|:---:|---|---|---|---|---|
| **Windows Laptop (Local AI)** | `$0` cloud *(EVN `12k–335k VND/mo`)* | No | None | `6C/12T`, `15.83 GiB`, `GTX 1650` (CPU pin) | `49.5 GB` F:, FTTH CGNAT | Lid/Sleep/Windows Update risks | **Verified** OCR + Voice + Ollama host (when ON) |
| **Linux Mini-PC (Owned 24/7)** | `$0` cloud *(EVN `22k–120k VND/mo`)* | No | None | `4–8C x86_64`, `8–16 GB` | `128–512 GB` SSD, FTTH CGNAT | Always-on (`systemd` + mini-UPS) | **Target `0 VND` cloud 24/7 AI + Cron host** |
| **Vercel Hobby** | `$0` | No | None | Serverless Edge/Node (`4 CPU-h/mo`) | `100 GB/mo` transfer | `300s` max req; **Non-commercial ToS** | **Verified** Next.js 16 SSR (`sin1`) |
| **Netlify Free** | `$0` | No | None | Serverless (`300 credits/mo`) | Credit-metered | Pauses at `0` credits | Fallback SSR (`DOCUMENTED BUT NOT TESTED`) |
| **Render Free** | `$0` | No | None (unless card added) | `0.1 CPU`, `512 MiB` Web | **`5 GB/mo` BW**; PG 30d expiry | `15m` sleep (`50–60s` cold) | **Verified** Light Web API (`277.6 MB` RSS); fails AI/DB |
| **Supabase Free** | `$0` | No | None | Shared Postgres | `500 MB` DB, `1 GB` Storage, `5 GB` Uncached + `5 GB` Cached | `7d` inactivity pause; `0` backups | **Verified** DB + Auth + Storage (`ap-south-1`) |
| **Northflank Sandbox** | `$0` | No | None | `~0.2 vCPU / ~512 MB` (`2` svcs, `1` DB, `2` crons) | Small sandbox quota | **Always-on (no sleep)** | Strongest cardless no-sleep Light Web backup |
| **Leapcell Hobby** | `$0` | **No** | None | Up to `3 vCPU / 4 GB` serverless | `10 GB` img, `~2–10 GB` BW, Free PG | Scale-to-zero (`<250ms`), `15m` req, `/tmp` only | `CONDITIONAL` (Light Web / short ONNX OCR PoC); `FAILED` Voice daemon |
| **SnapDeploy Free** | `$0` | No | None | `512 MB` (`4` containers) | Ephemeral | **`100 container-h/mo`**, `15m` sleep | `FAILED` (`100h < 720h`, OOM AI) |
| **Back4App Containers** | `$0` | No | None | `0.25 vCPU`, **`256 MB`** | `100 GB` transfer | Shared free sandbox | `FAILED` (`256 MB < 277.6 MB` Web RSS) |
| **ClawCloud Run / VPS** | N/A | N/A | N/A | **Terminated `2026-06-30`** | Deleted | Shut down | **`TERMINATED / FAILED`** |
| **Koyeb Free** | `$0` | Often Yes | Low | `0.1 vCPU`, `512 MB` (`5h/mo` PG) | `2 GB` SSD | `1h` sleep (FRA/WAS) | `CONDITIONAL` Light Web only |
| **Railway** | `$0` (`$1` credit) | No | None | `<=1 vCPU / 512 MB` | Ephemeral | Sleeps `5–10m`; `$1/mo` cap | `FAILED` |
| **Fly.io** | `<$5` waived | Yes (>7d) | **HIGH** (`>$5` bills full) | `256–512 MB` shared | Billed in `$5` cap | Auto-stop/start (`sin`) | `CONDITIONAL` Light Web / `FAILED` AI |
| **HF Spaces (`cpu-basic`)** | `$0` static / `$9` PRO | Yes (PRO) | `$9/mo` | `2 vCPU / 16 GB` | `50 GB` ephemeral | Free blocked from private/Docker; `48h` sleep | `FAILED` (Privacy / `$9` PRO) |
| **Oracle A1 Free (`ARM64`)** | `$0` | **Yes** (VN rejected) | Low (if non-PAYG) | **`2 OCPU / 12 GB`** (2026 cap) | `200 GB` disk, `10 TB/mo` | `7d` idle reclaim; SG OOC; no PyPI `paddlepaddle` `aarch64` | `BLOCKED / UNVERIFIED` |
| **CF Workers + Cron** | `$0` | **No** | None (`Error 1027`) | `10 ms` CPU, `128 MB` isolate | `100k` req/day, `5` crons | Edge stateless JS/Pyodide | **Verified Cardless Cron & Keepalive** |
| **CF R2** | `$0` (`<=10 GB`) | **Yes** (`Err 10042`) | Medium (billable overage) | Storage only | `10 GB`, `1M` A / `10M` B, `$0` egress | Requires card on file | Disqualified for strictly cardless; strong if card OK |
| **CF Containers** | `$5/mo+` | **Yes** | Medium (duration metered) | `256 MiB`–`12 GiB` | `500 GB–1 TB` egress | **No free tier** | `FAILED` for `0 VND` |
| **Modal Starter** | `$0` (`$30` credit) | **Yes** | Medium (overage risk) | Per-sec CPU/RAM/GPU | `1 TiB/mo` egress | Cold start (`16–55s`), US latency | `FAILED` for cardless / realtime Voice |
| **Backblaze B2** | `$0` (`<=10 GB`) | **No** (basic test) | Low (cap alerts) | Storage only | `10 GB`, `3x` egress (`$0` via CF), `$6.95/TB` | S3 API; public/scale may need card | Viable `10 GB` catalog audio/image offload |
| **GitHub Actions** | `$0` | No | None | `2–4 vCPU`, `7–16 GB` | `2,000 min/mo` private (`500 MB`) | `6h`/job; `render-keepalive` blows cap! | CI/APK + low-freq cron (`<=1/hr` max) |
| **GCP / AWS / Azure / IBM** | `$0` trial / 6–12m | **Yes** | **HIGH** (GCP/IBM) | `1 GB` RAM VMs | `1 GB/mo` GCP egress | Expires `6–12 mo` (`1 GB` OOMs AI) | `FAILED` |
| **Azure for Students** | `$0` (`$100`/12m) | **No** (student) | Stops at `$100` | Can rent `4–8 GB` VM temporarily | Standard Azure egress | Expires at `12 mo` / graduation | Temporary academic capstone VM only |
| **Paid SG VPS (Hetzner/Vultr/DO)** | `$6–$48/mo` | Yes | Fixed/usage | `4–8 GB` RAM `x86_64` | `40–160 GB` NVMe, `3–20 TB` | True 24/7 SLA (`sin`) | **Option 8 Paid Baseline** |
