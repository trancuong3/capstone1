# AI tutor: giải thích từ theo ngữ cảnh trang sách

## 1. Mục tiêu và trạng thái

- Ngày lập: 2026-10-17.
- Dự án: ReadAlong Vision.
- Nhánh: `feature/linh-ai-tutor`, tạo từ `main` tại commit `93900ef`.
- Phase 1 đã hoàn thành: tạo nhánh và lập thiết kế.
- Phase 2 đã hoàn thành: schema, repository chỉ đọc, service lấy ngữ cảnh và kiểm thử cô lập.
- Phase 3 đã hoàn thành phần code provider/endpoint và kiểm thử cô lập. Phase 5 đã bổ sung cấu hình cục bộ và thử Gemini thật bằng câu mẫu.
- Phase 4 đã hoàn thành giao diện, API adapter, hủy request/âm thanh và kiểm thử phần đọc/tutor. Các kiểm tra toàn dự án còn lỗi ngoài phạm vi được ghi ở mục 15.
- Phase 5 đã được người dùng chạy thử và chốt chuyển phase 6: lời giải thích trên trang thật hoạt động; TTS thật còn bị chặn do ElevenLabs hết hạn mức. Kết quả và giới hạn khác ghi trong `AI_TUTOR_PHASE5.md`.
- Phase 6: dừng ứng dụng, rà phạm vi/secret, kiểm tra lại và chuẩn bị commit/push/PR draft vào main. Hướng dẫn cấu hình, test và giới hạn trong `AI_TUTOR_HANDOFF.md`; không tự merge.
- Thực hiện lần lượt từng phase theo yêu cầu của người dùng.

Mục tiêu bản đầu: bé chọn một từ trong trang sách đang đọc, yêu cầu giải thích ngắn theo ngữ cảnh và có thể nghe lời giải thích bằng hệ thống giọng nói hiện có.

## 2. Phạm vi đã thống nhất

### Bao gồm

- Giải thích nghĩa của từ được chọn trong ngữ cảnh trang sách đã xác minh.
- Dùng tiếng Việt đơn giản, phù hợp lớp của bé; giải thích khoảng 1–3 câu ngắn.
- Một lời gợi ý bé đọc lại câu chứa từ đó.
- Nút nghe lời giải thích và nút đọc tiếp.
- Trạng thái chưa chọn từ, đang tải, thành công, lỗi và thử lại.
- Kiểm tra Supabase access token, role parent và quyền sở hữu phiên đọc ở backend.
- Đọc dữ liệu thật qua repository và các model hiện có.

### Chưa bao gồm

- Sinh câu hỏi đọc hiểu, đáp án hoặc chấm câu trả lời.
- Chấm phát âm, suy luận lỗi đọc, thay đổi điểm hoặc báo cáo tiến bộ.
- Chatbot trò chuyện tự do, lịch sử hội thoại hoặc cá nhân hóa dài hạn.
- Huấn luyện mô hình, vector database hoặc tìm kiếm toàn bộ thư viện sách.
- Tạo bảng, migration, seed dữ liệu hoặc sửa Supabase từ xa.
- Refactor auth, OCR, camera, STT, TTS, page matching hoặc các tab Parent/Admin.

Kết quả tutor không được dùng làm bằng chứng bé đọc đúng/sai, đã đọc từ nào hoặc đã hoàn thành trang. Lỗi AI/TTS không tạo reading event và không kết thúc phiên.

## 3. Hiện trạng được xác nhận từ mã nguồn

| File                                                 | Hiện trạng / điểm tái sử dụng                                                                      |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `frontend/lib/api/tutor-service.ts`                  | `requestReadExample` trả hành động `READ_EXAMPLE` cố định; chưa gọi backend AI.                    |
| `frontend/components/reading/reading-screen.tsx`     | Có từ đang đọc, thao tác chọn từ, `requestTutor`, player và recorder hiện có.                      |
| `frontend/components/reading/reading-layout.tsx`     | Có vùng `children` để thêm giao diện mà không đổi bố cục chung.                                    |
| `frontend/components/reading/reading-controls.tsx`   | Nút “Giúp” trên mobile thực tế gọi `onManualPage`; cần giữ hành vi chọn trang.                     |
| `frontend/components/reading/tutor-message.tsx`      | Hộp thoại đọc mẫu hiện có; dùng riêng component mới cho phần giải thích.                           |
| `frontend/lib/api/api-client.ts`                     | Có `requestApi` hỗ trợ POST, Bearer token, AbortSignal và kiểm tra response bằng Zod.              |
| `frontend/hooks/use-speech-player.ts`                | Gọi service TTS để phát văn bản.                                                                   |
| `backend/app/api/deps.py`                            | `get_current_parent_id` xác minh token và lấy user ID; service vẫn cần kiểm tra role/quyền sở hữu. |
| `backend/app/models/profile.py`                      | Có `Profile`, `ChildProfile`, quan hệ parent và trường `Grade`.                                    |
| `backend/app/models/reading.py`                      | Có phiên đọc, sách, trang và revision được chọn.                                                   |
| `backend/app/models/book.py`                         | Có trang, revision đã xác minh, văn bản và từ trong revision.                                      |
| `backend/app/providers/elevenlabs_voice_provider.py` | Đã có adapter STT/TTS; không cần thêm dịch vụ giọng nói cho task này.                              |

