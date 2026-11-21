# Biên bản Nghiệm thu Thiết bị Android Thật — ViRead LAN Acceptance APK

> **Cập nhật lần cuối:** 2026-11-21 (ICT, UTC+7)
> **Trạng thái nghiệm thu thiết bị thật:** **`BLOCKED` — Chưa phát hiện điện thoại Android thật kết nối qua USB/ADB** (`adb devices` trống; `test-device.ps1` trả mã thoát `2`).
> **Nguyên tắc trung thực:** Không dùng trình duyệt Chromium hay giả lập để đánh dấu `PASS` cho hạng mục thiết bị Android thật. Mọi kiểm tra trên trình duyệt di động `390×844` đã được tách riêng vào `docs/android/E2E_REAL_LAN_PROOF.json`.

---

## 1. Định danh bản APK bàn giao

| Thuộc tính | Giá trị đã xác minh |
|---|---|
| Tên tệp trong gói bàn giao | `F:\c1\viread-android-delivery\viread-lan-acceptance-debug.apk` |
| Tệp nguồn build | `F:\c1\capstone1-android-lan\android\app\build\outputs\apk\debug\app-debug.apk` |
| Dung lượng | `31,055 bytes` (~`0.03 MB`) |
| **SHA-256** | `8856b71a72ed0aba088f4e3cd98aecf0e028871e84c989052eacde45d32ee361` |
| Package ID | `vn.viread.android` |
| `versionCode` / `versionName` | `1` / `0.1.0` |
| `minSdk` / `targetSdk` | `24` / `35` |
| Quyền khai báo (`aapt2`) | `INTERNET`, `CAMERA`, `RECORD_AUDIO` |
| Xác minh chữ ký (`apksigner`) | **PASS** — `APK Signature Scheme v2: true`, 1 signer (`CN=Android Debug`, RSA 2048-bit, cert SHA-256 `c84467aae5570090fff63f7da12fd043e56b3e61273408bd9c8134ff69f78656`) |
| Kiểm toán bảo mật APK | **PASS** — 7 zip entries, không chứa private key / keystore / API key / mật khẩu / tài khoản; `cleartextTrafficPermitted="false"`, chỉ nhúng chứng chỉ công khai `res/raw/viread_lan_ca.pem` |
| LAN HTTPS Origin | `https://192.168.1.4:8443` (API nội bộ qua cùng origin: `/_viread_api`) |
| Git base `origin/main` SHA | `aafa3966f75b0d4671eec49ff0b5550668f2d998` |
| Nhánh bàn giao | `feat/android-lan-local-ocr-delivery` (worktree `F:\c1\capstone1-android-lan`) |

---

## 2. Kiểm tra điều kiện tiên quyết trước khi chạy trên điện thoại thật

| Điều kiện | Trạng thái hiện tại | Cách hoàn tất (tối thiểu) |
|---|---|---|
| Máy chủ Windows ViRead (`Start-ViRead.ps1`) | **READY (PASS)** | Chạy `powershell -NoProfile -ExecutionPolicy Bypass -File F:\c1\capstone1-android-lan\scripts\windows\Start-ViRead.ps1 -SkipFrontendBuild` |
| Hồ sơ mạng Wi-Fi Windows (`Manh 2`) | **BLOCKED (đang là `Public`)** | Chuyển Wi-Fi `Manh 2` sang **Private** (Settings → Network & Internet → Wi-Fi → `Manh 2` → Private network) |
| Quy tắc tường lửa TCP `8443` (Private/LocalSubnet) | **BLOCKED (cần quyền Administrator/UAC)** | Mở PowerShell **Run as Administrator**, chạy: `powershell -NoProfile -ExecutionPolicy Bypass -File F:\c1\capstone1-android-lan\scripts\windows\Manage-ViReadFirewallAndAutostart.ps1 -Action AddFirewall` |
| Kết nối điện thoại Android qua USB/ADB | **BLOCKED (`adb devices` trống)** | Bật **USB Debugging** trên điện thoại, cắm cáp USB, bấm **Allow USB debugging**, kết nối cùng Wi-Fi `Manh 2` |

