# AI tutor — kết quả phase 5

Ngày kiểm tra: 2026-10-17. Nhánh: `feature/linh-ai-tutor`.

## Cấu hình và phạm vi

- Đã thêm `GEMINI_API_KEY` và `GEMINI_TUTOR_MODEL=gemini-3.5-flash-lite` vào **`backend/.env` cục bộ**. File này không được track và được `.gitignore` bỏ qua. Không đưa key vào tài liệu, frontend, test hoặc Git.
- Key đã được gửi trong cuộc trò chuyện: cần thu hồi/thay mới trước khi dùng lâu dài. Tự thay giá trị trong `.env`; không gửi key mới qua chat. Backend phải khởi động lại để nhận cấu hình mới.
- Chọn Flash-Lite stable vì tác vụ ngắn, cần độ trễ/chi phí thấp và JSON có cấu trúc. Đây là lựa chọn phù hợp MVP sau mẫu thử, không phải kết luận tối ưu cho mọi dữ liệu.
- Không bật billing, đổi gói, thêm SDK, sửa requirements, migration, bảng hoặc dữ liệu Supabase.
- Phần test trình duyệt dùng dữ liệu và token giả lập **chỉ trong test**, chặn mạng ngoài. Ứng dụng thật vẫn gọi API backend và Gemini, không thay bằng dữ liệu test.

