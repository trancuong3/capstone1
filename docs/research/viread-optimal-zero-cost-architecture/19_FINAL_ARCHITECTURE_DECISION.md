# 19. Final Architecture Decision Record (ADR)

> **Decision Date:** `2026-11-25`  
> **RC Branch / Worktree:** `feat/viread-rc-zero-cost-20261125` (`F:\c1\capstone1-rc-zero-cost`, atop `d5eee4dc`)  
> **Governing Constraint:** Maintain **100% feature parity (`F-01`..`F-22`)**, **zero AI/OCR/voice quality regression**, and strict **0 VND** transparency (Cloud Cash vs Owner EVN/Wear vs Paid 24/7 SLA). Never downgrade, remove workers, swap models to inferior substitutes, or hide failures behind weak `CONDITIONAL` labels.

---

## 1. Strict 12-Gate Decision (`0 / 11` Simultaneous Cloud+Laptop-Off Compliance)

As proven empirically in [15_HARD_CONSTRAINT_GATE.md](file:///F:/c1/capstone1-rc-zero-cost/docs/research/viread-optimal-zero-cost-architecture/15_HARD_CONSTRAINT_GATE.md) and [16_DECISION_MATRIX.md](file:///F:/c1/capstone1-rc-zero-cost/docs/research/viread-optimal-zero-cost-architecture/16_DECISION_MATRIX.md):

1. **Physical Container RAM Wall (`G08 FAIL` at `<= 1 GB`):** Even after stripping `torch` and `paddle` (`Exp A`), pure `onnxruntime` CPU 3-engine OCR peaks at **`1,413.50 MB` RSS (`2,033.34 MB` Commit)**. No `256 MB–1 GB` free PaaS container can run ViRead OCR.
2. **Free `>= 2 GB` Cloud Host Blocks (`G04 BLOCKED` / `FAIL`):** `ClawCloud Run` permanently terminated `2026-06-30`; `Oracle A1` (`2/12 GB`) is `BLOCKED` by VN physical international card checks, `ap-singapore-1` `Out of host capacity`, `7d` idle reclaim, and missing PyPI `linux_aarch64` `paddlepaddle==2.6.2` wheels.
3. **Economic & Legal Mutual Exclusion (`G01/G04` vs `G02/G03/G11`):**
   - `0 VND` Cloud Cash (`G01`/`G04 PASS`) forces heavy OCR (`1.41–1.66 GB`), Voice (`860 MB`), and Ollama (`4.37 GB`) onto owned hardware (`Option 1-Hardened` laptop or `Option 7` Linux Mini-PC), incurring unavoidable VN **EVN electricity (`G02 FAIL`: `~12k–335k+ VND/mo` laptop or `~22k–120k VND/mo` Mini-PC)**.
   - Eliminating personal hardware & commercial ToS risk (`G02/G03/G11 PASS`) requires card-backed cloud spend (**`Option 8`**, `~$51.50–$60/mo`).
4. **Unverified Child Audio & Device E2E (`G07/G12`):** Real 6–7yo child speech remains **`UNVERIFIED` (`0` clips)**; 8-voice `int8` regional TTS `P95 = 3,645.30 ms` exceeds `<= 2,000 ms`; `Honor X9d` live RC E2E remains **`BLOCKED`** pending preview/prod deployment approval.

**Therefore, NO candidate passes all 12 Hard Gates for unattended 24/7 `0 VND` commercial production (`NO-GO` on that claim).**

---

## 2. Selected Architectures by Explicit Deployment Intent

| Target Deployment Window | Selected Architecture | Cloud Cash / mo | Owner EVN + Domain / mo | Laptop-Off `24/7` Status | Rationale & Trade-Offs |
|---|---|---:|---:|---|---|
| **1. Immediate Capstone Defense (`0 VND` Cloud, Owner Present)** | **Option 1-Hardened (`feat/viread-rc-zero-cost-20261125` RC)** | **`0 VND`** *(clears `Owner_Only` – `10_DAU Typical` & `Defense_Day Peak`)* | `~2k–341k VND` EVN *(depending on duty hours)* + `0` Student domain Y1 / `25k` post-Y1 | **No** *(Web/DB/Auth/Catalog/Reading UI stay up; Voice returns `503` cleanly in `5s`; OCR jobs queue until worker starts)* | Fully built, hardened, and tested in RC: lightweight `277.6 MB` Render API, Proxyless signed URLs, MP3 TTS (`11.74x`), VAD STT (`-65%`), JPEG `q=85` (`CER 0.0170`), `429`/`12 MB`/`Active==1`/CSP security headers, decoupled workers, cardless `*/30` Cloudflare Cron (`90s` timeout), and `admin_ocr_service.py:2851` `ON CONFLICT` Postgres fix (`5/5` PG16 integration). |
| **2. True `24/7` `0 VND` Cloud (Laptop-Off, Academic/Home)** | **Option 7 (Owned Linux Mini-PC `x86_64` Docker)** running the same RC + **Option 6 ONNX OCR** | **`0 VND`** *(academic non-commercial)* | `~22k–120k VND` EVN (`15–40W`) + mini-UPS (`350–500k` capex) + domain (`~25k`) | **Yes (`100%` of features when Mini-PC + Named Tunnel stay online)** | Eliminates laptop battery wear and laptop-off downtime. WSL2 Linux `x86_64` `ocr_worker` verified at `1,259–1,438 MB` RSS (`5/5` tests); adding Option 6 ONNX saves `-49.8%` OCR latency & `-1.06 GB` commit. *(Physical Mini-PC 10-worker compose remains `DOCUMENTED BUT NOT TESTED`.)* |
| **3. Post-Defense Egress Scaling (`50_DAU` at `0 VND` Cloud)** | **Option 5 Extension (`Browser WASM sherpa-onnx STT + Precomputed Catalog MP3`)** | **`0 VND`** *(w/ B2 `10 GB` free for static catalog)* | `~7k–180k VND` EVN (`-40%` duty) | **Partial** *(Catalog reading + client WASM STT stay `24/7`; private-book dynamic TTS & scan OCR still need worker)* | Cuts `50_DAU Typical` Render egress **`37.8x`** (`39.74 -> 1.05 GB/mo`) and moves static audio/images off `Supa Uncached`; child STT audio stays `100%` local in browser (`UNVERIFIED` / `DOCUMENTED BUT NOT TESTED` in RC). |
| **4. Commercial / Multi-School Production (`24/7` SLA & Legal ToS)** | **Option 8 (`Hetzner SG CX23/CX33` + Vercel Pro + Supabase Pro)** | **`~1.31–1.52M VND/mo`** (`$51.50–$60/mo`) | `0 VND` home EVN | **Yes (`100%` SLA)** | Resolves Vercel Hobby non-commercial restriction, adds Supabase Automated Backups + Leaked Password Protection + `250 GB` Cached Egress, and consolidates API + OCR + Voice + Ollama on one `ap-south/sin` datacenter node. |

---

## 3. Post-Red-Team Reconciliations Applied Directly on RC (`Before Final Commit`)

All 4 concrete items raised in `@independent-red-team` (`#38`) and PG16 integration verification are resolved cleanly on `feat/viread-rc-zero-cost-20261125`:
1. **`backend/app/services/admin_ocr_service.py:2851`:** Added `WHERE event_type = 'VERIFIED_REVISION'` to `ON CONFLICT (event_type, revision_id)` so Admin revision verify succeeds atomically against `uq_viread_ocr_outbox_verified_revision` created in migration `20261122120000`.
2. **`backend/test_admin_ocr_postgres_integration.py`:** Fixed `APP_ENVIRONMENT=test` default and `_seed_public_revision_reference` stub insert (`revisionno, verificationstatus, contenthash`), lifting live migrated PG16 integration from **`4/5` -> `5/5 PASSED`** (`32.71s`).
3. **`infra/cloudflare-cron/wrangler.toml` & `src/index.js`:** Adjusted schedule from `*/5 * * * *` -> **`*/30 * * * *`** (allowing Render Free `15m` idle sleep between ticks under the `750h/mo` workspace cap) and timeout `25,000 ms` -> **`90,000 ms`** to survive Render `50–60s` cold starts.
4. **`backend/app/database/role_cache.py`:** Reduced default `_ROLE_TTL_SECONDS` from `60.0s` -> **`10.0s`** (`VIREAD_ROLE_CACHE_TTL_SECONDS` env-overridable) alongside immediate `invalidate_cached_role()` in `AdminParentRepository.soft_delete_parent()`.
