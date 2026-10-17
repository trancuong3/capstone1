# AI tutor — bàn giao phase 6

## Phạm vi bàn giao

Nhánh `feature/linh-ai-tutor`, nền `main` tại `93900ef`. Đã fetch lại remote trước bàn giao: `origin/main` vẫn cùng commit; remote mặc định là main và không có develop. Không push trực tiếp hoặc tự merge main.

Luồng: chọn từ trong trang VERIFIED của phiên sở hữu → frontend gửi hai ID → FastAPI xác thực parent active → repository lấy đúng revision/từ/ngữ cảnh → Gemini trả JSON được kiểm tra → UI hiển thị, tùy chọn nghe bằng ElevenLabs → đọc tiếp. Không tạo câu hỏi/điểm/lỗi đọc, lịch sử chat hoặc ghi dữ liệu tutor vào DB.

Backend mới tách router/schema/service/repository/provider. Frontend dùng typed API adapter, hook quản lý request/cache/cancellation và panel riêng. Điểm tích hợp chung chỉ ở router, reading-screen và hook âm thanh; không sửa auth, admin, OCR, schema database hoặc luồng chọn trang hiện có.

## Cấu hình môi trường

Các máy trong nhóm tự cấu hình `backend/.env`, không copy key vào Git, frontend hoặc nội dung PR:

```dotenv
GEMINI_API_KEY="your-private-gemini-key"
GEMINI_TUTOR_MODEL="gemini-3.5-flash-lite"
```

Model này đã được thử với bộ câu tiếng Việt. Không có tên model mặc định trong runtime; deployment tự chọn model đang được project cấp quyền.

Giữ cấu hình database/Supabase hiện có. Trang sách cần SUPABASE_STORAGE_BUCKET và một trong SUPABASE_SECRET_KEY / SUPABASE_SERVICE_ROLE_KEY để tạo signed URL. Âm thanh dùng ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID và tùy chọn ELEVENLABS_MODEL_ID theo code voice hiện có. Không đưa giá trị thật vào `.env.example`.

Hồ sơ sử dụng tutor cần role parent, active=1 và sở hữu phiên. Không tự kích hoạt tài khoản bị nhóm chủ động vô hiệu hóa. Phiên phải còn hoạt động, liên kết đúng selected page/revision, có VerifiedText và danh sách từ hợp lệ.

Key từng gửi qua chat cần được thu hồi/thay mới bởi chủ key. Không khẳng định đã rotate thay người dùng. Đã rà để không đưa giá trị secret vào các tệp bàn giao.

## Chạy và kiểm thử

Backend, từ `backend`:

```powershell
.\.venv\Scripts\python.exe -B -m uvicorn app.sever:app --reload --host 127.0.0.1 --port 8000
```

Frontend, từ `frontend`:

```powershell
npm run dev -- --webpack --hostname 127.0.0.1 --port 3000
```

Webpack được dùng cho dev/test tutor trên môi trường Windows đã kiểm tra; không thay cấu hình build production. Cần cài dependency theo requirements/package lock của repository. Không dùng cấu hình Playwright hay token test để chạy ứng dụng thật.

Regression backend cô lập (từ `backend`, **93 test đạt**):

```powershell
.\.venv\Scripts\python.exe -B -W error::RuntimeWarning run_tutor_tests.py
```

Runner dùng key/URL giả trong bộ nhớ, chặn HTTPX transport thật và giữ TestClient/MockTransport hoạt động. Không chỉnh `.env` cục bộ. Không dùng script `check_tutor_live.py --run` để chạy regression tự động: script live thực sự gọi Gemini tối đa 10 lần và chỉ dùng khi chủ động chấp nhận hạn mức/chi phí.

Frontend, từ `frontend`:

```powershell
.\node_modules\.bin\vitest.cmd run tests/reading test/tutor-service.test.ts test/use-ai-tutor.test.tsx test/ai-tutor-panel.test.tsx test/use-speech-player.test.tsx
.\node_modules\.bin\playwright.cmd test --config=playwright.ai-tutor.config.ts
npm run build
npm run typecheck
```

- Unit/component tập trung: **45/45 đạt**, chạy lại phase 6.
- Backend: **93/93 đạt**, chạy lại phase 6 bằng runner cô lập.
- Build và typecheck: **đạt**, chạy lại phase 6 khi dev server đã dừng.
- ESLint 14 tệp frontend thuộc tutor: **đạt**, chạy lại phase 6.
- Prettier các tệp tutor/tài liệu và `git diff --check`: kiểm tra trước commit.
- Playwright: **12/12 đạt ở phase 5**, sáu tình huống trên desktop/mobile; có kiểm tra kích thước/focus, mic và audio tổng hợp.
- Gemini thật: 10 mẫu lớp 1/lớp 5 sau siết prompt đúng schema và đã rà nội dung. Người dùng đã test lời giải thích trên trang sách thật, log endpoint tutor trả 200.
- Screenshot desktop/mobile đã được xem cục bộ ở `frontend/test-results/ai-tutor/`; là artifact bị ignore, không đính kèm vào Git/PR trong lần bàn giao này.

## Giới hạn cần review, chưa coi bản phát hành production

1. **TTS thật chưa đạt:** ElevenLabs hết hạn mức. GET chỉ đọc xác nhận giọng/model truy cập được và hỗ trợ tiếng Việt; UI giữ giải thích chữ và cho đọc tiếp khi TTS lỗi. Không tự mua gói hoặc đổi dịch vụ.
2. **Đổi trang thủ công:** get_page cũ chưa lưu selected revision vào phiên, vì thế tutor có thể trả 409 khi đổi trang. Không nới authorization/revision contract để che lỗi; cần task được thống nhất riêng.
3. **Toàn repository chưa xanh:** phase 5 chạy npm test cho 443 pass/14 lỗi cũ; lint có 3 lỗi conditional hooks camera-preview và 8 warning; format có 28 file cũ lệch định dạng. Không sửa các file này trong task tutor; danh sách và nguyên nhân ở AI_TUTOR_PHASE5.md / mục 15 AI_TUTOR_PLAN.md. Không ghi full test:e2e là đã pass: chỉ suite tutor được chạy.
4. Bộ mẫu AI không chứng minh chất lượng tuyệt đối hoặc chống mọi prompt injection. Không dùng lời giải thích làm bằng chứng chấm điểm trẻ.

PR được mở ở trạng thái **draft** để nhóm review cùng các giới hạn/kiểm tra chưa đạt trên. Không bật auto-merge, không sửa branch protection hoặc workflow CI. Chỉ chuyển Ready for review/merge khi nhóm quyết định; nếu scope bổ sung khác phạm vi đã chốt thì tạo task riêng.

## Rủi ro xung đột

Đối chiếu lại main trước lúc merge. Những file dễ trùng công việc: `backend/app/api/router.py`, `frontend/components/reading/reading-screen.tsx`, `frontend/hooks/use-speech-player.ts`, `.env.example` và các fixture test reading. Cùng nền main ở thời điểm push không bảo đảm sẽ không có conflict nếu thành viên khác merge thêm sau đó.

Đã dừng cả server frontend/backend trước khi bàn giao. Việc bật/tắt active và thêm Storage do người dùng tự thực hiện trên môi trường thật, không phải migration hay dữ liệu commit từ task này.
