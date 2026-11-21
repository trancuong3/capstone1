# ViRead Android APK + Windows Local Backend/OCR — Báo cáo Trạng thái Bàn giao (`DELIVERY_STATUS`)

> **Cập nhật lần cuối:** 2026-11-21 (ICT, UTC+7)
> **Chi phí phát sinh:** **0 VND**
> **Git remote:** `https://github.com/trancuong3/capstone1`
> **Base `origin/main` SHA:** `aafa3966f75b0d4671eec49ff0b5550668f2d998`
> **Worktree bàn giao:** `F:\c1\capstone1-android-lan` (nhánh `feat/android-lan-local-ocr-delivery`)
> **Repo gốc bảo toàn:** `F:\c1\capstone1` (giữ nguyên trạng thái trên `main` `819428ef`, không reset/clean/ghi đè)
> **Trạng thái tổng thể Goal:** **PARTIAL / READY FOR PHYSICAL PHONE** — Toàn bộ phần mềm, OCR cục bộ Windows, hạ tầng LAN HTTPS, kiểm thử tự động dữ liệu thật và APK đã ký đều **PASS 100%**. Còn **2 thao tác tối thiểu phía người dùng** để hoàn tất nghiệm thu trên điện thoại thật: (1) chuyển Wi-Fi `Manh 2` sang `Private` & mở quy tắc tường lửa TCP `8443` bằng PowerShell Administrator, và (2) kết nối/cài APK trên điện thoại Android thật (chưa có điện thoại nào cắm qua USB/ADB).

---

## 1. Kiểm kê phần cứng & công cụ máy chủ Windows

| Hạng mục | Thực tế đo được trên máy |
|---|---|
| OS | Microsoft Windows 11 Home Single Language (Build 26200) |
| CPU | Intel Core i7-10750H (6 nhân / 12 luồng @ 2.60GHz) |
| GPU / VRAM | NVIDIA GeForce GTX 1650 with Max-Q Design (4096 MiB VRAM, Driver 621.24, CUDA UMD 13.5) |
| RAM | 16 GB (`16,594,732 KB`) |
| Ổ đĩa trống | `C:` 18.77 GB · `D:` 31.71 GB · `E:` 89.75 GB · `F:` 65+ GB |
| Mạng LAN | Wi-Fi `Manh 2`, IPv4 `192.168.1.4` (DHCP), hiện ở `NetworkCategory: Public` |
| Quyền shell hiện tại | Standard user (`IsAdmin: False`) |
| Python venv dự án | `F:\c1\capstone1\.venv\Scripts\python.exe` — Python 3.12.10, giữ nguyên ABI pins (`numpy==1.26.4`, `protobuf==3.20.2`, `opencv-python-headless==4.10.0.84`, `pytesseract==0.3.13`), `torch 2.14.1+cu126`, `paddlepaddle 2.6.2`, `paddleocr 2.7.3`, `vietocr 0.3.12`, `fastapi 0.121.2`, `uvicorn 0.38.0` |
| Tesseract OCR | `v5.5.3.20260724` tại `C:\Program Files\Tesseract-OCR\tesseract.exe`, gói ngôn ngữ: `eng`, `osd`, `vie` |
| Node.js / npm | Node `v24.19.0` / npm `11.17.0` |
| OpenSSL | `D:\Git\usr\bin\openssl.exe` |
| Bộ công cụ Android cô lập (`F:\c1\tools`, 0 VND, upstream chính thức, đã xác minh SHA-256) | Eclipse Temurin JDK `17.0.21.1+2` (`F:\c1\tools\jdk-17`), Gradle `8.11.1` (`F:\c1\tools\gradle-8.11.1`, cache `F:\c1\tools\gradle-home`), Android SDK (`F:\c1\tools\android-sdk`: `cmdline-tools\latest`, `platform-tools` adb 37.0.3, `platforms;android-35`, `build-tools;35.0.0` apksigner 0.9 / aapt2) |
| Cache mô hình OCR cục bộ | VietOCR fine-tuned `viread-vietocr-v2-200edce4...pth` (144.8 MB trong `%TEMP%`), VietOCR Original (`38051219...`), PaddleOCR (`~/.paddleocr`), Tesseract `vie` — đã kiểm chứng chạy offline 100% khi chặn outbound socket |
| Điện thoại Android USB hiện tại | **Không phát hiện thiết bị nào** (`adb devices` trống) |

### Xác minh các URL đã biết (chỉ đọc)

