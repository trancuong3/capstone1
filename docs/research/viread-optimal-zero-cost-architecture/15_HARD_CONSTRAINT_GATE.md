# 15 — Hard Constraint Gate Matrix (GATE 01–GATE 12) & Infeasibility Analysis

> **Auditor:** `@independent-red-team`  
> **Verification Date:** `2026-11-25`  
> **Strict Status Enum Rule:** Every gate cell uses **ONLY `{PASS, FAIL, UNVERIFIED, BLOCKED}`**. No `CONDITIONAL` or unexecuted feature is ever promoted to `PASS`.

---

## 1. Hard Constraint Gate Definitions (GATE 01–GATE 12)

| Gate | Hard Constraint | Strict Pass Threshold |
|---|---|---|
| **G01** | **Zero Cloud Cash Outlay** | `0 VND/mo` across Vercel, Backend, DB, Storage, AI, Tunnel (`Owner_Only` – `10_DAU Typical`) |
| **G02** | **Zero True Economic Cost (incl. EVN & Wear)** | `0 VND/mo` total economic outlay including EVN electricity (`2,053–4,228 VND/kWh`), hardware wear, and domain |
| **G03** | **True 24/7 Availability With Personal Laptop OFF** | All realtime Voice, camera scan, async OCR, and scheduled jobs stay live when the owner's personal laptop is powered off |
| **G04** | **Zero-Card / Zero-Auto-Billing Onboarding** | Deployable in Vietnam with zero mandatory physical international credit card and zero auto-billing cliff |
| **G05** | **Full 22-Feature & 10-Worker Parity** | All `F-01..F-22` plus all background/cron workers (`ocr_worker`, `parent_book_submission`, `book_quality`, `admin_ai_workflow`, `viread_ocr_outbox`, `viread_ocr_training`, `reading_reminder`, `reading_presence`, `karaoke_processing`, `active_model_registry`) operational 24/7 |
| **G06** | **3-Engine OCR Non-Regression & 14/14 Rasterizer Pass** | Preserves `FLOW1_EXTERNAL_TRDG`, `CER <= 0.020644`, `IoU@0.50 F1 >= 0.977505`, zero silent fallback, and **`14/14` `test_document_rasterizer_and_upload.py` pass** |
| **G07** | **Voice Non-Regression, SLA & Real Child Calibration** | `TTS P95 <= 2s`, `STT P95 <= 3s`, `highlight <= 50 ms`, minimal-pair tone integrity, AND live 6–7yo child speech accuracy verified |
| **G08** | **ABI Wheel Parity & Safe RAM/VRAM Footprint** | Zero OOMKill (`512 MB`/`1 GB`/host), ABI pins (`numpy==1.26.4`, `protobuf==3.20.2`, `opencv-python-headless==4.10.0.84`) verified in target runtime arch (`x86_64` or `aarch64`) |
| **G09** | **Cloud Egress & Storage Sustainability (`>= 10_DAU Typical`)** | Fits inside Render `5 GB/mo`, Supabase `5 GB` Uncached + `5 GB` Cached Egress & `1 GB` Storage for `>= 10_DAU Typical` |
| **G10** | **Zero Medium/High Security & Privacy Gaps** | All `429`, `12 MB` `match-page`, `Active==1` (without 60s deactivation lag), CSP headers, `auth/callback` allowlist, non-root Docker, Named Tunnel + Access Token, Supabase LPP, and VN PDP Law 91/2025 CBIA closed |
| **G11** | **Vendor ToS & Production Compliance** | Zero ToS violations (Vercel Hobby commercial ban, Quick Tunnel non-prod ban, Colab/Kaggle/GHA serving bans) |
| **G12** | **Live `Honor X9d` Parity & Zero User Cost-Shifting** | Physical `Honor X9d` (`MTN-NX1`) E2E passes on target RC origin AND zero multi-100MB/GB AI offloading to child devices |

---

## 2. Strict GATE 01–GATE 12 Evaluation Across All Candidate Architectures