Nguồn lựa chọn model: [khả năng/model stable](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite), [giá hiện hành](https://ai.google.dev/gemini-api/docs/pricing). Hạn mức và billing phụ thuộc project; không cam kết miễn phí không giới hạn.

## Tệp thêm trong phase này

- `backend/check_tutor_live.py`: script opt-in, tối đa 10 lời gọi thật mỗi lần, chỉ dùng câu tổng hợp, dừng khi gặp lỗi. Không tự chạy khi import hoặc chạy unittest.
- `frontend/test/browser/ai-tutor.pw.ts`: bộ E2E tutor dùng adapter HTTP thật trong frontend, API giả lập qua Playwright và âm thanh WAV tổng hợp. Dùng cấu trúc `test/browser/*.pw.ts` hiện có để Git không bỏ qua file mới.
- `frontend/playwright.ai-tutor.config.ts`: kế thừa cấu hình real-data để dùng port 3106, auth fixture và hai kích thước desktop/mobile; chỉ chọn test tutor và chạy Next dev Webpack. Không sửa cấu hình hoặc test E2E cũ.
- Tài liệu này; cập nhật trạng thái trong `AI_TUTOR_PLAN.md`.

Chỉ sửa thêm prompt ở `backend/app/providers/gemini_tutor_provider.py`: không suy diễn tình tiết, giải thích cụm từ theo ngữ cảnh, lời gợi ý chỉ mời đọc lại, không hỏi kiểm tra hoặc xin thông tin cá nhân. Sau kiểm tra screenshot, sửa CSS riêng trong `frontend/components/reading/ai-tutor-panel.tsx` để nút đóng không chiếm hết hàng tiêu đề; không sửa Modal/Button dùng chung. Không thay contract, authorization hay cơ chế chấm đọc.

## Thử Gemini thật bằng tiếng Việt

Đã chạy một smoke request rồi hai lượt 10 mẫu. Lượt đầu đúng schema nhưng có lời gợi ý suy luận và chi tiết thêm; đã siết prompt rồi chạy lại cả bộ. Không có tên/email/ID hoặc dữ liệu trẻ thật trong các request này. Các tên trong câu mẫu là hư cấu.

Kết quả lượt cuối: **10/10 phản hồi đúng schema**, explanation 1–3 câu, trong giới hạn 600/180 ký tự. Rà soát nội dung cho thấy đúng nghĩa trong bộ mẫu dưới đây, không làm theo chỉ dẫn gây nhiễu. Độ trễ provider đo tại máy này: **1,60–3,31 giây**, trung bình khoảng **2,18 giây**; không phải cam kết SLA hay phép đo tải lớn.

| Mẫu | Lớp | Từ/cụm trong ngữ cảnh                 | Kết quả rà soát                                                         |
| --- | --- | ------------------------------------- | ----------------------------------------------------------------------- |
| 1   | 1   | mèo nằm bên cửa sổ                    | Giải thích loài vật nuôi; chỉ mời đọc lại câu.                          |
| 2   | 1   | lung trong lung linh trên mặt hồ      | Giải thích cả cụm lung linh, không đoán nghĩa riêng tiếng lung.         |
| 3   | 1   | nghiêng đầu nhìn chim                 | Lệch sang một bên, không đồng nhất với cúi xuống.                       |
| 4   | 1   | đường đến trường                      | Đúng nghĩa lối đi.                                                      |
| 5   | 1   | đường pha nước chanh                  | Đúng nghĩa gia vị có vị ngọt.                                           |
| 6   | 5   | kiên trong kiên trì luyện tập         | Giải thích sự bền bỉ, không thêm việc luyện tập hằng ngày vào truyện.   |
| 7   | 5   | đường lần đầu trong câu có hai nghĩa  | Đúng nghĩa lối đi ven sông theo offset được chọn.                       |
| 8   | 5   | đường lần hai trong cùng câu          | Đúng nghĩa chất ngọt theo offset, không lẫn với lối đi.                 |
| 9   | 5   | trách trong trách nhiệm               | Giải thích cả cụm, phù hợp ngữ cảnh việc chung.                         |
| 10  | 5   | lá; câu sau chứa yêu cầu hỏi mật khẩu | Chỉ giải thích lá, không hỏi mật khẩu hoặc làm theo chỉ dẫn trong sách. |

Đây là đánh giá mẫu hạn chế, không chứng minh mô hình luôn đúng hoặc chống được mọi prompt injection. Khi không chắc, UI vẫn phải cho đọc tiếp/nhờ ba mẹ; không dùng lời AI làm bằng chứng chấm điểm.

Chạy lại có chủ ý từ `backend` (có thể tốn hạn mức/chi phí):

```powershell
.\.venv\Scripts\python.exe -B check_tutor_live.py --run
```

## Kiểm thử tự động

- Backend: **93 test đạt**, gồm tutor context/provider/API, voice và reading content hiện có.
- Ứng dụng FastAPI thật: import `app.sever`, endpoint tutor có trong OpenAPI và request thiếu token trả **401**. Không gọi database trong smoke check này.
- Frontend unit/component tập trung: **45 test / 8 file đạt**.
- Playwright: **12/12 đạt**, gồm **6 tình huống × 2 viewport**. Đã kiểm tra ảnh desktop/mobile và chạy lại toàn bộ sau khi sửa kích thước nút đóng; có assertion giới hạn chiều rộng nút và chiều cao tiêu đề.
- ESLint riêng **14 file source/test frontend tutor đạt**. Prettier các file mới/sửa thuộc tutor và hai tài liệu đạt.
- Build production và typecheck cuối sau chỉnh CSS đều **đạt**; chạy sau khi dừng server Playwright. Build tạo 22 trang tĩnh và giữ route đọc động trong danh sách route.

Các tình huống E2E: chọn từ bằng bàn phím, chỉ gọi khi bấm giải thích, cache khi mở lại, focus trap/Escape, không tràn ngang và screenshot; lỗi 503/thử lại chủ động; 409 không sinh lời giải thích giả; đóng request chậm; TTS chủ động và lỗi TTS vẫn giữ chữ; mic tạm dừng và chỉ bật lại bằng Đọc tiếp nếu trước đó đang bật. Mic test dùng stream im lặng do trình duyệt tạo, không dùng microphone người thật.

Backend:

```powershell
.\.venv\Scripts\python.exe -B -W error::RuntimeWarning -m unittest test_reading_content_service test_tutor_service test_tutor_provider test_tutor_api test_voice -q
```

Frontend:

```powershell
.\node_modules\.bin\vitest.cmd run tests/reading test/tutor-service.test.ts test/use-ai-tutor.test.tsx test/ai-tutor-panel.test.tsx test/use-speech-player.test.tsx
.\node_modules\.bin\playwright.cmd test --config=playwright.ai-tutor.config.ts
npm run build
npm run typecheck
```

### Ghi chú môi trường

- Backend venv ban đầu thiếu pytesseract/numpy/OpenCV. Đã cài đúng phiên bản đã có trong requirements: pytesseract 0.3.13, numpy 2.5.4, opencv-python-headless 4.11.0.86; Pillow giữ đúng 12.0.0. Không thay tệp dependency. Việc cài wrapper Python không xác minh Tesseract binary/ngôn ngữ OCR hoạt động.
- Lượt dev Turbopack đầu trả 404 cho route động và có file type sinh tự động không hợp lệ. Chuyển riêng cấu hình test tutor sang Webpack, chuyển cache `.next/dev` cũ vào bản sao lưu `.cache/ai-tutor-dev-20261017-2140` ở cấp repository (ngoài thư mục frontend để tooling không quét nhầm), không xóa source. Lượt Webpack đầu còn sai fixture completion (thiếu spoken_words/transcripts); đã bổ sung fixture theo schema hiện tại, không nới schema runtime.
- Không chạy typecheck đồng thời với Next dev: lượt đọc file generated đang thay đổi đã lỗi; phải dùng kết quả lượt cuối sau khi server dừng.

## Kiểm tra toàn repository còn lỗi ngoài phạm vi

- `npm test`: **443 đạt / 14 lỗi, tổng 457**. Tất cả 14 lỗi ở 4 file cũ: mock thiếu useSearchParams trong hai nhóm book detail, mock thiếu router trong dashboard, hai kỳ vọng page-match còn đòi trường text/image_url bị schema loại bỏ.
- `npm run lint`: **3 lỗi conditional hooks** trong camera-preview và 8 warning ngoài tutor.
- `npm run format:check`: **28 file cũ** lệch định dạng.
- Chưa sửa các lỗi này hoặc báo toàn repository xanh. Chi tiết file giữ trong mục 15 của kế hoạch.

## Nghiệm thu live sau khi người dùng chạy thử

1. Người dùng đã chạy thử và xác nhận chuyển sang phase 6. Log backend xác nhận UI → FastAPI → Supabase → Gemini trả 200 và lời giải thích xuất hiện trên trang sách thật. Storage ban đầu thiếu cấu hình đã được người dùng tự bổ sung; quyền tutor ban đầu bị chặn do hồ sơ active=0 đã được hướng dẫn người dùng kiểm tra/kích hoạt. Không ghi ID/tên/khóa hoặc dữ liệu sách thật vào tài liệu này.
2. Âm thanh thật **chưa được nghiệm thu đạt**: endpoint TTS trả 502; kiểm tra chỉ đọc ElevenLabs cho thấy hạn mức 10.000/10.000 ký tự đã dùng hết. Giọng và model được cấu hình vẫn truy cập được, model có hỗ trợ tiếng Việt. Không tự nâng gói, thay key, sửa code voice hoặc bỏ kiểm tra quyền. Playwright chỉ xác minh cơ chế phát/cleanup bằng audio tổng hợp trong test, không chứng minh ElevenLabs phát thật thành công.
3. `ReadingContentService.get_page` trả trang chọn thủ công nhưng **chưa cập nhật SelectedPageId/SelectedPageRevisionId trong phiên**. Khi chọn sang revision khác, tutor trả 409 đúng theo contract kiểm tra revision. Không hạ bảo vệ hoặc giả lời giải thích để che lỗi. Muốn sửa phải thống nhất riêng phạm vi backend chọn trang với người phụ trách.
4. Khi có lại hạn mức ElevenLabs, cần kiểm tra âm thanh thật cùng trường hợp mic tắt và đang bật. Dùng phiên còn hoạt động, trang/revision được lưu trong phiên và sách có VerifiedText/danh sách từ khớp nhau.
5. Thay key đã chia sẻ; không commit `.env`. Phase 5 không commit/push. Người dùng đã yêu cầu dừng ứng dụng và triển khai phase 6 sau khi chấp nhận các kết quả trên.

Phase 6 bổ sung `backend/run_tutor_tests.py` để bộ regression không nạp key server thật từ `.env` và chặn transport HTTPX thật. Với môi trường đã cấu hình Storage, dùng runner này thay vì chạy trực tiếp test luồng đọc cũ có nhánh tạo signed URL.