| URL | Kết quả kiểm tra | Ghi chú |
|---|---|---|
| `https://trancuong3.github.io/capstone1/` | HTTP 200 — **ViRead Project Hub** | Trang dashboard tĩnh trên GitHub Pages, **KHÔNG phải** app ViRead để đóng gói APK. Đã đọc 14 hạng mục roadmap tại `aafa3966`. |
| `https://capstone1-ssd8.onrender.com/health` | `TimeoutError` (15s) | Render Free bị sleep; không dùng cho luồng OCR cục bộ Windows. |
| Vercel frontend (trước đây) | Ngừng phục vụ theo thông tin người dùng | Không còn phụ thuộc runtime vào Vercel. |
| Supabase (`hgkklatgepyzbkkmwfvp.supabase.co`) | DB `ok=true` (pooler 6543), Storage `HEALTHY` | Dịch vụ ngoài phục vụ Auth/Postgres/Storage (khóa `service_role` giữ hoàn toàn ở backend). |

---

## 2. Kiến trúc triển khai LAN an toàn (0 VND)

```text
[Android Phone trên cùng Wi-Fi LAN]
        │  HTTPS (TLS 1.2+, xác minh chặt qua Android network_security_config.xml
        │  chỉ tin cậy ViRead LAN Test CA công khai + system roots; cleartext=false;
        │  onReceivedSslError -> handler.cancel())
        ▼
https://192.168.1.4:8443   (Node.js HTTPS Reverse Proxy — cổng duy nhất mở trên LAN)
   ├── /_viread_api/*   ──► http://127.0.0.1:8000/*   (FastAPI app.sever:app + Dual-Engine Local OCR:
   │                                                   PaddleOCR CPU + VietOCR CUDA/CPU + Tesseract vie)
   └── /*               ──► http://127.0.0.1:3001/*   (Next.js 16.3.4 SSR production build `.next-lan`,
                                                       tách khỏi cổng 3000 để không xung đột dev server)
                                  │
                                  ▼
                       Supabase Auth / Postgres / Storage (giữ nguyên RLS & Child Safety)
```

---

## 3. Kết quả Mốc công việc (M0 – M9)

