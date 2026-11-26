# 18 — Adversarial Red Team Findings (Options 1–8)

> **Reviewer:** `@independent-red-team`  
> **Audit Date:** `2026-11-25`  
> **Adversarial Premise:** Assume every single-point failure, billing trap, bandwidth spike, model edge case, and host contention scenario WILL happen during Capstone Defense or live multi-family usage unless prevented by verified code and measured limits.

---

## 1. Executive Red Team Verdict

**`NO-GO FOR UNATTENDED 24/7 ZERO-COST CLOUD PRODUCTION`**  
**`CONDITIONAL GO FOR OWNER-ATTENDED CAPSTONE DEFENSE (OPTION 1-HARDENED RC) AFTER APPLYING MIGRATIONS & RESOLVING OPEN TEST/CACHE NOTES`**

The RC worktree (`feat/viread-rc-zero-cost-20261125`) resolves the most dangerous baseline defects from `d5eee4dc`: `test_scenario_3` TIFF `<pad>` now passes `14/14`, `429`/`12 MB`/`Active==1`/CSP/OAuth-allowlist/non-root Dockerfile security controls are implemented, `parent_book_submission` + `outbox` + `auto_training` are decoupled from `is_remote_ocr_mode()`, soft-delete `409 BOOK_SOFT_DELETED` fencing is verified on live PG16, and Proxyless + MP3 (`11.74x`) + VAD-STT + JPEG `q=85` (`-62%` to `-90.4%`) keep `Defense_Day Peak` (`4.64 GB` Supa / `1.52 GB` Render) and `10_DAU Typical` (`1.24 GB` Supa / `0.73 GB` Render) inside free tiers.

However, **9 concrete adversarial attacks** remain active across Options 1–8.

---

## 2. Adversarial Attack Audit Across All 9 Mandated Vectors

### Attack 1: Laptop-Off Availability (`Options 1, 3, 5, 6`)
- **Target:** `Option 1-Hardened`, `Option 3`, `Option 5` (dynamic paths).
- **Attack Scenario:** Owner closes laptop on the way to defense or overnight. Child opens ViRead on Vercel (`viread-frontend.vercel.app`) or `Honor X9d` APK.
- **Measured Impact:** Every `/voice/text-to-speech`, `/voice/text-to-speech/timed`, `/voice/text-to-speech/phonics`, and `/voice/speech-to-text` request fails with **`503`** (`Topology 5` verified); `scan-page-ocr` & parent PDF uploads pile up in `ocr_inference_jobs` (`QUEUED`). Even **Option 5** (if built) only keeps *catalog* reading + client WASM STT alive when laptop is off — parent-uploaded private-book TTS (`15%`) and live camera scan OCR still die with `503`/`QUEUED`.
- **Mitigation:** Only **Option 7 (Owned Linux Mini-PC 24/7)** or **Option 8 (Paid SG VPS)** eliminates Laptop-Off downtime.

### Attack 2: EVN Electricity & Hardware Wear (`Options 1, 3, 5, 6B, 7`)
- **Target:** Any claim of `"0 VND total cost"` for `Option 1-Hardened` or `Option 7`.
- **Measured Reality:** Under Vietnam EVN QĐ 2892/QĐ-BCT (`2026-11-01`) + NĐ 174/2025 (`8%` VAT through `2026-12-31`, `10%` in `2027+`), keeping a laptop running costs **`~12k–335k+ VND/mo`** (`8–112W` wall draw) + laptop battery/fan depreciation (`~180–350k VND/mo`); a dedicated Mini-PC (`15–40W`) costs **`~22k–120k VND/mo`** EVN + mini-UPS + domain (`~25k/mo` after Year-1 Student Pack).
- **Red Team Ruling:** Never market home-hosted AI as `"0 VND true total cost"` — state explicitly **`0 VND Cloud Cash`** vs **`~12k–341k VND/mo Owner EVN`**.

### Attack 3: Credit Card Barriers & Silent Auto-Billing Cliffs (`Options 2, 4, 8`)
- **Target:** `Oracle A1`, `Cloudflare R2`, `CF Containers`, `Modal`, `Fly.io`, `Render (if card added)`, `GCP/IBM`.
- **Verified Traps:**
  1. **Oracle A1:** Rejects VN debit/virtual cards (`BLOCKED`), chronic `ap-singapore-1` `Out of host capacity`, `7-day` idle VM reclamation.
  2. **Cloudflare R2:** Fails with **`Error 10042`** unless a credit card is on file.
  3. **Cloudflare Containers:** Zero free tier — mandatory **`$5/mo` Workers Paid** + duration RAM billing.
  4. **Fly.io:** Bills full total once usage crosses `$5.00`; **Render** charges **`$0.15/GB`** if card is added (`50_DAU Worst_Case` without Option 5 would trigger surprise invoices).
  5. **Modal Starter:** `$30/mo` non-rollover credits require a credit card on file and bill overages automatically without hard cap alerts.

