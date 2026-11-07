# Triển khai AI OCR cục bộ

## Trạng thái hiện tại

AI sửa OCR gọi Ollama ở loopback, không gọi provider AI cloud và không fallback cloud. Model mặc định vẫn là `qwen3-vl:4b-instruct-q4_K_M`; backend gửi ảnh crop cùng văn bản từng đoạn và kiểm tra số token trước khi ghép kết quả. Việc giữ nguyên số từ giúp bảo toàn bounding box, đồng thời có nghĩa model không tự sửa lỗi cần thêm, bớt, tách hoặc gộp từ.

Yêu cầu AI sửa mới chạy như job nền. Trạng thái, tiến độ, lỗi và kết quả được giữ trong RAM của **một process backend** tối đa một giờ; tối đa một job gọi Ollama đồng thời và tối đa bốn job đang chạy/chờ. Job bị mất khi process khởi động lại. Vì vậy cấu hình phù hợp hiện tại là một backend process, không scale ngang hoặc chạy nhiều worker. Nếu cần HA/scale nhiều instance, thay bộ quản lý RAM bằng queue/broker có xác thực và chính sách lưu trữ đã được duyệt; không ghi nội dung OCR vào database dùng chung.

Ảnh nguồn được đọc từ Storage sau khi admin đã xác thực; văn bản và ảnh chỉ được giữ tạm trong bộ nhớ lúc job chạy. Không có migration database cho job. Kết quả AI chỉ trở thành draft sau khi admin chọn áp dụng; việc lưu/xác minh draft vẫn là thao tác riêng.

## Host cần thiết

Ollama có thể chạy trên VM/host chạy liên tục với model nằm trên ổ đĩa persistent. Với CPU inference, dự án vẫn có thể chạy nhưng tốc độ phụ thuộc CPU và phải đo. GPU được ưu tiên nếu runtime/driver hỗ trợ. Dung lượng trên Ollama Library là dung lượng model tải về, không phải tổng RAM hoặc VRAM cần cho inference; context, projector ảnh, tiến trình backend và concurrent requests cần thêm bộ nhớ. Context lớn và số request song song làm tăng bộ nhớ sử dụng. Kiểm tra model được nạp trên phần cứng nào bằng `ollama ps`; Ollama cũng giữ model trong bộ nhớ trong một khoảng thời gian có thể cấu hình bằng `keep_alive`.

Trên máy khảo sát hiện tại, Windows báo GTX 1650 Max-Q khoảng 4 GB VRAM và Ollama chưa được cài. Model Qwen3-VL 4B Q4_K_M trên Ollama Library có file khoảng 3,3 GB. Phần VRAM còn lại không đủ để kết luận chắc chắn model chạy hoàn toàn trên GPU sau khi tính context/cache/projector. Không benchmark được tốc độ hoặc độ chính xác trên máy này trong lần thay đổi code. Không đề xuất 8B/9B cho máy này trước khi đo RAM/VRAM và offload thực tế.

Các kích thước hiện hành có thể thay đổi theo tag: Qwen3-VL 4B Q4_K_M khoảng 3,3 GB; Qwen3-VL 8B Q4_K_M khoảng 6,2 GB; Qwen3.5 4B Q4_K_M khoảng 3,3 GB; Qwen3.5 9B Q4_K_M khoảng 6,6 GB. Đây chỉ là dung lượng download; benchmark dữ liệu thật mới quyết định model nào phù hợp.

## Cấu hình an toàn

- Chạy backend và Ollama trên cùng VM/host để backend tiếp tục dùng `LOCAL_OCR_BASE_URL=http://127.0.0.1:11434`.
- Giữ Ollama bind ở `127.0.0.1`; không mở port `11434` ra public Internet. API local của Ollama không yêu cầu auth.
- Có thể tắt tính năng cloud của Ollama bằng `OLLAMA_NO_CLOUD=1` trong môi trường của process Ollama. Backend hiện chỉ gọi local URL và model local đã cài.
- Dùng ổ đĩa persistent cho thư mục models của Ollama. Không đưa model weights hoặc ảnh OCR vào repo/image của ứng dụng.
- Với backend hiện tại, chạy một worker/process. Ví dụ: `python -m uvicorn app.sever:app --host 127.0.0.1 --port 8000 --workers 1`.
- Cổng frontend dev mặc định là 3000 và backend là 8000; cấu hình `CORS_ALLOWED_ORIGINS` theo đúng origin frontend khi deploy.
- Nếu backend/Ollama nằm ở hai container, `localhost` trong container backend trỏ vào chính backend. Code hiện vẫn từ chối host khác loopback; chưa bật private-network allowlist cho container. Không đổi thành `0.0.0.0` để khắc phục.

Ollama dùng 4K context mặc định theo tài liệu hiện hành; dự án truyền `LOCAL_OCR_NUM_CTX=4096`. Tăng context không tự làm kết quả chính xác hơn và sẽ tăng bộ nhớ. Ollama xếp hàng request nếu thiếu bộ nhớ; số request song song cũng làm tăng nhu cầu RAM/VRAM. Giữ concurrency bằng một cho đến khi có benchmark trên phần cứng triển khai.

## Cài đặt và vận hành local