Đây là kết quả đọc source, chưa xác minh dữ liệu hiện tại trên Supabase hoặc tình trạng dịch vụ ElevenLabs/Gemini thực tế. README có phần mô tả cũ; khi triển khai cần lần theo code hiện hành.

## 4. Luồng và trách nhiệm các lớp

Frontend chọn từ → typed tutor service → FastAPI router → request schema → tutor service → repository → model/PostgreSQL → tutor service → Gemini provider → kiểm tra kết quả → response schema → frontend.

- Router: nhận request, dùng dependency xác thực/database và gọi service; không query hoặc viết prompt.
- Request schema: UUID, trường bắt buộc, từ chối trường ngoài contract.
- Service: quyền sở hữu, trạng thái phiên, kiểm tra liên kết sách/trang/revision/từ, xây dựng ngữ cảnh và điều phối provider.
- Repository: tất cả truy vấn ORM; trả dữ liệu cần cho service, không quyết định phản hồi HTTP.
- Provider: gọi Gemini với timeout, giới hạn đầu ra và cấu trúc JSON; chuyển lỗi nhà cung cấp thành lỗi nội bộ an toàn.
- Response schema: chỉ xuất các trường được công bố bên dưới.

Tuân thủ `BACKEND_FLOW_STANDARD.md`. Luồng gọi Gemini là dịch vụ bên ngoài, không phải đường ghi dữ liệu PostgreSQL.

## 5. Contract API bản đầu

### Endpoint

```http
POST /tutor/sessions/{session_id}/explain-word
Authorization: Bearer <Supabase access token>
Content-Type: application/json
```

`session_id`, `page_revision_id`, `word_id` đều là UUID. Token ở ví dụ là placeholder, không đưa token thật vào tài liệu hoặc log.

### Request

```json
{
  "page_revision_id": "55555555-5555-4555-8555-555555555555",
  "word_id": "66666666-6666-4666-8666-666666666666"
}
```

Không nhận tên bé, lớp, toàn văn trang, prompt hoặc nội dung từ tùy ý từ client. Backend lấy ngữ cảnh và lớp qua phiên đọc. Chỉ hỗ trợ một từ đã có ID trong revision; chọn cụm từ là mở rộng sau này.

### Response thành công: HTTP 200

```json
{
  "page_revision_id": "55555555-5555-4555-8555-555555555555",
  "word_id": "66666666-6666-4666-8666-666666666666",
  "word": "nghiêng",
  "explanation": "Nghiêng là lệch sang một bên.",
  "reading_hint": "Bé thử đọc lại câu có từ nghiêng nhé."
}
```

- Các trường chuỗi phải được trim và không rỗng.
- Giới hạn dự kiến: `explanation` tối đa 600 ký tự, `reading_hint` tối đa 180 ký tự; chốt lại sau thử nghiệm ở phase 3.
- ID và `word` do backend lấy từ dữ liệu hợp lệ, không tin các ID hoặc từ do mô hình tự sinh.
- Không trả prompt nội bộ, tên bé, token, response thô của nhà cung cấp hoặc metadata không cần thiết.
- Trả `Cache-Control: no-store`; không lưu nội dung trợ giảng vào database trong bản đầu.

### Quy ước lỗi dự kiến

| HTTP | Trường hợp                                                                   | Hành vi frontend                                     |
| ---- | ---------------------------------------------------------------------------- | ---------------------------------------------------- |
| 401  | Thiếu token hoặc token không hợp lệ                                          | Hiện yêu cầu đăng nhập lại theo cơ chế hiện có.      |
| 403  | Role không được sử dụng tutor                                                | Hiện không có quyền sử dụng.                         |
| 404  | Không tìm thấy hoặc không sở hữu tài nguyên                                  | Không tiết lộ tài nguyên thuộc ai.                   |
| 409  | Phiên/trang/revision không còn phù hợp hoặc nội dung chưa sẵn sàng           | Yêu cầu chọn lại từ trên trang hiện tại.             |
| 422  | UUID/request không hợp lệ                                                    | Hiện thông báo dữ liệu không hợp lệ.                 |
| 503  | Thiếu cấu hình, timeout, hết hạn mức hoặc dịch vụ AI tạm thời không sẵn sàng | Hiện chưa thể giải thích, cho thử lại hoặc đọc tiếp. |
| 502  | Kết quả nhà cung cấp không hợp lệ                                            | Hiện chưa thể giải thích, cho thử lại hoặc đọc tiếp. |

