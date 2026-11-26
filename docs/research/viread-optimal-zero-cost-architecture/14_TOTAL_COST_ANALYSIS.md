# 14 — Total Cost Analysis (TCO) & Post-Optimization Egress Simulation

**Research Date:** `2026-11-25`  
**Methodology:** Strict 3-layer cost accounting (**Cloud Cash Outlay** vs. **Owner Hardware/EVN/Domain Outlay** vs. **True Economic TCO**) extending [17_TOTAL_COST_OF_OWNERSHIP.md](file:///F:/c1/capstone1-staging-release/docs/research/zero-cost-production-v2/17_TOTAL_COST_OF_OWNERSHIP.md), backed by measured RC compression/OCR benchmarks (`#19`, `#24`, `#26`, `#28`) and the deterministic 384-row simulation in [14_COST_SIMULATION.csv](file:///F:/c1/capstone1-rc-zero-cost/docs/research/viread-optimal-zero-cost-architecture/14_COST_SIMULATION.csv). Exchange rate reference: `1 USD = 25,400 VND`.

---

## 1. Three-Layer Cost Comparison Across All 8 Candidate Architectures

| Option | Architecture | (1) Cloud Cash / mo | (2) Owner Capex (One-Time) | (3) Owner EVN + Domain / mo | (4) True Economic TCO / mo (incl. wear & ops) | Scaling / Exhaustion Cliff |
|---|---|---:|---:|---:|---:|---|
| **Option 1 (Baseline)** | Laptop + Quick Tunnel + Unoptimized Egress (`v2 A/H`) | **`0 VND`** *(<= `10_DAU Low`)* | `0 VND` *(existing laptop)* | `~2k–341k VND` EVN (`8%–10%` VAT) | `~200k–650k+ VND` | **Render `5 GB/mo`** breaks Day 24 (`Defense_Day Typ`) & Day 19 (`10_DAU Typ`) |
| **Option 1-Hardened** | RC Laptop + Proxyless + MP3 + VAD-STT + JPEG `q=85` + CF Cron | **`0 VND`** *(<= `Defense_Day Peak` / `10_DAU Typ`)* | `0 VND` *(existing laptop)* | `~2k–341k VND` EVN + `0–25k` domain | `~200k–650k+ VND` | **Supabase `5 GB` Uncached** breaks at `10_DAU Peak` (`5.66 GB/mo`) |
| **Option 2** | Dedicated Free Cloud PaaS / Docker (`Oracle A1` / `Render` / `HF` / `SnapDeploy` / `Back4App`) | `0 VND` *(or `$9` HF PRO)* | `0 VND` | `0 VND` | N/A (**`FAILED / BLOCKED`**) | `512 MB` OOMs AI; Oracle VN CC/OOC/`aarch64`; ClawCloud terminated `2026-06-30` |
| **Option 3** | Laptop Voice + Free Cloud CPU OCR (`v2 C/E`) | `0 VND` | `0 VND` | `~12k–207k+ VND` EVN | `~200k–500k+ VND` | **`FAILED`** (no free `>=2 GB` x86 OCR cloud; GTX 1650 `4 GiB` OOMs Ollama) |
| **Option 4** | Serverless (`Modal $30` / `CF Containers $5+` / `Colab` / `GHA`) | `$0–$5+/mo` *(card req)* | `0 VND` | `0 VND` | Card overage risk | **`FAILED`** (`18–33s` cold starts fail `<=2s` Voice; Colab/GHA ToS bans) |
| **Option 5** | **Browser WASM `sherpa-onnx` STT + Precomputed MP3 TTS + CF Cron + Proxyless + JPEG `q=85`** | **`0 VND`** *(<= **`10_DAU Peak`**; **`50_DAU Typ`** w/ B2)* | `0 VND` *(existing laptop)* | `~7k–180k VND` EVN *(40% less worker duty)* + `0–25k` domain | `~150k–450k VND` *(shifts `~45 MB` WASM DL to browser)* | **Supabase `5 GB` Cached** hits `5.52 GB` at `50_DAU Typ` (offloadable to B2 `10 GB` free) |
| **Option 6** | **Single-Runtime ONNX OCR Offloading** (`1,413.5 MB` RSS, `-49.8%` latency) | `0 VND` *(on Leapcell/Mini-PC)* | `0 VND` | Depends on host | Depends on host | **`FAILED` on `512 MB–1 GB`**; viable on `>=2–4 GB` host / Leapcell (`4 GB`) / ARM64 R&D |
| **Option 7** | **Owned Linux Mini-PC 24/7 Docker** (`v2 I-24/7-MiniPC`, RC Hardened) | **`0 VND`** *(academic)* | `0 VND` *(if owned)* / `2–4M VND` used + `350–500k` UPS | `~22k–120k VND` EVN (`15–40W`) + `0–25k` domain (`0` Student Pack Y1) | `~120k–300k VND` *(excl. daily laptop wear)* | Same free-tier egress limits as Option 1-Hardened or Option 5 if Render/Supabase used; `0` Render BW if co-hosted behind Named Tunnel |
| **Option 8** | **Paid Singapore VPS Baseline** (`Hetzner SG` vs `Vultr/DO SG`) | **`~165k–1.52M VND/mo`** (`$6.50–$60/mo`) | `0 VND` | `0 VND` home EVN (+`25k` domain) | **`~165k–1.52M VND/mo`** *(pure OPEX, zero HW wear)* | Hetzner `CX23` `4 GB` (`~$6.50/mo`) handles OCR+Voice+Web; `8 GB` (`~$15/mo`) adds CPU Ollama; commercial adds Vercel Pro `$20` + Supabase Pro `$25` |

> **EVN Electricity Reference (`2026-11-25`):** Per QĐ `1305/QĐ-EVN` & QĐ `2892/QĐ-BCT` (effective `2026-11-01`) + NĐ `174/2025/NĐ-CP` (`8%` VAT through `2026-12-31`, `10%` VAT from `2027-01-01`), residential marginal rates span **`2,053 – 4,152 VND/kWh`** (`8%` VAT) / **`2,091 – 4,228 VND/kWh`** (`10%` VAT). See [06_WINDOWS_CLOUDFLARE_RESEARCH.md](file:///F:/c1/capstone1-staging-release/docs/research/zero-cost-production-v2/06_WINDOWS_CLOUDFLARE_RESEARCH.md#L87-L129) for the full 16-row `4h–24h` wattage matrix.

---

## 2. Measured RC Optimization Levers (Grounded in Code & Benchmarks)

1. **Proxyless Owner-Scoped Signed URLs ([book_access.py](file:///F:/c1/capstone1-rc-zero-cost/backend/app/policies/book_access.py)):**
   - Eliminates Render FastAPI streaming private book bytes (`PRIVATE_SIGNED_URL_TTL_SECONDS=300`, `is_private_storage_path_owned_by`, `Cache-Control: private, no-store`).
   - **Impact:** Drops Render Outbound private-image proxy traffic from `~7%–23%` of Render bandwidth to **`0.00 GB/mo`**.
2. **Compressed TTS Negotiation ([voice_worker.py](file:///F:/c1/capstone1-rc-zero-cost/scripts/windows/voice_worker.py#L792-L839) & `@ai-bench-pg-sre` Exp D `#24`):**
   - `audio/mpeg` (MP3 `64 kbps` via PyAV `libmp3lame`) shrinks measured 48 kHz WAV payloads from `275,564–367,724 B` to `23,468–31,148 B` (**`11.74x–11.82x` smaller**, `WER = 0.0909` unchanged vs WAV!).
   - `audio/ogg` shrinks `275,564 B` to `24,459 B` via default PyAV Ogg (`11.27x`) and `11,121–15,328 B` at `32 kbps` Opus (**`23.63x–26.33x` smaller**, `WER = 0.0909` unchanged!).
   - **Model Parameter:** Simulation uses the conservative universal WebView+desktop **`11.8x` (`MP3`)** factor for Render Outbound TTS.
3. **VAD / Speech-Pause Gated Interim STT ([local-segment-speech-recognition.ts](file:///F:/c1/capstone1-rc-zero-cost/frontend/lib/reading/local-segment-speech-recognition.ts#L99-L1082)):**
   - Extends `INTERIM_STEP_MS` from `320 ms` to **`440 ms`**, tightens `MAX_SEGMENT_MS` to `3,600 ms`, enforces `>= 80 ms` new voiced speech (`MIN_NEW_VOICED_INTERIM_SAMPLES`), trims trailing silence >`120 ms`, and flushes early on `160 ms` clause pauses (`>= 1,800 ms`).
   - **Impact:** Cuts cumulative STT WAV upload amplification by **`>65%`** (`0.35x` of baseline inbound tunnel traffic), preserving `<50 ms` word highlight responsiveness.
4. **Optional JPEG `quality=85` Rasterizer ([document_rasterizer_service.py](file:///F:/c1/capstone1-rc-zero-cost/backend/app/services/document_rasterizer_service.py) & `@ai-bench-pg-sre` Exp C `#26`):**
   - Measured paired PNG -> JPEG `q=85`: **10-case dataset** `28,673,377 B -> 2,746,362 B` (**`-90.42%`**), **24-page fixture** `1,540,411 B -> 585,126 B` (**`-62.01%`**), with **zero quality loss** (`CER 0.020644 -> 0.017001`, `IoU@0.50 F1 0.977505 -> 0.988741`).
   - **Model Parameter:** Conservative blended **`0.25x` (`-75%`)** applied to new uploaded page storage and image egress.
5. **Option 5 Novel Levers (Browser WASM STT + Precomputed Catalog TTS + CF Cron):**
   - Browser WASM `sherpa-onnx` (`34.22 MB` Zipformer model + `~10–15 MB` WASM) cuts server STT inbound traffic to **`0.00 GB/mo`** (one-time `~45 MB` browser cache per device).
   - Precomputed Catalog MP3 TTS (`85%` of reading TTS) + reusable catalog URLs (`65%` of catalog image egress) shifts static reads to **Supabase `5 GB/mo` Cached Egress** (or Backblaze B2 `10 GB` free), cutting Render Outbound TTS to **`15%`** of `RC_Opt_MP3` (`~78x` lower than baseline WAV!).

---

## 3. Exact 30-Day (`1m`) Post-Optimization Simulation Summary ([14_COST_SIMULATION.csv](file:///F:/c1/capstone1-rc-zero-cost/docs/research/viread-optimal-zero-cost-architecture/14_COST_SIMULATION.csv))

The full `384`-row CSV models `4` Modes × `4` Scenarios (`Owner_Only`, `Defense_Day`, `10_DAU`, `50_DAU`) × `4` Profiles (`Low`, `Typical`, `Peak`, `Worst_Case`) × `6` Horizons (`1d`, `1m`, `3m`, `6m`, `1y`, `2y`). Below are the critical `1m` (`30`-day) inflection points:

| Scenario & Profile | Mode | Storage (`<=1024 MB`) | Supa Uncached (`<=5.0 GB`) | Supa Cached (`<=5.0 GB`) | Render Outbound (`<=5.0 GB`) | STT Inbound Tunnel | First Exhausted Component & Status |
|---|---|---:|---:|---:|---:|---:|---|
| **`Owner_Only Typical`** (`30` OCR, `135` min) | `Baseline_Unoptimized` | `148.8 MB` | `0.98 GB` | `0.00 GB` | `0.80 GB` | `0.99 GB` | `None_Within_Free_Tier` (`CONDITIONAL`) |
| | `RC_Opt_JPEG85_MP3` | `130.9 MB` | **`0.28 GB`** | `0.00 GB` | **`0.07 GB`** | `0.35 GB` | `None_Within_Free_Tier` (`CONDITIONAL`) |
| | `Option5_WASM_Precomp` | `175.9 MB` | **`0.13 GB`** | `0.20 GB` | **`0.02 GB`** | **`0.00 GB`** | `None_Within_Free_Tier` (`CONDITIONAL`) |
| **`Defense_Day Typical`** (`360` OCR, `1,080` min) | `Baseline_Unoptimized` | `411.1 MB` | `3.66 GB` | `0.00 GB` | **`6.37 GB`** | `7.91 GB` | **`FAILED` (`Render_Free_Bandwidth_5GB_Mo` Day 24)** |
| | `RC_Opt_PNG_MP3` | `411.1 MB` | `3.49 GB` | `0.00 GB` | **`0.58 GB`** | `2.77 GB` | `None_Within_Free_Tier` (`CONDITIONAL`) |
| | `RC_Opt_JPEG85_MP3` | **`196.5 MB`** | **`1.05 GB`** | `0.00 GB` | **`0.58 GB`** | `2.77 GB` | `None_Within_Free_Tier` (`CONDITIONAL`) |
| | `Option5_WASM_Precomp` | `241.5 MB` | **`0.49 GB`** | `0.98 GB` | **`0.17 GB`** | **`0.00 GB`** | `None_Within_Free_Tier` (`CONDITIONAL`) |
| **`Defense_Day Peak`** (`540` OCR, `2,700` min) | `Baseline_Unoptimized` | `882.4 MB` | `16.15 GB` | `0.00 GB` | `19.58 GB` | `19.78 GB` | **`FAILED` (`Render_Free_Bandwidth_5GB_Mo` Day 8)** |
| | `RC_Opt_PNG_MP3` | `882.4 MB` | **`15.38 GB`** | `0.00 GB` | `1.52 GB` | `6.92 GB` | **`FAILED` (`Supabase_Uncached_Egress_5GB_Mo` Day 10)** |
| | `RC_Opt_JPEG85_MP3` | **`314.4 MB`** | **`4.64 GB`** | `0.00 GB` | **`1.52 GB`** | `6.92 GB` | **`PASSES` (`None_Within_Free_Tier`)** |
| | `Option5_WASM_Precomp` | `359.4 MB` | **`2.15 GB`** | `3.54 GB` | **`0.48 GB`** | **`0.00 GB`** | **`PASSES` (`None_Within_Free_Tier`)** |
| **`10_DAU Typical`** (`300` OCR, `1,350` min) | `Baseline_Unoptimized` | `363.4 MB` | `4.30 GB` | `0.00 GB` | **`7.95 GB`** | `9.89 GB` | **`FAILED` (`Render_Free_Bandwidth_5GB_Mo` Day 19)** |
| | `RC_Opt_PNG_MP3` | `363.4 MB` | `4.10 GB` | `0.00 GB` | **`0.73 GB`** | `3.46 GB` | **`PASSES` (`None_Within_Free_Tier`)** |
| | `RC_Opt_JPEG85_MP3` | **`184.6 MB`** | **`1.24 GB`** | `0.00 GB` | **`0.73 GB`** | `3.46 GB` | **`PASSES` (`None_Within_Free_Tier`)** |
| | `Option5_WASM_Precomp` | `229.6 MB` | **`0.57 GB`** | `1.18 GB` | **`0.21 GB`** | **`0.00 GB`** | **`PASSES` (`None_Within_Free_Tier`)** |
| **`10_DAU Peak`** (`450` OCR, `3,375` min) | `Baseline_Unoptimized` | `756.1 MB` | `19.69 GB` | `0.00 GB` | `24.45 GB` | `24.72 GB` | **`FAILED` (`Render_Free_Bandwidth_5GB_Mo` Day 7)** |
| | `RC_Opt_JPEG85_MP3` | `282.8 MB` | **`5.66 GB`** | `0.00 GB` | `1.90 GB` | `8.65 GB` | **`FAILED` (`Supabase_Uncached_Egress_5GB_Mo` Day 27)** |
| | `Option5_WASM_Precomp` | **`327.8 MB`** | **`2.62 GB`** | **`4.35 GB`** | **`0.60 GB`** | **`0.00 GB`** | **`PASSES` (`None_Within_Free_Tier`)** |
| **`50_DAU Typical`** (`1,350` OCR, `6,750` min) | `Baseline_Unoptimized` | `1,197.9 MB` | `18.93 GB` | `0.00 GB` | `39.74 GB` | `49.44 GB` | **`FAILED` (`Render_Free_Bandwidth_5GB_Mo` Day 4)** |
| | `RC_Opt_JPEG85_MP3` | `393.2 MB` | **`5.44 GB`** | `0.00 GB` | **`3.65 GB`** | `17.30 GB` | **`FAILED` (`Supabase_Uncached_Egress_5GB_Mo` Day 28)** |
| | `Option5_WASM_Precomp` | `438.2 MB` | **`2.52 GB`** | **`5.52 GB`** | **`1.05 GB`** | **`0.00 GB`** | **`FAILED` (`Supabase_Cached_Egress_5GB_Mo` Day 27)** *(Passes at `0 VND` if static MP3/catalog offloaded to Backblaze B2 `10 GB` free!)* |
| **`50_DAU Peak`** (`2,025` OCR, `16,875` min) | `RC_Opt_JPEG85_MP3` | `835.0 MB` | `27.51 GB` | `0.00 GB` | `9.51 GB` | `43.26 GB` | **`FAILED` (`Local_Voice_CPU_Semaphore` Day 1)** |
| | `Option5_WASM_Precomp` | `880.0 MB` | **`12.74 GB`** | `21.30 GB` | **`2.99 GB`** | **`0.00 GB`** | **`FAILED` (`Supabase_Uncached_Egress_5GB_Mo` Day 12)** *(CPU semaphore relieved by 85% TTS offload, but egress hits Pro)* |

---

## 4. Key Cost & Scaling Takeaways

1. **Every Single RC Optimization Is Proven Mathematically Necessary:**
   - **Proxyless + MP3 + VAD-STT alone (`RC_Opt_PNG_MP3`)** rescues **`Defense_Day Typical`** (`6.37 -> 0.58 GB` Render) and **`10_DAU Typical`** (`7.95 -> 0.73 GB` Render) from Render's `5 GB/mo` wall (`5/16 -> 8/16` 1m scenarios pass).
   - **Adding JPEG `q=85` (`RC_Opt_JPEG85_MP3`)** rescues **`Defense_Day Peak`** (`15.38 -> 4.64 GB` Supabase Uncached) and **`Owner_Only Worst_Case`**, bringing `1m` pass rate to **`10/16`**, and cuts `2y` `10_DAU Typical` Storage from `5,926.7 MB` down to `1,575.4 MB` (buying ~8 months of `1 GB` Storage runway instead of 3.5 months!).
   - **Adding Option 5 (`Browser WASM STT + Precomputed Catalog MP3`)** rescues **`10_DAU Peak`** (`11/16` pass inside Free Tier) and reduces **`50_DAU Typical`** Render bandwidth by **`37.8x`** (`39.74 -> 1.05 GB/mo`), leaving `50_DAU Typical` just `0.52 GB` above Supabase's `5 GB` Cached Egress cap (completely eliminated if catalog static assets move to Backblaze B2 `10 GB` free + Cloudflare Bandwidth Alliance).
2. **Minimum Paid Graduation Path (When Crossing Free Caps or Launching Commercially):**
   - **Academic Scale (`>10_DAU Peak` or `>500 MB` DB):** Add **Backblaze B2** (`0 VND` up to `10 GB`) for static catalog/audio first, or **Supabase Pro (`$25/mo`)** + **Hetzner Singapore `CX23` `4 GB` (`~$6.50/mo`)** (replacing Render `$7/mo` + laptop electricity in one stroke!).
   - **Commercial Launch (Any Scale):** **Vercel Pro (`$20/user/mo`)** is mandatory by ToS, paired with **Hetzner SG (`~$6.50–$15/mo`)** + **Supabase Pro (`$25/mo`)** = **`~$51.50–$60/mo` (`~1.31–1.52M VND/mo`)** total for full 24/7 commercial ViRead.