Trên Windows, từ repo root, script hiện có tạo môi trường backend/frontend, cài Tesseract và Vietnamese tessdata đã ghim, cài Ollama tương thích và tải model mặc định:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned
.\requirements.ps1
```

Script tải Ollama installer và model vài GB trong lần đầu, cần Internet và dung lượng đĩa phù hợp. Lệnh `requirements.ps1 -CheckOnly` kiểm tra trạng thái mà không cài dependencies. Không chạy script này trên host production thay vì quy trình deploy có versioning/secret management.

Sau khi Ollama đã cài, kiểm tra:

```powershell
ollama --version
ollama list
ollama ps
Invoke-RestMethod http://127.0.0.1:11434/api/tags
```

Health screen Admin hiển thị model tag đang cấu hình và trạng thái probe cục bộ. Không có Ollama/model thì job thất bại an toàn, giữ nguyên draft.

### Chạy local với frontend 3000 và backend 8001

Mở hai cửa sổ PowerShell từ repo root. Backend phải cho phép đúng origin `http://localhost:3000` và `http://127.0.0.1:3000`; frontend phải gọi đúng API đang chạy ở cổng `8001`:

```powershell
# Cửa sổ 1: backend
Set-Location .\backend
$env:CORS_ALLOWED_ORIGINS = 'http://localhost:3000,http://127.0.0.1:3000'
python -m uvicorn app.sever:app --host 127.0.0.1 --port 8001 --reload
```

```powershell
# Cửa sổ 2: frontend
Set-Location .\frontend
$env:NEXT_PUBLIC_API_URL = 'http://127.0.0.1:8001'
npm run dev
```

Mở `http://localhost:3000`. Đặt biến trong chính cửa sổ khởi chạy để cấu hình của process ghi đè giá trị cũ trong `.env.local` mà không sửa tệp riêng của máy. `npm run dev` truyền rõ `--port 3000`; nếu cổng này đang bận, Next.js báo lỗi khởi động thay vì âm thầm chuyển sang cổng khác. Hãy xác định chủ sở hữu cổng trước khi dừng bất kỳ process nào.

## Benchmark trên bộ dữ liệu riêng

Không có benchmark dự án đủ đại diện nếu chưa cung cấp ground truth tiếng Việt đã được người kiểm tra xác nhận. Tạo JSONL cục bộ, một record cho mỗi trang, với ảnh và bbox đã chuẩn hóa đúng thứ tự token:

```json
{"image":"images/page-001.png","ocr_text":"ngay xua co be.","ground_truth":"Ngày xưa có bé.","boxes":[[0.1,0.2,0.1,0.04],[0.22,0.2,0.12,0.04],[0.35,0.2,0.08,0.04],[0.44,0.2,0.06,0.04]]}
```

Giữ dataset/ảnh ngoài Git và không dùng dữ liệu cá nhân nếu chưa được phép. Script dưới đây chỉ dùng model đã cài ở Ollama loopback; script **không tải model** và chỉ in/lưu aggregate metrics, không ghi nội dung OCR hay ground truth:

```powershell
$env:LOCAL_OCR_MODEL = 'qwen3-vl:4b-instruct-q4_K_M'
python .\scripts\benchmark_local_ocr.py 'D:\ocr-eval\pages.jsonl'

$env:LOCAL_OCR_MODEL = 'qwen3.5:4b-q4_K_M'
python .\scripts\benchmark_local_ocr.py 'D:\ocr-eval\pages.jsonl'

$env:LOCAL_OCR_MODEL = 'qwen3-vl:8b-instruct-q4_K_M'
python .\scripts\benchmark_local_ocr.py 'D:\ocr-eval\pages.jsonl'
```

Ứng viên chưa được tải/cài sẽ trả lỗi kết nối/model unavailable; hãy chỉ tải model phù hợp khi đã kiểm tra phần cứng và dung lượng. So sánh cùng dataset, cùng prompt, context, nhiệt độ và host. Đọc `exact_match_rate`, CER, WER, số thay đổi có ích/có hại, thời gian case đầu, p50/p95 và lỗi. Chạy lặp lại để tách cold start với warm inference. Không chọn model mới nếu tăng tỷ lệ sửa sai hoặc thời gian vượt ngưỡng của host. Script chưa đo điện năng, CPU/GPU utilization hay VRAM; dùng công cụ giám sát của host cùng `ollama ps` cho các số liệu đó.

## Giới hạn đang biết

- Job manager chỉ lưu trong RAM, chịu giới hạn một worker/process và không khôi phục sau restart.
- Hủy job là best effort: backend hủy coroutine/request; thời gian model thực sự dừng phụ thuộc runtime Ollama.
- API job cần tiếp tục cùng instance backend trong suốt thời gian polling.
- Chưa có dữ liệu ground truth dự án và chưa benchmark model mới; model mặc định không được tự đổi.
- Bbox được giữ nguyên; lỗi cần thay đổi cấu trúc token vẫn cần OCR/tái căn chỉnh riêng hoặc admin sửa thủ công.
- Không chốt được cấu hình host/cost vì chưa có nhà cung cấp, OS, RAM, GPU/VRAM, số admin đồng thời và ngân sách mục tiêu.
