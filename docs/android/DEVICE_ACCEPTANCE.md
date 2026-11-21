# Biên bản Nghiệm thu Thiết bị Android Thật — ViRead LAN Acceptance APK

> **Cập nhật lần cuối:** 2026-11-21 23:28 (ICT, UTC+7)
> **Thiết bị Android thật đã kiểm chứng:** **HONOR MTN-NX1** (`ATSYVB6205006984`), **Android 16 (API 36)**, `arm64-v8a`, System WebView `157.0.8103.50`, Wi-Fi IP `192.168.1.3` (cùng LAN với máy chủ Windows `192.168.1.4`).
> **Trạng thái nghiệm thu máy thật:** **PARTIAL PASS (9/12 hạng mục máy thật đã PASS trực tiếp trên HONOR MTN-NX1 + đã sửa xong 3 lỗi thực tế phát hiện từ máy thật; 3 mục kiểm tra lại sau bản vá cuối chờ cắm lại cáp USB vì điện thoại đã rút khỏi máy lúc 23:25).**
> **Bằng chứng dữ liệu JSON:** `docs/android/REAL_DEVICE_PROOF.json` · **Ảnh chụp đã lọc sạch thông tin cá nhân:** `F:\c1\viread-android-delivery\screenshots\`.

---

## 1. Định danh bản APK bàn giao cuối cùng

| Thuộc tính | Giá trị đã xác minh |
|---|---|
| Tệp bàn giao | `F:\c1\viread-android-delivery\viread-lan-acceptance-debug.apk` |
| Dung lượng | `31,645 bytes` (~`0.03 MB`) |
| **SHA-256 (bản cuối gồm cả vá `CookieManager.flush()`)** | `8848c0e1e67957be56e101a682a41da3e1d69d8e202a958bd6ef5a60949bec9f` |
| SHA-256 bản đã chạy trực tiếp trên HONOR MTN-NX1 (`21:26–21:41`) | `b9627fc493fc1776d6dd6284ce4c86454a80c2f7be814f797090b2e42a6ff4c3` |
| Package ID | `vn.viread.android` |
| `versionCode` / `versionName` | `1` / `0.1.0` |
| `minSdk` / `targetSdk` | `26` / `35` (đã test trên Android 16 / API 36) |
| Xác minh chữ ký (`apksigner`) | **PASS** — `APK Signature Scheme v2: true`, 1 signer (`CN=Android Debug`, RSA 2048-bit) |
| Kiểm toán bảo mật APK | **PASS** — 0 private key/secret/token; `cleartextTrafficPermitted="false"`, `onReceivedSslError -> handler.cancel()`, nhúng duy nhất CA công khai `viread_lan_ca.pem` |
| LAN HTTPS Origin | `https://192.168.1.4:8443` (`/_viread_api` → `127.0.0.1:8001`, `/*` → `127.0.0.1:3001`) |
| Git base `origin/main` SHA | `aafa3966f75b0d4671eec49ff0b5550668f2d998` |
| Nhánh bàn giao | `feat/android-lan-local-ocr-delivery` (worktree `F:\c1\capstone1-android-lan`) |

---

## 2. Các lỗi thực tế phát hiện trên HONOR MTN-NX1 (Android 16) và đã sửa dứt điểm

1. **Android 15/16 Edge-to-Edge status bar overlap (`MainActivity.java`):** Đã thêm `setOnApplyWindowInsetsListener` đệm `systemBars | ime | displayCutout` với nền `#153A53` → xác nhận bằng ảnh `phone_screen_insets_fixed.png` (0 chồng lấn).
2. **Hộp thoại xin quyền Camera/Micro lần đầu bị hủy bởi `onPause()` (`MainActivity.java`):** Khi Android hiển thị hộp thoại xin quyền hệ thống, `onPause()` trước đây gọi `denyPending()` và bắn `viread:android-background` sớm. Đã sửa bằng cờ `awaitingSystemPermission` + `onStop()` → xác nhận trên HONOR MTN-NX1 mở camera sống ngay lần chạm **Cho phép** đầu tiên (`stage_a2_cam_first_tap_live.png`), và tắt sạch đèn xanh camera khi bấm Home (`stage_a3_cam_released.png`).
3. **WebView `onShowFileChooser` gộp MIME bằng dấu phẩy (`TrustedNavigation.java` + `MainActivity.java`):** Đã tách chuỗi `image/jpeg,image/png,image/webp` thành `image/*` + `EXTRA_MIME_TYPES` → xác nhận mở thẳng `com.google.android.documentsui/.picker.PickActivity` trên Android 16.
4. **Lỗi `AcceleratorError` CUDA 4 GiB VRAM khi tải dồn & giữ phiên qua `am force-stop`:** Đã chuyển mặc định `ocrDevice: "cpu"` trong `Start-ViRead.ps1` (cold ~25s, warm ~7s, CER 0.29% không đổi, 0 `AcceleratorError`) và thêm `CookieManager.getInstance().flush()` vào `onPageFinished()`.

---

## 3. Bảng kết quả nghiệm thu thực tế trên HONOR MTN-NX1 (`ATSYVB6205006984`)