| Candidate Architecture | G01 Zero Cloud $ | G02 Zero EVN/TCO | G03 24/7 Laptop-Off | G04 Zero Card | G05 Full Features/Crons | G06 OCR & 14/14 Raster | G07 Voice & Child SLA | G08 Wheel/RAM Fit | G09 `>=10 DAU` Egress | G10 Sec/Privacy Gaps | G11 Cloud ToS | G12 `Honor X9d`/No Shift |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Option 1-Baseline (`v2 A/H`, Pre-RC)** | `PASS` | `FAIL` | `FAIL` | `PASS` | `FAIL` | `FAIL` | `UNVERIFIED` | `PASS` | `FAIL` | `FAIL` | `FAIL` | `BLOCKED` |
| **Option 1-Hardened (`RC`, Laptop-On)** | `PASS` | `FAIL` | `FAIL` | `PASS` | `FAIL` | `PASS` | `FAIL` | `PASS` | `PASS` | `FAIL` | `FAIL` | `BLOCKED` |
| **Option 2A: Oracle A1 Free (`ARM64 2/12`)** | `PASS` | `PASS` | `PASS` | `BLOCKED` | `FAIL` | `UNVERIFIED` | `UNVERIFIED` | `UNVERIFIED` | `FAIL` | `FAIL` | `PASS` | `BLOCKED` |
| **Option 2B: Free PaaS / HF / Snap / Back4App / ClawCloud** | `FAIL` | `PASS` | `PASS` | `FAIL` | `FAIL` | `FAIL` | `FAIL` | `FAIL` | `FAIL` | `FAIL` | `FAIL` | `BLOCKED` |
| **Option 3: Hybrid Split (`v2 C/E`)** | `FAIL` | `FAIL` | `FAIL` | `PASS` | `FAIL` | `FAIL` | `UNVERIFIED` | `FAIL` | `FAIL` | `FAIL` | `FAIL` | `BLOCKED` |
| **Option 4: Serverless (`Modal` / `CF Cont.` / `Colab` / `GHA`)** | `FAIL` | `PASS` | `PASS` | `FAIL` | `FAIL` | `FAIL` | `FAIL` | `UNVERIFIED` | `FAIL` | `FAIL` | `FAIL` | `BLOCKED` |
| **Option 5: Novel `RC + Browser WASM STT + Precomp MP3 + CF Cron`** | `PASS` | `FAIL` | `FAIL` | `PASS` | `UNVERIFIED` | `PASS` | `UNVERIFIED` | `UNVERIFIED` | `UNVERIFIED` | `FAIL` | `FAIL` | `BLOCKED` |
| **Option 6: Single-Runtime ONNX OCR (`512 MB–1 GB` Target)** | `FAIL` | `PASS` | `PASS` | `FAIL` | `FAIL` | `PASS` | `UNVERIFIED` | `FAIL` | `UNVERIFIED` | `FAIL` | `FAIL` | `BLOCKED` |
| **Option 6B: ONNX OCR on `>=2–4 GB` (`Leapcell` / Mini-PC)** | `PASS` | `FAIL` | `UNVERIFIED` | `PASS` | `UNVERIFIED` | `PASS` | `UNVERIFIED` | `UNVERIFIED` | `UNVERIFIED` | `FAIL` | `FAIL` | `BLOCKED` |
| **Option 7: Owned Linux Mini-PC 24/7 Docker (`RC Hardened`)** | `PASS` | `FAIL` | `PASS` | `PASS` | `UNVERIFIED` | `PASS` | `FAIL` | `PASS` | `PASS` | `FAIL` | `FAIL` | `BLOCKED` |
| **Option 8: Paid Singapore VPS Baseline (`Hetzner SG` + Pro)** | `FAIL` | `PASS` | `PASS` | `FAIL` | `PASS` | `PASS` | `UNVERIFIED` | `PASS` | `PASS` | `FAIL` | `PASS` | `BLOCKED` |

---

## 3. Exact Traceability Justification per Gate Failure / Block / Unverified Status

