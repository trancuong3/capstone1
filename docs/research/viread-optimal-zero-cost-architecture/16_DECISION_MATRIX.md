# 16 — Weighted Decision Matrix & Comparative Ranking (Section 12)

> **Auditor:** `@independent-red-team`  
> **Verification Date:** `2026-11-25`  
> **Governance Rule:** Section 12 mandates scoring the 100-point optimization matrix **ONLY for candidates passing ALL 12 Hard Constraint Gates**.

---

## 1. Hard-Gate Eligibility Declaration

As proven in [15_HARD_CONSTRAINT_GATE.md](file:///F:/c1/capstone1-rc-zero-cost/docs/research/viread-optimal-zero-cost-architecture/15_HARD_CONSTRAINT_GATE.md), **ZERO (`0 / 11`) candidate architectures pass all 12 Hard Constraint Gates simultaneously** (`G01–G12`).

Therefore:
- **Strictly qualified candidates for unqualified 100-point Production eligibility:** **`NONE (0)`**.
- Below, in full transparency, we present:
  1. The **Closest Viable Candidates Ranked by Unmet Gate Count & Operational Readiness** (explicitly listing every `FAIL`, `BLOCKED`, and `UNVERIFIED` Hard Gate — **scores NEVER override a Hard Gate failure**).
  2. A **Comparative Section 12 / Section 29 Reference Scoring Table** (`Laptop-Off=25`, `Stability=20`, `Performance=15`, `Self-Recovery=10`, `Scalability=10`, `Maintainability=10`, `Resource-Eff=5`, `Vendor-Indep=5` = `100`) labeled strictly as **Comparative Reference Only (Non-Qualified Pending Gate Remediation)**.

---

## 2. Closest Candidates Ranked by Unmet Hard-Gate Conditions

| Rank | Candidate Architecture | Gates Passed (`12`) | Exact Unmet Conditions (`FAIL` / `BLOCKED` / `UNVERIFIED`) | Best Real-World Use Case |
| :---: | :--- | :---: | :--- | :--- |
| **#1 (Overall 24/7 Cloud)** | **Option 8: Paid SG VPS Baseline** (`Hetzner SG 4–8 GB` + Vercel Pro + Supabase Pro) | **8 / 12** *(or 9/12 w/ Supa Pro)* | **`FAIL` G01** (`~$6.50–$60/mo > 0 VND`), **`FAIL` G04** (card required), **`UNVERIFIED` G07** (real child speech), **`FAIL` G10** (`role_cache` 60s lag; Supa LPP if Free), **`BLOCKED` G12** (`Honor X9d` live RC E2E). | **Commercial / School Production** (only path clearing `G02`, `G03`, `G05`, `G11` commercial ToS). |
| **#2 (Zero-Cloud 24/7)** | **Option 7: Owned Linux Mini-PC 24/7 Docker** (`RC Hardened` + Named Tunnel) | **6 / 12** | **`FAIL` G02** (EVN `22k–120k VND/mo` + Mini-PC/UPS), **`UNVERIFIED` G05** (10-worker compose on physical Mini-PC untested), **`FAIL` G07** (`int8` minimal pairs `7/17`, 8-voice `P95 3.65s > 2s`, `0` child samples), **`FAIL` G10** (`role_cache` 60s lag, Supa Free LPP, CBIA), **`FAIL` G11** (Vercel Hobby non-commercial only), **`BLOCKED` G12** (`Honor X9d` E2E). | **Zero-Cloud-Cash 24/7 Academic / Family Host** (if spare x86 Mini-PC is owned). |
| **#3 (Zero-Card Defense)** | **Option 1-Hardened (`RC`, Laptop-On)** | **5 / 12** | **`FAIL` G02** (EVN `2k–341k VND/mo` + laptop wear), **`FAIL` G03** (Laptop-Off -> Voice `503` + stalled OCR), **`FAIL` G05** (`karaoke_processing` CLI manual; CF Cron `720h/750h` Render pool), **`FAIL` G07** (`P95 3.65s`, `0` child samples), **`FAIL` G10** (`role_cache` 60s lag, Quick Tunnel, Supa Free LPP), **`FAIL` G11** (Quick Tunnel / Vercel commercial), **`BLOCKED` G12** (`Honor X9d` E2E). | **Immediate `0 VND` Cloud Capstone Defense** (tested & runnable today while laptop is ON). |
| **#4 (Best Scale Architecture)** | **Option 5: `RC + Browser WASM STT + Precomputed MP3 + CF Cron + Proxyless + JPEG q=85`** | **3 / 12** *(today)* | **`FAIL` G02/G03** (dynamic TTS/OCR still need laptop/worker), **`UNVERIFIED` G05/G07/G08/G09** (WASM STT, precomputed MP3 batch, and public catalog CDN URLs not yet built in RC; `book_service.py` still uses `?token=`), **`FAIL` G10/G11**, **`BLOCKED` G12**. | **Best Post-Defense Egress Optimizer** (cuts Render BW `37.8x` & clears `10_DAU Peak` at `0 VND` once built). |
| **#5 (R&D Acceleration)** | **Option 6B: ONNX OCR on `>=2–4 GB` (`Leapcell` / Mini-PC)** | **2 / 12** *(today)* | **`FAIL` G08 on `512 MB–1 GB`** (`1,413.50 MB` RSS!), **`UNVERIFIED` G03/G05/G08/G09** on Leapcell/`aarch64`, **`FAIL` G02/G10/G11**, **`BLOCKED` G12**. | **Upgrade Engine inside Options 7/8** (`-49.8%` OCR latency, `-34.3%` commit, eliminates `paddlepaddle` `aarch64` lock). |
| **Disqualified** | **Options 2A (`Oracle A1`), 2B (`Free PaaS/HF/Snap/Back4App`), 3 (`Split`), 4 (`Modal/CF Cont/Colab/GHA`)** | **1–4 / 12** | Fatal OOMKills (`256–1024 MB < 1,413.5 MB`), `TERMINATED` (`ClawCloud 2026-06-30`), VN card/OOC blocks (`Oracle A1`), or explicit ToS/auto-bill violations (`Colab`/`GHA`/`Modal`/`Fly`). | **Rejected.** |

---

## 3. Comparative Reference Scoring Table (Non-Qualified — Comparative Guidance Only)

> **Warning:** None of the options below pass all 12 Hard Gates. Weights follow Section 29 / Section 12 literal criteria (`Laptop-Off = 25`, `Stability = 20`, `Performance = 15`, `Self-Recovery = 10`, `Scalability = 10`, `Maintainability = 10`, `Resource-Eff = 5`, `Vendor-Indep = 5`). Any candidate requiring the personal laptop ON scores **`0.0`** on `Laptop-Off (25)`.

| Candidate | Laptop-Off (`25`) | Stability (`20`) | Perf (`15`) | Recovery (`10`) | Scale (`10`) | Maintain (`10`) | Resource (`5`) | VendorInd (`5`) | Ref. Score (`/100`) | Blocking Hard Gates |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| **Option 8: Paid SG VPS (`Hetzner 4–8 GB` + Pro)** | `10.0` | `9.2` | `9.0` | `9.0` | `8.5` | `8.5` | `8.0` | `8.5` | **90.25** | `FAIL` G01, G04; `UNVERIFIED` G07; `BLOCKED` G12 |
| **Option 7: Owned Linux Mini-PC 24/7 Docker** | `9.5` | `8.5` | `8.5` | `8.5` | `7.0` | `8.0` | `8.0` | `8.0` | **85.00** | `FAIL` G02, G07, G10, G11; `UNVERIFIED` G05; `BLOCKED` G12 |
| **Option 5: `RC + WASM STT + Precomp MP3` (on Mini-PC / Laptop-Off Partial)** | `6.0` | `7.5` | `8.5` | `7.5` | `8.5` | `6.5` | `9.0` | `7.5` | **73.50** | `FAIL` G02, G03, G10, G11; `UNVERIFIED` G05/G07/G08/G09; `BLOCKED` G12 |
| **Option 1-Hardened (`RC`, Laptop-On)** | **`0.0`** | `7.5` | `8.0` | `7.5` | `6.5` | `7.5` | `8.0` | `7.0` | **56.00** | `FAIL` G02, G03, G05, G07, G10, G11; `BLOCKED` G12 |
| **Option 6B: ONNX OCR (`Leapcell 4 GB` / Split)** | `5.0` | `5.5` | `7.5` | `5.5` | `6.0` | `5.5` | `7.5` | `6.0` | **58.50** | `FAIL` G02, G08 (`512M–1G`), G10, G11; `UNVERIFIED` G05/G09 |
| **Option 2A: Oracle A1 (`ARM64`)** | `9.5` | `5.0` | `4.5` | `6.5` | `6.0` | `3.5` | `7.0` | `7.0` | **63.00** | `BLOCKED` G04, G12; `UNVERIFIED` G06/G07/G08 |
| **Option 1-Baseline (`v2 A/H`)** | **`0.0`** | `5.5` | `6.5` | `5.5` | `3.5` | `6.0` | `5.5` | `5.5` | **44.50** | `FAIL` 8+ Gates; `BLOCKED` G12 |
| **Options 2B / 3 / 4 (Disqualified)** | `0.0–7.0` | `2.0–4.5` | `1.5–4.0` | `2.5–4.5` | `2.0–4.0` | `3.0–5.0` | `2.0–4.0` | `1.5–4.5` | **24.00–43.50** | Fatal OOM / Terminated / ToS / Billing |

### Decision Guidance (When Relaxing Mutually Exclusive Constraints)
1. **For Capstone Defense (`0 VND` Cloud, Owner Present):** Use **Option 1-Hardened (`RC`)** — already implemented, verified (`14/14` rasterizer, `159` PG16 tests, `2,614` Vitest, `18/18` Android scripts, `37`-task Gradle), and cuts `Defense_Day Peak` egress inside Supabase/Render Free caps. (Upgrade Voice Quick Tunnel to Named Tunnel if a `$0` Student Pack domain is linked.)
2. **For True 24/7 Laptop-Off at `0 VND` Cloud:** Move `ocr_worker` (preferring **Option 6 ONNXRuntime** for `-49.8%` latency & `-1.06 GB` commit) + `voice_worker` + all 10 crons onto **Option 7 (Owned Linux Mini-PC)** + Cloudflare Named Tunnel, accepting `~22k–120k VND/mo` home EVN.
3. **For Commercial / Multi-School Scale:** Adopt **Option 8 (`Hetzner SG 4–8 GB` + Vercel Pro + Supabase Pro)** (`~$51.50–$60/mo`), adding **Option 5** (`WASM STT` + `Precomputed Catalog MP3`) if scaling past 50+ DAU.