---

## 3. Lệnh kiểm tra tự động qua ADB (sau khi cắm điện thoại)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File F:\c1\capstone1-android-lan\android\scripts\test-device.ps1 `
  -ApkPath "F:\c1\viread-android-delivery\viread-lan-acceptance-debug.apk" `
  -ExpectedLanOrigin "https://192.168.1.4:8443"
```

Kết quả lần chạy gần nhất (`2026-11-21 20:54 ICT`):
- Exit code: **`2`** (`NO AUTHORIZED ANDROID DEVICE DETECTED via ADB`).

---

## 4. Bảng kiểm nghiệm thu thủ công trên điện thoại Android thật

Điền thông tin thiết bị sau khi chạy trên máy thật:
- **Model thiết bị:** `NOT RUN`
- **Phiên bản Android / API:** `NOT RUN`
- **ABI / WebView version:** `NOT RUN`
- **Người thực hiện & thời điểm:** `NOT RUN`

| # | Hạng mục kiểm thử trên điện thoại thật | Trạng thái | Ghi chú / Bằng chứng cần điền |
|---|---|---|---|
| 1 | Cài sạch đúng APK có SHA-256 `8856b71a...e361` (ADB hoặc copy file cài trực tiếp) | **BLOCKED** | Chưa cắm điện thoại |
| 2 | Mở app `ViRead`, tải được `https://192.168.1.4:8443/login` không báo lỗi chứng chỉ TLS, logcat không có `onReceivedSslError`/`ERR_CLEARTEXT` | **BLOCKED** | Chưa cắm điện thoại |
| 3 | Đăng nhập bằng tài khoản nghiệm thu Parent A (xem `F:\c1\viread-host-runtime\acceptance-accounts.json`) | **BLOCKED** | Chưa cắm điện thoại |
| 4 | Chọn hồ sơ trẻ `Bé Minh Nghiệm Thu` → bấm **Quét sách** | **BLOCKED** | Chưa cắm điện thoại |
| 5 | Chụp hoặc chọn ảnh trang sách tiếng Việt → gửi về FastAPI Windows → nhận văn bản OCR tiếng Việt thật | **BLOCKED** | Ghi lại `scan_job_id` & `request_id` trên UI và đối chiếu trong `F:\c1\viread-host-runtime\logs\backend.err.log` |
| 6 | Xác minh `cloud_ocr_used=false` (không dùng cloud OCR) và không có văn bản OCR hay token trong log Windows | **BLOCKED** | Đã chứng minh tự động trên PC/Playwright; cần đối chiếu thêm từ điện thoại thật |
| 7 | Mở trang sách khớp → thực hiện buổi đọc (thử micro/TTS nếu có mạng cho ElevenLabs hoặc Web Speech) → hoàn thành buổi đọc | **BLOCKED** | Chưa cắm điện thoại |
| 8 | Mở lại **Lịch sử đọc (`/sessions`)** và tải lại trang → thấy buổi đọc vừa hoàn thành đã lưu | **BLOCKED** | Chưa cắm điện thoại |
| 9 | Từ chối quyền Camera/Micro → thấy thông báo rõ ràng → cấp lại quyền và thử lại thành công | **BLOCKED** | Chưa cắm điện thoại |
| 10 | Đưa app xuống nền khi đang quét, xoay ngang/dọc màn hình (kiểm tra `configChanges` không hủy giữa chừng), tắt/bật lại Wi-Fi thấy màn hình thử lại thân thiện | **BLOCKED** | Chưa cắm điện thoại |
| 11 | Đóng hẳn app (`force-stop`) rồi mở lại → phiên đăng nhập vẫn còn; bấm nút Back điều hướng hợp lý | **BLOCKED** | Chưa cắm điện thoại |
| 12 | Bấm **Đăng xuất** → phiên được xóa sạch, quay về `/login` | **BLOCKED** | Chưa cắm điện thoại |