Đây là contract mới cho endpoint tutor, không thay đổi contract của endpoint khác. Dùng HTTP status đã được `requestApi` chuyển thành `ServiceError`; panel có thể xét `status` để hiển thị thông báo riêng. Không mở rộng error mapping toàn dự án chỉ để đổi thông báo tutor.

## 6. Ngữ cảnh và dữ liệu

| Model / bảng                              | Dữ liệu cần                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| `Profile` / `profiles`                    | Role của actor và trạng thái truy cập theo quy tắc hiện hành.                      |
| `ChildProfile` / `childprofiles`          | `ParentId`, `Grade`.                                                               |
| `ReadingSession` / `readingsessions`      | `ChildId`, `BookId`, `SelectedPageId`, `SelectedPageRevisionId`, trạng thái phiên. |
| `Book`, `BookPage` / `books`, `bookpages` | Trang thuộc sách của phiên và điều kiện lifecycle hiện hành.                       |
| `PageRevision` / `pagerevisions`          | Đúng revision phiên đang dùng, `VerificationStatus`, `VerifiedText`.               |
| `PageRevisionWord` / `pagerevisionwords`  | Đúng `PageRevisionId`, từ và vị trí trong văn bản.                                 |

Service phải kiểm tra đầy đủ trước khi gọi AI. Chưa đủ điều kiện thì không gọi provider. Dùng đúng revision đang được phiên tham chiếu, không tự chuyển sang revision mới nhất của sách.

Khi trang quá dài, lấy cửa sổ ngữ cảnh quanh từ đang chọn theo giới hạn đã định; không cắt mất từ cần giải thích. Bản thân nội dung sách là dữ liệu, không phải chỉ dẫn để mô hình đổi nhiệm vụ.

Chỉ gửi cho Gemini: từ, đoạn ngữ cảnh cần thiết và lớp của bé. Không cần gửi ID người dùng, tên bé, email, audio hoặc ảnh camera.

## 7. Thiết kế giao diện và bất đồng bộ

### Chọn từ và mở tutor

- Thêm panel qua vùng `children` của `ReadingLayout`, từ `reading-screen.tsx`.
- Dùng thao tác chọn từ trên trang làm đầu vào. Giữ một lựa chọn tutor rõ ràng; thay đổi highlight tự động từ STT không tự thay từ của request đang chạy.
- Chọn từ để hỏi tutor không được tạo thêm bản ghi lời bé đã đọc hoặc điểm đọc.
- Chưa có lựa chọn: hiện “Bé chọn một từ trên trang để mình giải thích nhé.”
- Có lựa chọn: hiện từ và nút “Giải thích từ”.
- Loading chỉ khóa yêu cầu tutor trùng lặp; tránh khóa toàn bộ điều khiển đọc chỉ vì Gemini đang chờ.

### Hộp thoại

- Hiện từ, lời giải thích và lời gợi ý.
- Có “Nghe giải thích”, “Đọc tiếp”; khi lỗi có “Thử lại”.
- Tái sử dụng dialog/button/design token hiện có, có focus, đóng bằng bàn phím và hiển thị phù hợp mobile.
- Render nội dung như text, không đưa HTML từ mô hình vào trang.

### Đổi lựa chọn và dọn dẹp

- Request gắn với bộ `session_id + page_revision_id + word_id` được chụp tại lúc bấm.
- Khi đổi từ, đổi trang, đóng panel hoặc unmount: abort request phía frontend và bỏ qua kết quả đến muộn.
- Không hiển thị kết quả từ/trang cũ lên lựa chọn mới; hủy phía client không được hiểu là nhà cung cấp chắc chắn đã ngừng xử lý/tính phí.
- Giữ kết quả hiện tại trong bộ nhớ giao diện. Nghe lại hoặc mở lại đúng kết quả không cần sinh lời giải thích lần nữa.
- Không lưu hội thoại vào localStorage hoặc database trong task này.

### Âm thanh

- Chỉ phát khi người dùng bấm nghe; dùng player và API TTS hiện có.
- Trước khi phát, dừng âm thanh trước đó và tạm dừng nhận diện để lời tutor không bị tính là giọng bé.
- Ghi nhớ trạng thái nghe trước đó; chỉ tiếp tục theo thao tác “Đọc tiếp”, không tự mở microphone nếu trước đó bé không bật.
- Đóng/chuyển trang/thoát thì dừng phát và dọn kết quả cũ.
- TTS lỗi vẫn giữ lời giải thích trên màn hình, cho đọc tiếp; không biến lỗi này thành lỗi đọc của bé.

## 8. Provider và cấu hình