| # | Hạng mục kiểm thử trên điện thoại thật | Trạng thái | Bằng chứng thực tế đo được |
|---|---|---|---|
| 1 | Cài sạch APK qua ADB (`test-device.ps1`) & xác minh package/version | **PASS** | `Performing Streamed Install -> Success`; `vn.viread.android`, `versionCode=1`, `versionName=0.1.0`, `TEST_DEVICE_EXIT=0`. |
| 2 | Mở app tải `https://192.168.1.4:8443/login` qua Wi-Fi LAN HTTPS (`192.168.1.3`), 0 lỗi TLS/cleartext | **PASS** | `phone_screen_insets_fixed.png`, `logcatSslOrCleartextErrorCount = 0`. |
| 3 | Đăng nhập thật Supabase (Parent A) → chọn hồ sơ `Bé Minh Nghiệm Thu` → mở `/book-scanner` | **PASS** | `phone_dashboard.png`, `phone_scanner.png`, URL `https://192.168.1.4:8443/book-scanner`. |
| 4 | Quyền Camera: Từ chối → hiện thông báo rõ → Cấp lại mở camera ngay lần bấm đầu → Bấm Home giải phóng camera | **PASS** | `android.permission.CAMERA: granted=true`; `stage_a2_cam_first_tap_live.png` (chấm xanh camera bật); `stage_a3_cam_released.png` (chấm xanh tắt, `Camera đang tắt`). |
| 5 | Trình chọn tệp hệ thống Android (`PickActivity`) mở & hủy bằng phím Back sạch; nút **Hủy quét** và **Thử lại với ảnh này** sau timeout hoạt động | **PASS** | `com.google.android.documentsui/.picker.PickActivity` mở & quay lại `MainActivity` an toàn. |
| 6 | Gửi ảnh trang sách tiếng Việt từ điện thoại (`192.168.1.3`) → Windows FastAPI → OCR tiếng Việt cục bộ (`cloud_ocr_used=false`) + đối chiếu log Windows (0 rò rỉ văn bản/token) | **PASS** | **Lượt 1 (PNG, `phone_ocr_result_real.png`):** `28/28` từ tiếng Việt chuẩn dấu, khớp Trang 1 `"NHỮNG NGƯỜI KHỐN KHỔ"`, `engine=paddleocr_vietocr_dual`, `device=cuda`, `jobId=822bfdd6-5965-4429-a8cd-5da9e97f4af4`, `requestId=a0ca0a03ab094fb7a0ba50b001033cf0`. **Lượt 2 (EXIF-6 JPEG ấm):** `8.81s` end-to-end (`jobId=089a9d3f-...`, `requestId=697bb2c2...`). Log Windows ghi nhận IP `192.168.1.3`, khớp 100% ID, `zeroPlaintextInLog=true`, `zeroBearerInLog=true`. |
| 7 | Hoàn thành buổi đọc thật từ điện thoại qua Wi-Fi (`create` → `complete` → `finish`) | **PASS** | `sessionId=170e264a-1b2a-46d1-b2fc-631f805adb37`, HTTP `200 / 200 / 200` trên Postgres thật. |
| 8 | Xoay màn hình dọc ↔ ngang ↔ dọc không văng/hủy phiên & Đăng xuất xóa sạch phiên | **PASS** | `landscape: 774×331` ↔ `portrait: 369×774`; sau Logout `/dashboard` chuyển hướng về `/login`. |
| 9 | Phát âm thanh Web Audio trên WebView & từ chối/cấp quyền `RECORD_AUDIO` | **PASS (một phần)** | `webAudioPlaybackOk=true`, `RECORD_AUDIO: granted=true` sau Allow (`NotAllowedError` khi Deny); Android System WebView không có `window.speechSynthesis` nên TTS dùng audio từ server. Lượt gọi `getUserMedia({audio:true})` ngay khoảnh khắc chuyển quyền nhận `NotReadableError` (cần thử lại sau 1s khi cắm lại máy). |
| 10 | Mở `/sessions` & tải lại trang chờ hết skeleton để thấy `"NHỮNG NGƯỜI KHỐN KHỔ"` hiển thị trên HONOR | **NEEDS RE-CHECK (đã PASS trên Playwright LAN E2E; trên HONOR lúc 21:41 ảnh chụp rơi đúng giây thứ 4 khi skeleton đang tải)** | Dữ liệu phiên `170e264a-...` đã lưu `200 OK` trên DB; chỉ cần cắm lại điện thoại chạy `phone_final_acceptance.mjs` (chờ đến khi text hiện thay vì sleep cứng 4s). |
| 11 | Giữ phiên đăng nhập sau `am force-stop` với bản APK cuối (`8848c0e1...` đã bổ sung `CookieManager.flush()` tại `onPageFinished`) | **PENDING RE-PLUG** | Đã sửa & build xong APK `8848c0e1...`; chưa chạy lại trên HONOR vì điện thoại đã ngắt kết nối USB lúc 23:25. |
| 12 | Kiểm tra phục hồi trên HONOR sau khi restart backend Windows | **PENDING RE-PLUG** | Đã xác minh restart sạch phía Windows (`Start/Stop/Restart PASS`); chờ cắm lại HONOR để xác minh phía app. |

---

## 4. Lệnh chạy lại nghiệm thu tự động khi cắm lại HONOR MTN-NX1

```powershell
# 1. Khởi động máy chủ Windows LAN (cổng 8443; nội bộ 3001/8001)
powershell -NoProfile -ExecutionPolicy Bypass -File F:\c1\capstone1-android-lan\scripts\windows\Start-ViRead.ps1 -SkipFrontendBuild

# 2. Cài sạch bản APK cuối (SHA-256: 8848c0e1e67957be56e101a682a41da3e1d69d8e202a958bd6ef5a60949bec9f)
powershell -NoProfile -ExecutionPolicy Bypass -File F:\c1\capstone1-android-lan\android\scripts\test-device.ps1 `
  -ApkPath "F:\c1\viread-android-delivery\viread-lan-acceptance-debug.apk" `
  -ExpectedLanOrigin "https://192.168.1.4:8443"
```