- **G01 (`Zero Cloud Cash`):** `PASS` on Options **1, 2A, 5, 6B (Leapcell/Mini-PC), 7**. `FAIL` on **2B** (HF PRO `$9/mo`; Railway `$1` cap; ClawCloud terminated `2026-06-30`), **3/6** (`512 MB–1 GB` x86 free containers OOMKill OCR), **4** (`CF Containers` `$5/mo+`), and **8** (`~$6.50–$60/mo`).
- **G02 (`Zero EVN/TCO`):** `FAIL` on **1-Baseline, 1-Hardened, 3, 5, 6B (Mini-PC), 7** (`12k–341k VND/mo` EVN on laptop, `22k–120k VND/mo` on Mini-PC + hardware wear/UPS/domain). `PASS` only on pure cloud options **2, 4, 8** (which fail G01/G04).
- **G03 (`24/7 Laptop-Off`):** `FAIL` on **1-Baseline, 1-Hardened, 3** (laptop off -> Voice returns `503`, `scan-page-ocr` & OCR queue stall) and **5** (catalog reading + WASM STT stay up, **but** dynamic private-book TTS `15%` and live OCR still require laptop/worker ON). `PASS` on **7** (Owned Linux Mini-PC 24/7) and **8** (Paid SG VPS).
- **G04 (`Zero Card`):** `BLOCKED` on **Oracle A1** (physical international CC mandatory, VN debit/virtual cards rejected). `FAIL` on **2B** (HF PRO/Fly), **4** (`Modal` card required; `CF Containers` `$5` paid), **8** (VPS/Pro cards). `PASS` on **1, 5, 7**.
- **G05 (`Full Features & 10 Workers`):** `FAIL` on **1-Baseline** (5 workers disabled), **1-Hardened** (`karaoke_processing_worker` remains manual/offline CLI; CF Cron `*/5` keeps Render awake `720h/750h` leaving `30h` margin), **2/3/4/6** (OOM/no worker host). `UNVERIFIED` on **5** (WASM STT & precomputed MP3 generator not yet built) and **7** (10-worker systemd/compose on physical Linux Mini-PC `DOCUMENTED BUT NOT TESTED`). `PASS` on **8** (single `docker compose` on 4–8 GB SG VPS).
- **G06 (`OCR Non-Regression & 14/14 Rasterizer`):** `FAIL` on **1-Baseline** (`test_scenario_3` TIFF `<pad>` defect). **`PASS` on RC Options 1-Hardened, 5, 6, 7, 8**: `ocr_engine.py` + `ocr_adjudication.py` control-token fix verified (`14/14` `test_document_rasterizer_and_upload.py` pass on Py312; JPEG `q=85` `CER 0.017001 <= 0.020644`, `IoU@0.50 F1 0.988741`; ONNX `10/10` exact SHA-256 parity). `UNVERIFIED` on **Oracle A1** (`paddlepaddle==2.6.2` missing `aarch64` wheel).
- **G07 (`Voice SLA & Real Child Calibration`):** `FAIL` on **1-Hardened & 7** because: (a) 8-voice regional TTS `P95 = 3,645.30 ms` (`int8`) / `4,642.37 ms` (`fp32`) exceeds `<= 2,000 ms`, (b) `int8` isolated minimal pairs score `7/17` (carrier `12/17`; `"mốt"`->`"một"`), and (c) **real 6–7-year-old child speech is `UNVERIFIED` (`0` recordings tested)**! (Note: highlight latency `p95=23.45 ms <= 50 ms` and `STT p50=340.37 ms` / `p95=546.55 ms` pass on adult speech.)
- **G08 (`ABI & RAM Fit`):** `PASS` on **1, 7, 8** (`x86_64` ABI pins untouched, WSL2 Linux `1,438.39 MB` canary verified, `277.6 MB` Render web). **`FAIL` on Option 6 (`512 MB–1 GB`)** because measured ONNX OCR peak RSS is **`1,413.50 MB`** (`viable_512mb=false, viable_1gb=false`). `UNVERIFIED` on **Option 5** (Browser WASM `~100–200 MB` RAM unmeasured in real Chrome/Android WebView) and **Option 6B** (`Leapcell` 4 GB / `aarch64` untested).
- **G09 (`>=10_DAU Typical Egress`):** `FAIL` on **1-Baseline** (Render `5 GB/mo` breaks Day 19 at `7.95 GB/mo`). **`PASS` on Option 1-Hardened, 7, 8** (`10_DAU Typical` drops to `1.24 GB/mo` Supabase Uncached & `0.73 GB/mo` Render Outbound via Proxyless + MP3 + VAD-STT + JPEG `q=85`!). `UNVERIFIED` on **Option 5** (`14_TOTAL_COST_ANALYSIS` assumes `Supa Cached` shift for catalog books, **but** `book_service.py` & `reading_content_service.py` still generate `?token=` signed URLs today!).
- **G10 (`Zero Security/Privacy Gaps`):** `FAIL` across current deployments due to: (a) **`role_cache.py` 60-second `active == 0` deactivation lag** on `/voice/*` & `/support/feedback`, (b) Quick Tunnel without Named Tunnel + Access Token (Options 1/5), (c) Supabase Free Leaked Password Protection `BLOCKED` (Options 1–7, or Option 8 unless Supabase Pro `$25/mo` is purchased), and (d) VN PDP Law 91/2025 CBIA dossier pending for Mumbai/Oregon/Singapore transit.
- **G11 (`Vendor ToS`):** `FAIL` for commercial use on **Vercel Hobby** (academic non-commercial capstone only) and **Quick Tunnel** (`trycloudflare.com` non-production ban on Options 1/5). `PASS` on **Option 8** once using **Vercel Pro (`$20/mo`)** + custom domain.
- **G12 (`Honor X9d` & Zero Cost-Shifting):** **`BLOCKED`** across ALL options. Even though `Honor X9d` (`MTN-NX1`, `ATSYVB6205006984`, Android 16, `7.29 GiB` RAM) was inspected via ADB and confirmed to host the `2.1 MB` `NO_NATIVE_LIBS` WebView APK, **live E2E acceptance on the RC origin was not executed** (and `OFFLINE_POC_ARCHITECTURE.md` native Sherpa bridge is not implemented).