- Dự kiến dùng Gemini API; chưa chọn model cụ thể hoặc gọi API ở phase 1.
- Model được chọn sau mẫu thử tiếng Việt ở phase 3, khai báo qua `GEMINI_TUTOR_MODEL` thay vì rải tên model trong code.
- API key server-only qua `GEMINI_API_KEY` trong `backend/.env`; `.env.example` chỉ chứa placeholder.
- Ưu tiên cách gọi phù hợp `httpx` đang có. Chỉ thêm SDK vào requirements nếu cần và đã kiểm tra tương thích.
- Dùng timeout hữu hạn, giới hạn ngữ cảnh/đầu ra; không tự retry không giới hạn hoặc gọi lại theo mỗi transcript STT.
- Kiểm tra JSON bằng Pydantic. JSON đúng schema không bảo đảm giải thích đúng nghĩa; đánh giá nội dung riêng ở phase 5.
- Khi thiếu ngữ cảnh, yêu cầu mô hình diễn đạt sự chưa chắc chắn, không tự thêm tình tiết vào truyện.
- Không ghi prompt, key hoặc dữ liệu trẻ vào debug log. Dùng request ID để đối chiếu lỗi theo cơ chế hiện có.

## 9. Các phase và file dự kiến

### Phase 1 — Nhánh và thiết kế

- Kiểm tra Git sạch, đồng bộ main và tạo nhánh.
- Tạo tài liệu này; chốt phạm vi, contract, điểm tích hợp và nghiệm thu.
- Kiểm tra diff và trạng thái Git.
- Chỉ thêm `AI_TUTOR_PLAN.md`; chưa thay runtime, credential, database, dependency hoặc gọi AI.

### Phase 2 — Backend context và authorization

Tạo:

- `backend/app/schemas/tutor.py`
- `backend/app/repositories/tutor_repository.py`
- `backend/app/services/tutor_service.py`
- `backend/test_tutor_service.py`

Đầu ra: lấy đúng ngữ cảnh qua ORM, kiểm tra role/quyền sở hữu/liên kết tài nguyên và kiểm thử bằng repository/provider giả lập trong test. Chưa cần provider thật hoặc public endpoint chạy hoàn chỉnh.

### Phase 3 — Gemini và endpoint

Tạo:

- `backend/app/providers/gemini_tutor_provider.py`
- `backend/app/api/routes/tutor.py`
- `backend/test_tutor_provider.py`
- `backend/test_tutor_api.py`

Sửa:

- `backend/app/api/router.py`: import và đăng ký `/tutor`.
- `backend/.env.example`: placeholder cấu hình tutor.
- Các file tutor phase 2 để nối provider.
- `backend/requirements.txt`: chỉ nếu cần dependency mới.

Đầu ra: endpoint được xác thực, schema công khai đúng contract, lỗi an toàn; gọi thử Gemini thật khi có cấu hình. Nếu chưa có key thì báo rõ việc xác minh live còn thiếu, không thay bằng kết quả giả.

### Phase 4 — Frontend

Tạo:

- `frontend/types/tutor.ts`
- `frontend/hooks/use-ai-tutor.ts`
- `frontend/components/reading/ai-tutor-panel.tsx`

Sửa:

- `frontend/lib/api/tutor-service.ts`: thêm phương thức giải thích với schema Zod và `requestApi`; giữ interface đọc mẫu đang có.
- `frontend/components/reading/reading-screen.tsx`: kết nối panel, lựa chọn từ và phối hợp âm thanh tại điểm gọi.

Hook quản lý request, trạng thái và cleanup; component hiển thị; screen điều phối với phiên đọc/player/recorder hiện có. Không cần đổi provider chung vì `tutorService` đã được khởi tạo ở đó; không cần thêm HTTP client mới.

### Phase 5 — Kiểm thử và nghiệm thu

Dự kiến tạo hoặc cập nhật đúng test tutor:

- `frontend/test/tutor-service.test.ts`
- `frontend/test/use-ai-tutor.test.tsx`
- `frontend/test/ai-tutor-panel.test.tsx`
- `frontend/test/use-speech-player.test.tsx`
- `frontend/test/browser/ai-tutor.pw.ts` và `frontend/playwright.ai-tutor.config.ts` (dùng quy ước browser test hiện có, không sửa rule ignore).
- Các test tutor backend đã thêm ở phase 2–3.

Trước khi tạo, đối chiếu cách bố trí test thực tế để dùng đúng quy ước repository. Chỉ sửa test hiện có nếu trực tiếp bị ảnh hưởng bởi tutor.

Các test unit/component tutor đã được thêm sớm ở phase 4 để xác minh code. Dùng `frontend/test/` vì rule `tests/` trong `.gitignore` đang bỏ qua file mới tại `frontend/tests/`. Test E2E mới cần được kiểm tra quy tắc ignore khi thêm ở phase 5; chưa sửa `.gitignore` chung trong task này.

Từ `backend`, chạy các test tutor đã tạo và test luồng đọc liên quan. Từ `frontend`, chạy các kiểm tra bắt buộc:

```powershell
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

Chạy thêm Playwright cho luồng tutor theo cấu hình repository. Test tự động dùng stub/mock provider có chủ ý, không gọi Gemini hoặc sửa dữ liệu Supabase thật. Phần nghiệm thu thủ công dùng tài khoản, sách thật và cấu hình dịch vụ thật.

Lập tối thiểu 10 ví dụ từ nhiều ngữ cảnh và ít nhất hai mức lớp để xem đúng nghĩa, đủ ngắn, dễ hiểu, không thêm tình tiết. Ghi kết quả thực tế, không đánh dấu pass cho kiểm tra chưa chạy.

### Phase 6 — Bàn giao

- Rà diff, credential, debug log và file ngoài phạm vi.
- Cập nhật tài liệu cấu hình/chạy và checklist kết quả.
- Commit tập trung theo backend, frontend và kiểm thử/tài liệu; push nhánh và mở PR theo yêu cầu triển khai phase này.
- Xác định nhánh đích theo quy trình nhóm ở thời điểm mở PR; tài liệu CONTRIBUTING hiện ghi develop, các PR gần đây tích hợp main. Không tự đổi nhánh đích hoặc merge dựa vào giả định.
- Mô tả rõ các giới hạn bản đầu và phần live nào đã/chưa được xác minh.

## 10. Tiêu chí nghiệm thu

- [x] Giải thích dùng đúng từ và revision của phiên đang đọc.
- [x] Chỉ parent sở hữu phiên được gọi tutor; sai quyền bị chặn trước khi gọi AI.
- [x] Sai word/revision hoặc nội dung chưa sẵn sàng không được gọi provider.
- [x] Giải thích ngắn, phù hợp lớp và ngữ cảnh trong bộ ví dụ thủ công.
- [x] Lỗi mạng/timeout/provider hoặc JSON sai có đường thử lại/đọc tiếp.
- [x] Đổi từ/chuyển trang/đóng panel không hiển thị phản hồi cũ.
- [x] Nghe lại không gọi LLM để sinh lại cùng kết quả (kiểm thử tự động).
- [x] Âm thanh tutor không bị tính thành lời bé đọc; không tự bật mic ngoài ý định (kiểm thử tự động).
- [x] Không tạo lỗi đọc, điểm, câu hỏi, lịch sử hoặc thay đổi báo cáo từ thao tác tutor.
- [x] Desktop/mobile, focus và thao tác bàn phím dùng được.
- [x] Các kiểm tra bắt buộc pass hoặc có báo cáo lỗi và phạm vi ảnh hưởng cụ thể.
- [x] Không có secret hoặc thay đổi ngoài phạm vi trong commit (đã rà giá trị secret cục bộ, dấu dữ liệu live và staged diff phase 6).

## 11. Phối hợp nhóm và giới hạn xung đột

- Hai điểm dễ trùng công việc: `backend/app/api/router.py` và `frontend/components/reading/reading-screen.tsx`.
- Giữ thay đổi ở đó nhỏ; logic mới đặt trong file tutor riêng.
- Giữ API và component đọc mẫu hiện có hoạt động; không sửa chức năng chọn trang để gắn tutor.
- Kiểm tra diff của từng file trước commit; không format toàn repository để dọn lỗi không liên quan.
- Nhánh riêng không bảo đảm không có conflict. Trước PR cần đối chiếu nhánh đích và các thay đổi mới của thành viên khác.
- Không push trực tiếp main; việc tạo nhánh ở phase 1 không đồng nghĩa được phép merge PR.

## 12. Nguồn tham chiếu

- `BACKEND_FLOW_STANDARD.md` và code thực tế trong các file ở mục 3.
- Gemini structured outputs: https://ai.google.dev/gemini-api/docs/structured-output
- Ollama structured outputs, chỉ để đối chiếu phương án chạy local: https://docs.ollama.com/capabilities/structured-outputs

Các tài liệu nhà cung cấp cần được kiểm tra lại khi chọn model và triển khai provider; phase 1 chưa cam kết model, mức phí hoặc hạn mức cụ thể.

## 13. Kết quả triển khai phase 2

- Thêm đúng bốn file backend đã dự kiến ở phase 2; không sửa code backend/frontend hiện có.
- `TutorService.get_word_context` kiểm tra role parent, `Active = 1`, quyền sở hữu phiên, lớp 1–5, trạng thái phiên, revision được chọn, lifecycle của sách/trang và trạng thái VERIFIED.
- Chỉ cho phép phiên `IN_PROGRESS`, `PAGE_READY`, `LISTENING`, `PAUSED` và chưa có `EndedAt`. Các phiên thiếu lựa chọn hoặc dùng revision khác bị trả 409.
- Lấy đúng revision gắn với phiên, kể cả khi admin đã xác minh revision mới hơn. Không dùng draft text làm dữ liệu thay thế.
- Đối chiếu danh sách từ theo WordIndex với VerifiedText, chuẩn hóa NFC và giữ dấu tiếng Việt. Nội dung không khớp bị từ chối thay vì đoán vị trí.
- Giới hạn ngữ cảnh 4.000 ký tự, lấy nguyên token quanh lần xuất hiện được chọn. Context nội bộ có `word_start`, `word_end` để phase 3 phân biệt những từ lặp lại khác nghĩa; các offset không làm thay đổi response API đã chốt.
- Repository chỉ có truy vấn đọc; không có thao tác lưu sự kiện, điểm, phiên đọc hoặc dữ liệu tutor.
- Chưa có provider thật trong phase này. Kiểm thử dùng repository giả lập và kiểm tra cấu trúc truy vấn ORM; chưa xác minh truy vấn trên Supabase thật.

Kiểm tra từ thư mục `backend`:

```powershell
.\.venv\Scripts\python.exe -B -W error::RuntimeWarning -m unittest test_tutor_service -q
```

Kết quả: **34 test đạt**, bao gồm schema, authorization, truy vấn theo chủ sở hữu/revision, ngữ cảnh ngắn/dài, từ lặp lại, Unicode và lifecycle.

Đã thử chạy riêng kiểm thử luồng đọc cũ:

```powershell
.\.venv\Scripts\python.exe -B -m unittest test_reading_content_service -q
```

Chưa chạy được vì import của code cũ đi qua `runtime_diagnostics.py` và môi trường backend hiện thiếu `pytesseract`. Kết quả này không được đánh dấu pass; chưa thay đổi dependency hoặc code ngoài phạm vi để xử lý lỗi môi trường.

Chưa commit/push ở thời điểm hoàn thành phase 2. Kết quả phase 3 được ghi ở mục tiếp theo.

## 14. Kết quả triển khai phase 3

### Code đã thêm / tích hợp

- `backend/app/providers/gemini_tutor_provider.py`: gọi REST `models.generateContent` bằng `httpx` đã có, không thêm SDK hoặc sửa requirements.
- `backend/app/api/routes/tutor.py`: endpoint POST theo contract, dùng dependency xác thực hiện có và factory service/repository.
- `backend/app/api/router.py`: đăng ký router dưới prefix `/tutor`.
- `backend/app/schemas/tutor.py`: thêm `TutorExplanation` chỉ có explanation/reading_hint; response công khai giữ nguyên các trường đã chốt.
- `backend/app/services/tutor_service.py`: thêm `explain_word`, lấy ngữ cảnh hợp lệ trước khi tạo/gọi provider và dựng response bằng ID/từ từ database.
- `backend/.env.example`: thêm hai biến Gemini rỗng, không có credential thật.
- `backend/test_tutor_provider.py`, `backend/test_tutor_api.py`: kiểm thử HTTP provider, contract endpoint, auth và tích hợp router/service/provider.

### Hành vi

- Chỉ gửi từ, ngữ cảnh, lớp và vị trí lần xuất hiện được chọn cho Gemini; không gửi ID người dùng/phiên, tên bé, email hoặc media.
- API key gửi bằng header `x-goog-api-key`, không đặt trong URL hoặc nội dung prompt.
- Request một lượt, một candidate, tối đa 1.024 output tokens; không tự retry hoặc fallback sang model khác.
- Timeout tổng 20 giây, timeout HTTP hữu hạn, giới hạn response 65.536 byte, không đi theo redirect.
- JSON yêu cầu đúng hai trường; Pydantic giới hạn explanation 600 ký tự, reading_hint 180 ký tự, trim và từ chối chuỗi rỗng/trường ngoài contract.
- Từ chối phản hồi bị chặn, chưa hoàn tất, sai envelope, dữ liệu quá lớn hoặc JSON không hợp lệ. Không trả thought parts hay response thô.
- Thiếu cấu hình, lỗi mạng, timeout và HTTP lỗi từ nhà cung cấp trả 503; phản hồi không hợp lệ trả 502. Không giả lập lời giải thích khi runtime gặp lỗi.
- Response thành công và lỗi provider có `Cache-Control: no-store`. Lỗi provider được ghi nhận qua diagnostic logger hiện có, không log key/prompt/nội dung sách hoặc response thô.
- Chưa thay đổi frontend và không có thao tác ghi database, sự kiện hoặc điểm đọc.

### Kiểm tra đã chạy

Từ thư mục `backend`:

```powershell
.\.venv\Scripts\python.exe -B -W error::RuntimeWarning -m unittest test_tutor_service test_tutor_provider test_tutor_api test_voice -q
```

Kết quả: **76 test đạt** (69 test tutor và 7 test voice hiện có). Kiểm thử gồm request hợp lệ, token thiếu/sai, role/quyền sở hữu, word/revision không hợp lệ, cấu hình thiếu, redirect, upstream errors, timeout/cancellation/cleanup, response quá lớn, blocked/truncated content, schema sai và luồng endpoint → service → adapter HTTP giả lập.

Đã kiểm tra cú pháp các file Python phase 3 và rà diff hai điểm tích hợp là router/env example. Test dùng HTTPX MockTransport và repository giả lập; không gọi Google/Supabase thật hoặc sửa dữ liệu thật.

### Cấu hình và phần chưa xác minh live

Đã kiểm tra chỉ trạng thái có/không cấu hình, không in credential. Môi trường hiện chưa có cả `GEMINI_API_KEY` lẫn `GEMINI_TUTOR_MODEL`, nên chưa gọi Gemini thật, chọn model qua thử nghiệm hoặc đánh giá chất lượng tiếng Việt.

Khi có cấu hình, điền vào `backend/.env` (không phải frontend):

```dotenv
GEMINI_API_KEY="<khóa Gemini của nhóm>"
GEMINI_TUTOR_MODEL="<model hỗ trợ generateContent và structured JSON của project>"
```

Provider chấp nhận tên `gemini-...` hoặc `models/gemini-...`; không tự chọn model mặc định. Chọn model thật có quyền sử dụng trong Google project trước khi thử; các tên `gemini-test` trong test chỉ là tên giả lập, không phải hướng dẫn chọn model.

Sau khi backend đủ dependency và được khởi động, có thể thử endpoint trong `/docs`: Authorize bằng access token của parent, nhập session ID đang hoạt động, revision ID và word ID hợp lệ. Giao diện tutor sẽ được nối ở phase 4.

Chưa xác minh khởi động toàn bộ backend hoặc regression test đọc sách cũ; môi trường thiếu `pytesseract` đã được ghi nhận ở phase 2. Phase 3 không sửa dependency/code OCR để xử lý việc này.

Chưa commit/push. Bước tiếp theo là phase 4: service frontend, hook và panel tutor.

## 15. Kết quả triển khai phase 4

### Code và hành vi đã thực hiện

- Thêm `frontend/types/tutor.ts`: request, selection, response và trạng thái UI có kiểu rõ ràng.
- Thêm `frontend/hooks/use-ai-tutor.ts`: gửi yêu cầu theo thao tác, ngăn request trùng, giữ kết quả hiện tại trong bộ nhớ và abort/bỏ qua kết quả muộn khi đóng/đổi scope/unmount.
- Thêm `frontend/components/reading/ai-tutor-panel.tsx`: nút “Giải thích từ”, dialog có focus/keyboard, loading, retry, nội dung, nghe/dừng và đọc tiếp.
- Mở rộng `frontend/lib/api/tutor-service.ts`: dùng `requestApi` hiện có, Bearer token và schema Zod strict. Chỉ gửi revision/word ID, kiểm tra ID response khớp request. Giữ hai phương thức đọc mẫu đang có.
- Tích hợp ở `frontend/components/reading/reading-screen.tsx` qua vùng `children` của ReadingLayout; không đổi nút chọn trang, layout chung hoặc app-services provider.
- Chọn từ thủ công chỉ cập nhật lựa chọn/highlight, không thêm transcript hoặc ghi nhận từ đó là lời bé đã đọc. Highlight tự động từ STT không tự đổi lựa chọn tutor.
- Tutor có trạng thái riêng, không dùng global isBusy trong thời gian chờ Gemini; không làm kết thúc phiên hoặc thêm sự kiện/điểm đọc.
- Khi mở tutor, dừng đọc mẫu và tạm dừng mic/recognizer; hủy buffer recorder chưa xử lý để không thu lời tutor thành lời bé. Kết quả STT của đoạn cũ đến sau lần ngắt tutor bị bỏ qua.
- Chỉ bấm “Đọc tiếp” mới khôi phục mic nếu trước khi mở tutor mic đang bật. Đóng bằng nút đóng/Escape không tự mở mic.
- Thêm guard hủy recorder nếu yêu cầu bật mic hoàn tất sau khi rời màn hình.
- Mở rộng đúng hook dùng chung `frontend/hooks/use-speech-player.ts` để truyền AbortSignal tới TTS và chặn phát âm thanh tải muộn sau stop/unmount; không đổi speech-service hoặc provider giọng nói.
- Giữ nội dung giải thích khi TTS lỗi; nghe lại/mở lại cùng kết quả không gọi Gemini lần nữa. Render text qua React, không chèn HTML của mô hình.

### Kiểm thử và vị trí file

Thêm bốn test mới vào `frontend/test/` để Git nhận diện, thay vì thay `.gitignore` chung:

- `tutor-service.test.ts`
- `use-ai-tutor.test.tsx`
- `ai-tutor-panel.test.tsx`
- `use-speech-player.test.tsx`

Cập nhật fixture của hai test hiện có tại `frontend/tests/reading/reading-screen.test.tsx` và `reading-async-cleanup.test.tsx` cho phương thức explainWord. Thêm kiểm thử tích hợp chọn từ, không tạo transcript giả, mic chỉ khôi phục theo thao tác và hủy mic kích hoạt muộn.

Từ `frontend` đã chạy:

```powershell
npm run typecheck
npm run build
npm test
npm run lint
npm run format:check
.\node_modules\.bin\vitest.cmd run tests/reading test/tutor-service.test.ts test/use-ai-tutor.test.tsx test/ai-tutor-panel.test.tsx test/use-speech-player.test.tsx
```

| Kiểm tra                                 | Kết quả                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------- |
| TypeScript                               | Đạt, gồm kiểm tra lại sau khi chuyển test sang vị trí cuối cùng.                      |
| Production build                         | Đạt; chưa chạy ứng dụng tương tác hoặc gọi Gemini thật.                               |
| Test phần đọc/tutor tại vị trí cuối cùng | 8 file, 45 test đạt.                                                                  |
| ESLint riêng 12 file source/test phase 4 | Đạt.                                                                                  |
| Prettier riêng các file phase 4          | Đạt.                                                                                  |
| Toàn bộ unit/component frontend          | 443 test đạt, 14 test lỗi trong 4 file ngoài phạm vi tutor.                           |
| ESLint toàn frontend                     | Không đạt do 3 lỗi conditional React Hooks tại camera-preview.tsx; không sửa file đó. |
| Prettier toàn frontend                   | Còn 28 file cũ chưa đúng định dạng; không format lan các file đó.                     |

14 test lỗi toàn frontend gồm:

- `test/real-books-ui.test.tsx` và `tests/books/book-detail-screen.test.tsx`: mock next/navigation thiếu export useSearchParams, tổng 8 test.
- `tests/dashboard/dashboard-screen.test.tsx`: thiếu app router context/mock cho useRouter, 4 test.
- `test/real-page-match-service.test.ts`: response adapter hiện tại bỏ text/image_url so với kỳ vọng fixture, 2 test.

Các source camera, book detail, dashboard và page-match đã được đối chiếu với HEAD và không có thay đổi từ task tutor. Không đánh dấu kiểm tra toàn dự án là pass và không sửa các lỗi này trong phase 4.

### Giới hạn cần nghiệm thu / thống nhất trước khi mở rộng

- Vẫn thiếu key/model Gemini; chưa thử lời giải thích hoặc phát TTS thật. Chưa chạy E2E tutor hoặc đánh giá bộ ví dụ tiếng Việt ở phase 5.
- Luồng chọn trang thủ công hiện có gọi `ReadingContentService.get_page`, chỉ đọc/trả trang mới mà chưa lưu SelectedPageId/SelectedPageRevisionId vào phiên. Tutor vẫn kiểm tra đúng revision đang được phiên tham chiếu theo contract phase 1–3, nên có thể trả 409 sau khi đổi trang thủ công. Frontend không giả kết quả hoặc âm thầm nới quyền để che lỗi này.
- Việc đồng bộ lựa chọn trang cần được nhóm chốt phạm vi trước khi sửa backend/page-matching hiện có. Chưa thay đổi luồng đó trong phase 4.
- Khi thử bản đầu, dùng trang/revision khớp lựa chọn được lưu trong phiên; chọn từ rồi bấm “Giải thích từ”, “Nghe giải thích”, “Đọc tiếp”. Nếu backend chưa cấu hình Gemini thì UI thông báo chưa sẵn sàng và cho đọc tiếp.

Chưa commit/push, không tạo migration hoặc sửa dữ liệu Supabase thật. Bước tiếp theo là phase 5: nghiệm thu/E2E và chốt các giới hạn cần xử lý cùng nhóm.

## 16. Phase 5 — cập nhật nghiệm thu

Xem `AI_TUTOR_PHASE5.md` cho kết quả mới nhất. Các ghi chú thiếu key/model/dependency ở mục 13–15 mô tả thời điểm từng phase trước, không phải cấu hình hiện tại.

Đã cấu hình Gemini chỉ tại backend, thử 10 mẫu tiếng Việt lớp 1/lớp 5 và siết riêng prompt sau rà soát nội dung. Không thay code chọn trang hoặc authorization; giới hạn 409 khi trang thủ công chưa được lưu vào phiên vẫn cần thống nhất riêng. Chưa coi các lỗi test/lint/format toàn repository là đã sửa, chưa commit/push hoặc triển khai phase 6.

## 17. Phase 6 — bàn giao theo yêu cầu người dùng

Ghi chú ở mục 13–16 là lịch sử từng phase. Kết quả mới: người dùng đã test trên tài khoản/sách thật, phần Gemini trả 200; TTS chưa thành công vì hết hạn mức ElevenLabs, được giữ nguyên và công khai trong bàn giao. Ứng dụng được dừng trước phase 6; không thay dữ liệu từ agent.

Đã fetch origin để chốt main là base hiện tại, không có develop trên remote. Rà diff, kiểm tra tập trung và bổ sung runner test cô lập không dùng key thật từ dotenv. Chia commit theo backend, frontend, test/tài liệu; chỉ push nhánh feature và mở draft PR, không merge. Xem `AI_TUTOR_HANDOFF.md` cho cách chạy lại, kiểm tra, rủi ro conflict và các giới hạn release.