### Attack 4: Vendor ToS & Hidden Quota Exhaustion (`Options 1–7`)
- **Target:** `Vercel Hobby`, `Cloudflare Quick Tunnel`, `.github/workflows/render-keepalive.yml`, `infra/cloudflare-cron/`, `Colab/Kaggle`.
- **Verified Traps:**
  1. **GitHub Actions Keepalive Trap (Verified in Repo!):** [render-keepalive.yml](file:///F:/c1/capstone1-rc-zero-cost/.github/workflows/render-keepalive.yml) schedules `*/10 * * * *` (`4,320` runs/month = **`>=4,320` billed minutes/month**), **more than double** GitHub's `2,000 min/mo` private-repo free quota! (Explains why `capstone1-ssd8.onrender.com/health` timed out!)
  2. **Cloudflare Cron vs Render 750h Trap (New RC Finding!):** [wrangler.toml](file:///F:/c1/capstone1-rc-zero-cost/infra/cloudflare-cron/wrangler.toml) runs `*/5 * * * *` against `POST /internal/cron/dispatch`. Because Render Free sleeps after `15m` idle, a `5-minute` cloud cron keeps Render Free awake **24/7 = `720–744 hrs/mo` out of `750 hrs/mo` workspace pool** — if ANY second service or staging preview exists on that Render workspace, **both shut down around Day 16**! Moreover, [index.js](file:///F:/c1/capstone1-rc-zero-cost/infra/cloudflare-cron/src/index.js#L17) sets a `25,000 ms` abort timeout, which **aborts prematurely** if Render ever hits a `50–60s` cold start.
  3. **Vercel Hobby & Quick Tunnel:** Vercel Hobby bans commercial school/B2C use (`Pro $20/mo` required); Cloudflare Quick Tunnel (`trycloudflare.com`) is explicitly non-production and rotates URLs on `cloudflared` crash.

### Attack 5: ARM64 / WSL2 & Container Memory Wall (`Options 2, 3, 6`)
- **Target:** `Option 2A (Oracle A1)`, `Option 6 (ONNX OCR in 512 MB–1 GB)`.
- **Empirical Falsification (`Experiment A` + `Experiment B`):**
  - Even after exporting VietOCR + PaddleOCR DBNet/Latin to pure `onnxruntime` CPU (`torch=false`, `paddle=false`, `-571 MB` init RSS), **2048px page inference still spikes to `1,413.50 MB` Peak RSS (`2,033.34 MB` Commit)** — **`viable_512mb=false, viable_1gb=false`**.
  - On `Oracle A1` (`linux_aarch64`), `paddlepaddle==2.6.2` has **no standard PyPI wheel** (`BLOCKED/UNVERIFIED`), and `imgaug==0.4.0` transitively pulled `opencv-python==4.11.0.86` until `@rc-backend-worker` patched `ocr_worker/Dockerfile` with `--no-deps` + uninstall (`verified in WSL2`).

### Attack 6: Child Privacy, `role_cache` Lag & VN PDP Law 91/2025 (`All Options`)
- **Target:** Voice audio, private books, deactivated accounts, cross-border data transit.
- **Findings:**
  1. **`role_cache.py` 60-Second Active==0 Lag (Verified in PG16 Runs!):** Deactivating a parent/admin (`profiles.active = 0`) leaves `/voice/*`, `/support/feedback`, and cached role routes accepting requests for up to **`60s`** (`_ROLE_TTL_SECONDS = 60.0`) unless `invalidate_cached_role` is triggered on deactivation.
  2. **VN PDP Law 91/2025/QH15 & Decree 356/2025/ND-CP (Effective `2026-01-01`):** Requires explicit guardian consent and a **Cross-Border Impact Assessment (CBIA)** dossier for user/child metadata crossing Supabase Mumbai (`ap-south-1`), Vercel Singapore (`sin1`), and Render Oregon (US). Free **Hugging Face Public Spaces** would expose endpoints/logs publicly (`FAIL`), and enabling `allow_google_stt` or cloud LLM child PII would violate local-only privacy guarantees.
  3. **Browser WASM CSP Tension (`Option 5`):** `frontend/next.config.ts` omits `'wasm-unsafe-eval'` and `COOP`/`COEP` headers today — safe now, but Option 5 Browser WASM requires careful CSP scoping without weakening XSS protection.

### Attack 7: Model Quality & Compression Drift (`OCR + Voice + Averages`)
- **Target:** `int8` vs `fp32` vs `hybrid` TTS, Central accents, `low_light` OCR, JPEG `q=85`, adult-only corpus.
- **Findings (Behind the Averages):**
  1. **Isolated Tone Collapse in `int8`:** Default `int8` TTS (`859.99 MB` RSS) scores only **`7/17`** isolated / **`12/17`** carrier on minimal tone pairs (`"mốt"` collapses to `"một"`!). `fp32` improves carrier to **`13/17`** (`1,446.99 MB` RSS), and **`hybrid_int8_word_fp32` (`10/17` isolated) backfires on memory (`1,901.30 MB` RSS — `+454.31 MB` MORE than running pure `fp32`!)**.
  2. **8-Voice TTS Latency vs `<= 2s` SLA:** Longer 8-voice regional sentences hit **`3,645.30 ms` P95 (`int8`)** and **`4,642.37 ms` P95 (`fp32`)** — exceeding the `<= 2,000 ms` target (`G07 FAIL`).
  3. **Central Dialect & Child Speech Gap:** Northern/Southern TTS->STT hits `0.0–0.09` WER, while Central voices (`ngoc_tran`, `quang_son`) hit **`0.4545–0.6364` WER** due to Zipformer North-accent training bias; **real 6–7yo child recordings = `0`** (`UNVERIFIED`).
  4. **OCR Hard Conditions (`low_light` & `childrens_font`):** Micro-CER (`0.0170–0.0206`) hides `low_light` (`IoU@0.50 strict F1 = 0.5769` on PNG) and `childrens_font` (`IoU@0.50 strict F1 = 0.7222`), though JPEG `q=85` actually improved `case_05` (`low_light` `0.0414 -> 0.0059` CER) with zero regression across all 10 cases.

### Attack 8: Queue Starvation & Host Memory Thrashing (`Live Observed Failure!`)
- **Target:** Single `15.83 GiB` Windows host & Render `512 MiB` / `Voice Semaphore`.
- **Empirical Incident Observed During Audit:** When parallel swarm tasks ran Vitest/Next build + ML benchmarks simultaneously on the `15.83 GiB` Windows laptop, system `FreeVirtualMemory` collapsed to **`561 MiB` (`FreePhysicalMemory: 541 MiB`)**, immediately causing **`cv::OutOfMemoryError`** in `test_ocr_engine.py`, **`MemoryError`** in `pydantic` (`test_web_lightweight_startup.py`), and **`30s` subprocess import timeouts**!
  - **Production Lesson:** Never co-run `ocr_worker` (`1,414–1,659 MB`) + `voice_worker` (`860–1,447 MB`) + CPU `Ollama 4B` (`4,371 MiB`) + heavy browser/IDE loads on a single 16 GB laptop without strict concurrency caps (`VIREAD_POST_OCR_CONCURRENCY=1`, `keep_alive="2m"`, `hybrid_word_fp32=false`, closing browser tabs on defense).
- **Voice Semaphore Saturation:** With `tts_semaphore=1` (`~2.9s` P50 multi-word), `~10–12` simultaneous uncached child requests saturate `25s` `QUEUE_WAIT_SECONDS` -> `503` (only mitigated by pre-warming catalog cache / Option 5 precomputed MP3s).

### Attack 9: Rollback Timing, Cache Drift & Backup Reality (`PG16 & Supabase Free`)
- **Measured Positives:** Fresh PG16 `pg_dump` took **`0.67 s`**, `psql` restore took **`15.933 s`** (`60/60` tables, `integrity_match=true`), and active-job drain (`2 -> 0` jobs) + rollback DDL took **`0.100 s`** (`pg16_contention_and_drills.json`).
- **Residual Risks:**
  1. **Supabase Free Has Zero Automated Backups & 7-Day Pause:** Automated `pg_dump` relies on an external cron/Mini-PC script; `pg_dump_bytes: 0` in `pg16_contention_and_drills.json` also revealed a minor telemetry bug (logged exit code instead of file size).
  2. **Catalog `?token=` Egress Illusion in Option 5:** `book_service.py` and `reading_content_service.py` still emit `?token=` signed URLs for public catalog books, so Option 5's `Supa Cached` (`5 GB/mo`) headroom will NOT materialize until catalog URLs switch to deterministic public/B2 CDN paths.
  3. **Production Migration Drift:** Production Supabase (`akjxbkakbbabpblmsktm`) still lacks `ocr_inference_jobs` (`DEPLOYMENT_PROGRESS.md:12`) — deploying RC Render backend before applying `20261124010000_ocr_inference_jobs.sql` will immediately fail `ocr_worker` health and admin/parent OCR enqueues!