---

## 4. Formal Theorem: Simultaneous 12-Gate Infeasibility (`0 / 11` Pass All 12)

> **Audit Conclusion:** As of `2026-11-25`, **ZERO candidate architectures (`0 / 11` configurations across Options 1–8) pass all 12 Hard Constraint Gates simultaneously.**

1. **Physical RAM Wall (`1,413.5 MB` ONNX / `1,659.4 MB` Stock OCR + `860 MB` Voice):** Even with `torch` and `paddle` completely removed (`Experiment A`), ONNXRuntime OCR still peaks at **`1,413.50 MB` RSS (`2,033.34 MB` commit)** — proving mathematically that **no `512 MB–1 GB` free PaaS container (`Render`, `Koyeb`, `Northflank`, `SnapDeploy`, `Back4App`, `GCP e2-micro`, `AWS/Azure 1 GB`) can host ViRead OCR**.
2. **Free 24/7 Host Blockers (`Oracle A1` & `ClawCloud`):** `ClawCloud` permanently terminated `2026-06-30`; `Oracle A1` (`2/12 GB`) is `BLOCKED` by physical international CC rejection in Vietnam, chronic `ap-singapore-1` capacity exhaustion, 7-day idle reclaim, and missing PyPI `aarch64` `paddlepaddle` wheels.
3. **Economic & Legal Mutual Exclusion (`G01/G04` vs `G02/G03/G11`):**
   - Keeping Cloud Cash at `0 VND` (`G01/G04`) forces compute onto owned hardware (`Option 1-Hardened` laptop or `Option 7` Mini-PC), which **incurs unavoidable EVN electricity (`G02 FAIL`)** and fails `G03` if using the owner's portable laptop.
   - Eliminating home EVN and gaining 24/7 datacenter SLA + commercial ToS compliance (`Option 8`) requires **card-backed paid spend (`~$6.50–$60/mo`, `G01/G04 FAIL`)**.
4. **Unverified Child Domain & Live Mobile Origin (`G07/G12`):** Real 6–7-year-old Vietnamese child speech (`0` samples) and live `Honor X9d` E2E against the RC origin remain unexecuted (`FAIL/BLOCKED`).