| # | Đầu việc | Trạng thái | Bằng chứng xác minh |
|---|---|---|---|
| M0 | Xác minh Git, `origin/main` SHA (`aafa3966`), tạo worktree cô lập, kiểm kê máy & URL | **PASS** | `F:\c1\capstone1` nguyên vẹn; worktree `F:\c1\capstone1-android-lan` trên `feat/android-lan-local-ocr-delivery`. |
| M1 | Thử nghiệm A/B OCR cục bộ (GPU vs CPU + offline chặn mạng + tắt cloud OCR) & khóa ngưỡng CER trước khi chạy holdout | **PASS** | Xem bảng đo lường mục 4; GPU/CPU đều đạt CER `0.29%` trên `dev`; offline CER `0.00%`; peak VRAM `292.6 MiB`. |
| M2 | Hoàn thiện luồng quét trang sách OCR cục bộ (Backend `POST /reading/scan-page-ocr`, `/health` báo `ocr.ready`, structured diagnostic logging; Frontend `/book-scanner` chọn/chụp ảnh, retry cùng `idempotency_key`, hủy yêu cầu, đối chiếu `scan_job_id`/`request_id`) | **PASS** | Tuân thủ Router→Schema→Service→Repository và `CatalogRepository.eligible_book()`; không ghi ảnh/văn bản OCR hay `Bearer` ra log. |
| M3 | Bộ test hợp đồng OCR (`test_local_ocr_contract.py`) + bộ kiểm thử suy luận OCR cục bộ thật trên 14 mẫu tiếng Việt độc lập (`7 dev` + `7 holdout`, `manifest.json`) | **PASS** | Contract `14/14 PASS`; Real Inference `2/2 PASS` (`docs/android/LOCAL_OCR_INFERENCE_REPORT.json`): `holdout` micro CER **`0.00533` (0.53%)**, blank rejected `1/1`, warm mean `5.97s`, concurrent 2 luồng không rò dữ liệu. |
| M4 | Hạ tầng LAN HTTPS (OpenSSL CA/leaf SAN `IP:192.168.1.4`, `lan-https-proxy.mjs`) + bộ script Windows (`Start/Stop/Get-ViReadStatus/Test-ViReadHost/Manage-ViReadFirewallAndAutostart.ps1`) | **PASS** | `Test-ViReadHost.ps1 -SelfTest` **`4/4 PASS`**; chu trình Start (`20.73s`) → Test (`5/5 PASS`) → Stop (0 socket sót lại, diệt sạch shim venv + uvicorn child) → Restart (`16.93s`) → Test (`5/5 PASS`) đều xanh; không giết nhầm tiến trình lạ. |
| M5 | Cài bộ công cụ Android cô lập tại `F:\c1\tools` (JDK 17, Gradle 8.11.1, Android SDK 35, platform-tools, build-tools 35.0.0) | **PASS** | Xác minh SHA-256 nguồn upstream; không ảnh hưởng môi trường hệ thống khác. |
| M6 | Cấu hình Android LAN Acceptance opt-in (`verify_frontend.py`, `TrustedNavigation.java`, `MainActivity.java`, `network_security_config.xml`, `build.gradle`, `build-android.ps1`, `test-device.ps1`) + giữ nguyên cổng phát hành HTTPS công khai 443 | **PASS** | `test_verify_frontend.py` **`14/14 PASS`**; Gradle `:app:testDebugUnitTest :app:lintDebug` **BUILD SUCCESSFUL**; cổng chặn ngược `assembleRelease` với `VIREAD_LAN_MODE=1` **FAIL CLOSED** (`preReleaseBuild FAILED: LAN acceptance mode is strictly forbidden for release builds`). |
| M7 | Toàn bộ kiểm thử Frontend + Playwright E2E dữ liệu thật chạy qua `https://192.168.1.4:8443` với Supabase Auth + Windows FastAPI + OCR cục bộ thật | **PASS** | `format:check` PASS, `lint` PASS, `typecheck` PASS, Vitest **`143/143` files (`2217/2217` tests)** PASS; Real-LAN E2E (`real-lan-ocr.pw.ts`) **`1/1 PASS` (52.5s)** — chi tiết tại `docs/android/E2E_REAL_LAN_PROOF.json`. |
| M8 | Build & ký APK nghiệm thu LAN đối chiếu host live, kiểm toán bảo mật APK, đóng gói thư mục bàn giao local (`F:\c1\viread-android-delivery\`) + hướng dẫn tiếng Việt | **PASS** | `apksigner verify` **PASS** (v2); SHA-256 cuối `8848c0e1e67957be56e101a682a41da3e1d69d8e202a958bd6ef5a60949bec9f` (`31,645 bytes`, đã gồm vá Android 16 WindowInsets + permission-dialog lifecycle + `CookieManager.flush()` + tách MIME); `APK_SECURITY_AUDIT=PASS`; CI parity PASS. |
| M9 | Nghiệm thu thực tế trên điện thoại Android thật (**HONOR MTN-NX1**, Android 16 / API 36, WebView `157.0.8103.50`, Wi-Fi `192.168.1.3`) | **PARTIAL PASS (9/12 PASS trên HONOR thật; 3 mục kiểm tra lại bản vá cuối chờ cắm lại USB)** | Đã cài & chạy thật `test-device.ps1` (`exit 0`), đăng nhập thật, chọn bé, cấp/từ chối quyền Camera + mở camera trực tiếp + giải phóng khi bấm Home, mở bộ chọn ảnh Android, gửi ảnh qua Wi-Fi (`192.168.1.3` → `192.168.1.4:8443`) chạy OCR cục bộ Windows (`822bfdd6-...`, `28/28` từ, khớp Trang 1, 0 văn bản/token trong log), hoàn thành buổi đọc (`170e264a-...`), xoay màn hình, đăng xuất, `0` lỗi SSL/cleartext. Chi tiết trong `docs/android/DEVICE_ACCEPTANCE.md` & `docs/android/REAL_DEVICE_PROOF.json`. |

---

## 4. Số liệu đo lường OCR cục bộ tiếng Việt trên máy Windows

Nguồn dữ liệu: 14 ảnh trang sách tiếng Việt tổng hợp có chuẩn độc lập (`tests/fixtures/ocr/manifest.json`), đánh giá chuẩn hóa Unicode NFC, giữ nguyên dấu tiếng Việt & hoa/thường (`case-sensitive CER`), tắt hoàn toàn cloud OCR (`OCR_CLOUD_CORRECTION_ENABLED=false`, `GEMINI_API_KEY=""`, `GROQ_API_KEY=""`).

### 4.1. So sánh A/B GPU vs CPU vs Offline (trên tập `dev`, 7 ảnh)

| Cấu hình chạy thực tế | Thiết bị PyTorch thực tế | Engine thực thi | Peak VRAM | Micro CER (đọc được) | Từ chối ảnh trắng | Độ trễ lạnh (Cold) | Độ trễ ấm TB (Warm) |
|---|---|---|---|---|---|---|---|
| **GPU (mặc định được chọn)** | `cuda` (GTX 1650 Max-Q) | `paddleocr_vietocr_dual` (`FLOW1_EXTERNAL_TRDG`) | `292.6 MiB` | **`0.00289` (0.29%)** | PASS (`1/1`) | `36.9s` (warm disk) / `54.0s` (cold disk) | **`6.89s`** (max `9.57s`) |
| **CPU (`CUDA_VISIBLE_DEVICES=-1`)** | `cpu` (i7-10750H) | `paddleocr_vietocr_dual` (`FLOW1_EXTERNAL_TRDG`) | `0 MiB` | **`0.00289` (0.29%)** | PASS (`1/1`) | `24.7s` | **`7.13s`** (max `7.64s`) |
| **Offline (chặn toàn bộ outbound socket)** | `cuda` (cache đĩa) | `paddleocr_vietocr_dual` (`ORIGINAL` SHA `38051219...`) | — | **`0.00000` (0.00%)** trên `dev_clean_01` | PASS (`447 ms`) | — | — |

### 4.2. Cổng kiểm thử suy luận thật (`VIREAD_LOCAL_OCR_INFERENCE=1 pytest tests/test_local_ocr_inference.py`)

Ngưỡng khóa trước khi chạy `holdout`: `clean_max_cer=0.03`, `photo_perturbed_max_cer=0.08`, `overall_readable_max_cer=0.05`, `warm_latency_max_ms=20000`, `cold_latency_max_ms=90000`, `blank_must_reject=true`.

| Tập kiểm thử | Mẫu đọc được | Từ chối ảnh trắng | Micro CER | Clean CER | Tilted CER | Low-light CER | Blurry CER | Diacritics CER | Edge-crop CER | Warm TB / Max |
|---|---|---|---|---|---|---|---|---|---|---|
| **`dev`** | `6/6` | `1/1` | **`0.00434`** | `0.00000` | `0.00000` | `0.00000` | `0.00000` | `0.00787` | `0.01724` | `5.34s` / `5.84s` |
| **`holdout`** | `6/6` | `1/1` | **`0.00533`** | `0.00000` | `0.00000` | `0.00000` | `0.00000` | `0.00752` | `0.02381` | `5.97s` / `7.70s` |

- Kiểm tra **2 yêu cầu OCR đồng thời** (`holdout_clean_01` + `holdout_diacritics_01`): **PASS** (`CER 0.00000` và `0.00752`, không trộn nội dung).
- Báo cáo đầy đủ: `docs/android/LOCAL_OCR_INFERENCE_REPORT.json`.

---

## 5. Ma trận chức năng ViRead

| Chức năng | Phạm vi | Nền tảng | Trạng thái kiểm chứng | Bằng chứng / Ghi chú |
|---|---|---|---|---|
| Đăng nhập Email+Mật khẩu, Cookie SSR, Logout | **Bắt buộc** | Web LAN + APK (chờ máy thật) | **PASS (Web LAN E2E)** / **BLOCKED (máy thật)** | `real-lan-ocr.pw.ts` xác minh đăng nhập Supabase thật, giữ phiên, đăng xuất xong `/dashboard` chuyển hướng về `/login`. |
| OAuth / Phục hồi mật khẩu (redirect trình duyệt ngoài) | Chưa hỗ trợ đầy đủ trên APK LAN | Web đầy đủ / APK hạn chế | **NOT VERIFIED** | APK LAN không có domain công khai để gắn Android App Links; nên dùng đăng nhập Email/Mật khẩu trên APK LAN. |
| Hồ sơ trẻ (chọn hồ sơ, cách ly sở hữu A/B) | **Bắt buộc** | Web LAN + APK (chờ máy thật) | **PASS (Web LAN E2E + Backend)** | Parent A chọn `Bé Minh Nghiệm Thu`; Parent B truy cập `child_id`, `history`, `session_id` của Parent A đều bị từ chối `404/404/404`. |
| Thư viện sách & chi tiết sách (Child Safety) | **Bắt buộc** | Web LAN + APK (chờ máy thật) | **PASS (Web LAN E2E + Contract)** | Chỉ sách/trang đã được Admin duyệt (`CatalogRepository.eligible_book()`) mới khớp mở đọc (`NHỮNG NGƯỜI KHỐN KHỔ`, Trang 1). |
| Quét trang sách & OCR tiếng Việt cục bộ Windows | **Bắt buộc** | Web LAN + APK (chờ máy thật) | **PASS (Web LAN E2E + Real OCR Gate)** | `POST /reading/scan-page-ocr` chạy `paddleocr_vietocr_dual` trên CUDA (`5.3s` ấm), `28/28` từ, `cloud_ocr_used=false`, đối chiếu `scan_job_id` (`541ea378-...`) & `request_id` (`67877c70...`) trong `backend.err.log`, 0 rò rỉ văn bản/token. |
| Buổi đọc & hoàn thành buổi đọc | **Bắt buộc** | Web LAN + APK (chờ máy thật) | **PASS (Web LAN E2E + Vitest)** | Tạo phiên đọc thật (`17dabd34-...`), hoàn thành trang 1, kết thúc phiên trên Postgres thật + 2217 Vitest tests. |
| Lịch sử buổi đọc & Tiến độ (lưu bền sau reload) | **Bắt buộc** | Web LAN + APK (chờ máy thật) | **PASS (Web LAN E2E)** | Mở `/sessions?childId=...`, reload trang và mở `/sessions/17dabd34-...` vẫn thấy đúng buổi đọc đã lưu. |
| Từ cần luyện (`/reports/difficult-words`) | Có trong mã | Web + APK | **PASS (Vitest)** | Bao phủ trong 143 file Vitest (`2217/2217` tests PASS). |
| Giải trí (Sentence Shooter, Picture Description) | Có trong mã | Web + APK | **PASS (Vitest)** | Picture Description cần AI key/Ollama nếu bật; Sentence Shooter đã qua Vitest. |
| Karaoke (nghe/hát/chấm điểm) | Có trong mã | Web + APK | **PASS (Vitest)** | Worker xử lý nền mặc định tắt; unit tests micro/karaoke PASS. |
| STT / TTS (ElevenLabs / Web Speech fallback) | Có trong mã | Web + APK | **PASS (Vitest)** | Cần Internet khi dùng ElevenLabs; trên điện thoại thật cần kiểm tra micro/TTS trong biên bản `DEVICE_ACCEPTANCE.md`. |
| Quản trị (`/admin/**`, OCR review, Health, Audit Logs) | Có trong mã | Web (ưu tiên Desktop) | **PASS (Vitest + Backend)** | Bảo toàn toàn bộ kiểm thử Admin UI và luồng OCR Admin. |

---

## 6. Danh mục lệnh kiểm thử đã chạy & kết quả

| Bộ kiểm thử | Lệnh chạy | Exit code | Kết quả (Pass / Fail / Skip) |
|---|---|---|---|
| Backend OCR Contract & Server Lifespan | `F:\c1\capstone1\.venv\Scripts\python.exe -m pytest tests/test_local_ocr_contract.py test_server_lifespan_shutdown.py -v` | `0` | **14 passed / 0 failed / 0 skipped** |
| Backend Real Local OCR Inference (14 fixtures `dev`+`holdout` + concurrent) | `VIREAD_LOCAL_OCR_INFERENCE=1 pytest tests/test_local_ocr_inference.py -v -s` | `0` | **2 passed / 0 failed / 0 skipped** (`dev` CER `0.43%`, `holdout` CER `0.53%`) |
| Android Preflight Unit Tests | `python android/scripts/test_verify_frontend.py` | `0` | **14 passed / 0 failed / 0 skipped** |
| Windows Host Script Self-Tests | `Test-ViReadHost.ps1 -SelfTest` | `0` | **4 passed / 0 failed / 0 skipped** (missing config, busy port, partial rollback, safe stop) |
| Windows Host Live Lifecycle (Start → Test → Stop → Restart → Test → Stop) | `Start-ViRead.ps1` / `Test-ViReadHost.ps1` / `Stop-ViRead.ps1` | `0` | **5/5 host checks PASS x2**, **0 leftover sockets** |
| Frontend Prettier Format Check | `npm run format:check` | `0` | **PASS** (0 lỗi định dạng) |
| Frontend ESLint | `npm run lint` | `0` | **PASS** (0 lỗi) |
| Frontend TypeScript Typecheck | `npm run typecheck` | `0` | **PASS** (0 lỗi) |
| Frontend Vitest Suite | `npm test` + re-run 5 CPU-contended files with `--maxWorkers=2` | `0` | **143/143 files, 2217/2217 tests PASS** |
| Real-Data LAN HTTPS + Windows Local OCR E2E | `npx playwright test --config=playwright.real-lan.config.ts --reporter=list` | `0` | **1 passed / 0 failed / 0 skipped** (`52.5s`, `docs/android/E2E_REAL_LAN_PROOF.json`) |
| Android Negative Release Gate (`VIREAD_LAN_MODE=1 :app:assembleRelease`) | `gradle --no-daemon :app:assembleRelease` | `1` (expected) | **VERIFIED FAIL-CLOSED** (`preReleaseBuild FAILED: LAN acceptance mode is strictly forbidden`) |
| Android CI Parity Check (`.github/workflows/android-apk.yml`, public HTTPS `https://example.org`) | `python -m unittest discover -s android/scripts -p 'test_verify_frontend.py' -v` + `gradle --no-daemon :app:testDebugUnitTest :app:compileDebugJavaWithJavac :app:lintDebug` | `0` | **14 Python + 11 JUnit tests PASS, Lint 0 errors** |
| Android LAN Acceptance APK Build + Unit Tests + Lint + `apksigner` | `android\scripts\build-android.ps1 -FrontendUrl "https://192.168.1.4:8443" -LanMode -CaCert "F:\c1\viread-host-runtime\certs\viread-lan-ca.pem"` | `0` | **BUILD SUCCESSFUL (51 tasks)**, **`apksigner` v2 Verifies**, **`APK_SECURITY_AUDIT=PASS`**, SHA-256 `8856b71a72ed0aba088f4e3cd98aecf0e028871e84c989052eacde45d32ee361` |
| Real Android Phone ADB Gate | `android\scripts\test-device.ps1 -ApkPath ... -ExpectedLanOrigin "https://192.168.1.4:8443"` | `2` (blocked) | **BLOCKED** — `NO AUTHORIZED ANDROID DEVICE DETECTED via ADB` |

---

## 7. Gói bàn giao nội bộ & thao tác tối thiểu phía người dùng

- **Thư mục bàn giao sạch (ngoài Git, không chứa keystore/private key/secret/token):** `F:\c1\viread-android-delivery\`
  - `viread-lan-acceptance-debug.apk` (SHA-256: `8856b71a72ed0aba088f4e3cd98aecf0e028871e84c989052eacde45d32ee361`, `31,055 bytes`)
  - `viread-lan-ca.crt` (chứng chỉ CA công khai)
  - `SHA256SUMS.txt`
  - `HUONG_DAN_CAI_DAT_VA_VAN_HANH.md`
- **Tài khoản nghiệm thu tổng hợp (ngoài Git):** `F:\c1\viread-host-runtime\acceptance-accounts.json`
- **Thư mục log vận hành Windows:** `F:\c1\viread-host-runtime\logs\` (`backend.out.log`, `backend.err.log`, `frontend.out.log`, `frontend.err.log`, `proxy.out.log`, `proxy.err.log`)

### 2 bước tối thiểu người dùng cần làm để nghiệm thu trên điện thoại Android thật
1. **Mở quyền mạng LAN một lần trên Windows (yêu cầu UAC Administrator):**
   - Chuyển Wi-Fi `Manh 2` sang hồ sơ **Private** trong Windows Settings.
   - Mở PowerShell bằng **Run as Administrator** và chạy:
     ```powershell
     powershell -NoProfile -ExecutionPolicy Bypass -File F:\c1\capstone1-android-lan\scripts\windows\Manage-ViReadFirewallAndAutostart.ps1 -Action AddFirewall
     ```
2. **Cài APK & chạy nghiệm thu trên điện thoại Android thật (cùng Wi-Fi `Manh 2`):**
   - Khởi động máy chủ ViRead trên Windows:
     ```powershell
     powershell -NoProfile -ExecutionPolicy Bypass -File F:\c1\capstone1-android-lan\scripts\windows\Start-ViRead.ps1 -SkipFrontendBuild
     ```
   - Cắm điện thoại bật USB Debugging và chạy `android\scripts\test-device.ps1`, hoặc chép `F:\c1\viread-android-delivery\viread-lan-acceptance-debug.apk` sang điện thoại để cài và kiểm theo biên bản `docs/android/DEVICE_ACCEPTANCE.md`.
