import type { ZodType } from "zod";

import { readingManagementMessages } from "@/lib/api/reading-management-messages";
import { ServiceError, type ServiceErrorCode } from "@/lib/api/service-error";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { getApiBaseUrl } from "@/lib/supabase/config";

const safeMessage = "Có lỗi xảy ra. Vui lòng thử lại sau.";

// Only deliberately authored backend details are shown to users. Unknown server
// messages may contain SQL, tokens, file paths, or other private diagnostic data.
const safeBackendMessages: Record<string, string> = {
  "Copyright scanner is not configured. Admin must confirm rights before approving this book.":
    "Chưa có Copyright Detection tự động. Hãy xác nhận quyền sử dụng trước khi phê duyệt.",
  "Book approval requires current OCR, Proofreading and Child Safety results on every active page.":
    "Mỗi trang đang hoạt động cần có OCR, Proofreading và Child Safety hợp lệ trước khi duyệt sách.",
  "High severity or NOT_RECOMMENDED content is blocked by the current child access policy.":
    "Sách có cảnh báo HIGH hoặc NOT_RECOMMENDED đang bị chính sách trẻ em chặn.",
  "A page Safety result is stale or incomplete.":
    "Có trang chưa có kết quả Safety hiện hành. Hãy tải lại đánh giá và quét lại trang đó.",
  "A category is required for a false-positive decision.":
    "Hãy nhập category trước khi ghi nhận false positive.",
  "Resolve Child Safety findings and REVIEW_REQUIRED pages before approving this book.":
    "Cần xử lý các cảnh báo Child Safety và trang REVIEW_REQUIRED trước khi phê duyệt sách.",
  "Bạn đã gửi nhiều báo cáo trong thời gian ngắn. Vui lòng thử lại sau.":
    "Bạn đã gửi nhiều báo cáo trong thời gian ngắn. Vui lòng thử lại sau.",
  "Trang chưa có nội dung VERIFIED để lưu snapshot báo cáo.":
    "Trang chưa có nội dung VERIFIED để lưu snapshot báo cáo.",
  "Cần ghi chú xử lý khi giải quyết hoặc từ chối báo cáo.":
    "Cần ghi chú xử lý khi giải quyết hoặc từ chối báo cáo.",
  "Cần tạo và xác minh revision mới cho trang được báo lỗi trước khi giải quyết báo cáo.":
    "Cần tạo và xác minh revision mới cho trang được báo lỗi trước khi giải quyết báo cáo.",
  "Revision hiện tại chưa được xác minh; chưa thể giải quyết báo cáo.":
    "Revision hiện tại chưa được xác minh; chưa thể giải quyết báo cáo.",
  "Cần ghi chú khi mở lại báo cáo đã đóng.":
    "Cần ghi chú khi mở lại báo cáo đã đóng.",
  "Cần ghi lý do khi bỏ qua cảnh báo.": "Cần ghi lý do khi bỏ qua cảnh báo.",
  "Revision nguồn đã thay đổi; finding đã được chuyển sang STALE.":
    "Revision nguồn đã thay đổi; cảnh báo đã chuyển sang STALE.",
  "Chỉ đánh dấu đã sửa sau khi một revision VERIFIED mới được xuất bản.":
    "Chỉ đánh dấu đã sửa sau khi một revision VERIFIED mới được xác minh.",
  AI_AUTO_VERIFY_DISABLED:
    "Hệ thống đã tắt chế độ tự động xác minh AI. Admin cần trực tiếp rà soát và xác minh trang.",
  WORKFLOW_REQUIRED:
    "Cần hoàn tất quy trình AI Proofreading và kiểm tra an toàn trước khi xác minh trang.",
  WORKFLOW_REVISION_MISMATCH:
    "Workflow AI không thuộc về revision hiện tại của trang. Hãy tải lại trang.",
  WORKFLOW_NOT_FOUND: "Không tìm thấy workflow AI cho trang này.",
  IMAGE_REVISION_MISMATCH:
    "Ảnh trang đã thay đổi so với lúc chạy AI; hãy tải lại và chạy lại quy trình cho ảnh mới.",
  CANDIDATE_HASH_MISMATCH:
    "Nội dung đã thay đổi sau lần chạy AI; hãy lưu Candidate và đợi kiểm tra an toàn khớp hash mới.",
  WORKFLOW_NOT_READY:
    "Workflow AI chưa ở trạng thái sẵn sàng cho Admin xác minh.",
  TEXT_SAFETY_INCOMPLETE_CHUNKS:
    "Kiểm tra an toàn văn bản chưa hoàn tất đủ mọi đoạn (chunks). Hãy chạy lại kiểm tra an toàn.",
  TEXT_SAFETY_NOT_READY:
    "Kết quả kiểm tra an toàn văn bản chưa hoàn tất hoặc đã cũ (stale). Hãy quét lại an toàn.",
  TEXT_SAFETY_HIGH_RISK_BLOCKED:
    "Nội dung có cảnh báo mức HIGH hoặc NOT_RECOMMENDED cho trẻ em; hệ thống chặn xác minh.",
  IMAGE_SAFETY_UNASSESSED:
    "Chưa có AI kiểm tra hình ảnh; Admin bắt buộc xem ảnh và xác nhận an toàn hình ảnh trước khi xác minh.",
  IMAGE_SAFETY_FLAGGED_UNSAFE:
    "Hình ảnh trang đã bị Admin gắn cờ không phù hợp cho trẻ em; không thể xác minh.",
  IMAGE_SAFETY_STALE:
    "Xác nhận an toàn hình ảnh thuộc về ảnh cũ; hãy kiểm tra lại ảnh hiện tại trước khi xác minh.",
  IMAGE_SAFETY_REASON_REQUIRED:
    "Hãy ghi rõ lý do khi đánh dấu ảnh trang không phù hợp với trẻ em.",
  SAFETY_REVIEW_REASON_REQUIRED:
    "Hãy ghi lý do Admin xác nhận kết quả Safety có cảnh báo hoặc cần xem xét.",
  RIGHTS_EVIDENCE_REQUIRED:
    "Chưa có hồ sơ bằng chứng quyền sử dụng đầy đủ cho sách hoặc trang này. Hãy hoàn tất rà soát quyền sử dụng trước khi tiếp tục.",
  RIGHTS_CONCERN_BLOCKED:
    "Sách hoặc trang đang bị gắn cờ nghi ngại bản quyền / quyền sử dụng nên không thể xác minh hoặc phê duyệt.",
  RIGHTS_EVIDENCE_STALE:
    "Nội dung sách đã thay đổi sau lần rà soát quyền sử dụng trước đó; cần cập nhật hồ sơ quyền sử dụng.",
  RIGHTS_VERSION_MISMATCH:
    "Phiên bản hồ sơ quyền sử dụng đã thay đổi; hãy tải lại trang trước khi xác minh.",
  RIGHTS_EVIDENCE_INCOMPLETE:
    "Cần nhập đầy đủ nguồn tài liệu, cơ sở sử dụng và đường dẫn/mã bằng chứng trước khi đánh dấu Đã rà soát quyền sử dụng.",
  RIGHTS_CONCERN_NOTE_REQUIRED:
    "Cần ghi rõ lý do/mô tả nghi ngại bản quyền khi gắn cờ nghi ngại.",
  RIGHTS_PAGE_ID_REQUIRED:
    "Cần chỉ định trang khi lưu bằng chứng quyền ở phạm vi trang.",
  RIGHTS_BOOK_SCOPE_PAGE_FORBIDDEN:
    "Hồ sơ quyền phạm vi sách không được gắn mã trang cụ thể.",
  ...readingManagementMessages,
  INSUFFICIENT_CONTENT:
    "Cuốn sách này chưa có đủ câu đã xác minh cho lượt chơi. Bé có thể chọn sách hoặc độ khó khác nhé.",
  SESSION_NOT_ACTIVE:
    "Lượt chơi này đã kết thúc. Hãy bắt đầu một lượt mới nhé.",
  ROUND_NOT_ACTIVE:
    "Câu này đã được hoàn thành. Hãy tiếp tục với câu kế tiếp nhé.",
  ROUND_NOT_COMPLETE: "Hãy ghép xong câu hiện tại trước khi chuyển tiếp nhé.",
  TOKEN_ALREADY_USED: "Từ này đã được ghép rồi. Bé hãy chọn một từ khác nhé.",
  TOKEN_NOT_IN_SESSION:
    "Từ này không thuộc câu hiện tại. Hãy tải lại câu và thử lại nhé.",
  INVALID_IMAGE:
    "Ảnh tải lên chưa hợp lệ hoặc quá dung lượng 5 MB. Ba mẹ hãy chọn ảnh JPG, PNG hoặc WebP rõ nét nhé.",
  IMAGE_FILE_REQUIRED:
    "Ba mẹ hãy chọn một bức ảnh từ máy để ViRead phân tích nhé.",
  INVALID_SAMPLE:
    "Không tìm thấy bức tranh mẫu được chọn. Hãy thử chọn lại tranh nhé.",
  BOOK_PAGE_REQUIRED:
    "Hãy chọn một trang sách có tranh minh họa trước khi bắt đầu nhé.",
  UNSAFE_PICTURE:
    "Bức tranh này chưa phù hợp cho trẻ tiểu học. Ba mẹ hãy chọn một bức tranh thân thiện khác nhé.",
  AI_NOT_CONFIGURED: "Hệ thống chưa cấu hình kết nối AI mô tả tranh ở máy chủ.",
  AI_AUTH_FAILED:
    "Khóa kết nối AI ở máy chủ chưa hợp lệ. Hãy kiểm tra lại GEMINI_API_KEY.",
  AI_RATE_LIMITED:
    "Trợ lý AI đang bận một chút, ba mẹ và bé hãy đợi vài giây rồi thử lại nhé.",
  AI_TIMEOUT:
    "Trợ lý AI suy nghĩ hơi lâu một chút. Ba mẹ hãy nhấn thử lại nhé.",
  AI_UNAVAILABLE:
    "Chưa kết nối được trợ lý AI mô tả tranh lúc này. Hãy thử lại sau ít phút nhé.",
  SAMPLE_IMAGE_UNAVAILABLE: "Chưa tải được ảnh tranh mẫu từ máy chủ.",
  "Supabase Storage is not configured":
    "Backend chưa cấu hình SUPABASE_STORAGE_BUCKET trong file .env.",
  "Server-side Supabase Storage credentials are not configured":
    "Backend thiếu SUPABASE_SECRET_KEY hoặc SUPABASE_SERVICE_ROLE_KEY. Hãy cấu hình khóa chỉ ở môi trường Backend.",
  "Supabase Storage client initialization failed; check the server configuration":
    "Không khởi tạo được Supabase Storage. Hãy kiểm tra SUPABASE_URL và khóa server-side.",
  "Supabase Storage is unavailable":
    "Supabase Storage chưa sẵn sàng. Hãy kiểm tra cấu hình project và kết nối.",
  "Could not save the image to Supabase Storage":
    "Supabase Storage từ chối lưu ảnh. Hãy kiểm tra bucket có tồn tại trong đúng project và khóa server-side có quyền upload.",
  "Supabase Storage bucket was not found; verify SUPABASE_STORAGE_BUCKET in the configured project":
    "Không tìm thấy bucket trong Supabase project đang cấu hình. Hãy kiểm tra đúng tên bucket và SUPABASE_URL.",
  "Supabase Storage rejected the server credentials or upload permission":
    "Supabase Storage từ chối quyền ghi ảnh. Hãy kiểm tra server-side key và chính sách quyền của bucket.",
  "Tesseract OCR 5.x is not installed or TESSERACT_CMD is invalid":
    "Tiến trình Backend không tìm thấy Tesseract. Hãy kiểm tra TESSERACT_CMD hoặc PATH của Uvicorn.",
  "Tesseract language data vie.traineddata is missing":
    "Tesseract chưa tìm thấy dữ liệu tiếng Việt vie.traineddata.",
  "Tesseract is unavailable; install Tesseract 5.x and its language data":
    "Tiến trình Backend không chạy được Tesseract hoặc không đọc được dữ liệu ngôn ngữ.",
  "Tesseract failed to process the image with Vietnamese language data":
    "Tesseract gặp lỗi khi xử lý ảnh. Hãy kiểm tra Tesseract và vie.traineddata.",
  "OCR processing failed; check the local OCR configuration":
    "OCR thất bại ở bước xử lý nội bộ. Hãy xem log Backend để xác định giai đoạn xảy ra lỗi.",
  "No usable text was detected; check the image quality":
    "Không phát hiện được chữ trong ảnh. Hãy thử ảnh rõ nét, đủ sáng và đúng chiều.",
  "Local OCR engine is unavailable":
    "Bộ xử lý OCR cục bộ trên máy chủ hiện chưa sẵn sàng. Hãy kiểm tra dịch vụ backend rồi thử lại.",
  "Local OCR processing timed out; please retry":
    "OCR cục bộ xử lý quá thời gian cho phép. Ba mẹ hãy bấm Thử lại nhé.",
  "Unsupported upload format; use JPEG, PNG, or WebP":
    "Định dạng ảnh chưa hỗ trợ. Hãy chọn ảnh JPG, PNG hoặc WebP.",
  "Upload identity already belongs to a different image":
    "Mã gửi ảnh đã dùng cho một ảnh khác. Hãy chọn lại ảnh để quét mới.",
  "Could not read the image from Supabase Storage":
    "Không đọc được ảnh từ Supabase Storage. Hãy kiểm tra object path và quyền truy cập.",
  "Could not create an image preview URL":
    "Không tạo được URL xem trước ảnh từ Supabase Storage.",
  "Page has no revision yet":
    "Trang này chưa có revision nào. Hãy upload ảnh và chạy OCR cho trang ở sách.",
  "Page not found": "Không tìm thấy trang cần chỉnh sửa.",
  "Cannot edit a retired page":
    "Trang này đã ngừng sử dụng nên không thể tạo bản nháp mới.",
  "Page has no current verified revision":
    "Trang chưa có revision đã xác minh để tạo bản nháp.",
  "The verified revision changed; reload the page before creating a draft":
    "Revision đã xác minh vừa thay đổi. Hãy tải lại trang trước khi tạo bản nháp.",
  "A revision is already awaiting review; finish or reload it before creating another draft":
    "Đã có revision đang chờ duyệt. Hãy hoàn tất hoặc tải lại revision đó trước khi tạo bản nháp mới.",
  "Current verified revision is not available":
    "Không tìm thấy revision hiện hành đã xác minh.",
  "Current verified revision has no editable word data":
    "Revision hiện hành thiếu dữ liệu từ và tọa độ OCR để tạo bản nháp an toàn.",
  "Current verified text and word data are inconsistent":
    "Văn bản và dữ liệu từ OCR của revision hiện hành không khớp.",
  "Stored word coordinates cannot be copied safely":
    "Tọa độ OCR đã lưu không hợp lệ; hãy kiểm tra revision nguồn trước khi sửa.",
  "Stored OCR word ordering cannot be copied safely":
    "Thứ tự từ OCR đã lưu không hợp lệ; hãy kiểm tra revision nguồn trước khi sửa.",
  "Stored OCR confidence cannot be copied safely":
    "Độ tin cậy OCR đã lưu không hợp lệ; hãy kiểm tra revision nguồn trước khi sửa.",
  "A concurrent edit created this revision number; retry":
    "Một Admin khác vừa tạo revision. Hãy tải lại lịch sử rồi thử lại.",
  "A concurrent OCR revision was created; reload and retry":
    "Revision đã thay đổi trong lúc xử lý. Hãy tải lại trang rồi thử lại.",
  "Admin access required":
    "Tài khoản hiện tại không có quyền Admin để chỉnh sửa OCR.",
  "Stored bounding box does not match the OCR contract":
    "Tọa độ OCR đã lưu không hợp lệ; dữ liệu hiện tại được giữ nguyên.",
  "The source page image is unavailable for visual OCR verification.":
    "Không tìm thấy ảnh gốc để đối chiếu OCR; nội dung hiện tại được giữ nguyên.",
  "AI OCR chỉ chấp nhận địa chỉ HTTP loopback trên máy chủ.":
    "AI OCR chỉ kết nối tới Ollama cục bộ trên máy chủ.",
  "Cấu hình AI OCR cục bộ chưa hợp lệ.": "Cấu hình Ollama cục bộ chưa hợp lệ.",
  "AI OCR chỉ sử dụng địa chỉ HTTP loopback trên máy chủ.":
    "AI OCR chỉ kết nối tới Ollama cục bộ trên máy chủ.",
  "Ollama cục bộ chưa phản hồi.":
    "Ollama cục bộ chưa sẵn sàng. Hãy kiểm tra dịch vụ Ollama.",
  "Model AI OCR cục bộ chưa được cài đặt.":
    "Model AI OCR cục bộ chưa được cài đặt trong Ollama.",
  "Không thể kết nối tới Ollama cục bộ.":
    "Không thể kết nối tới Ollama trên máy chủ này.",
  "Ollama hoặc model OCR cục bộ chưa sẵn sàng; văn bản hiện tại được giữ nguyên.":
    "Ollama hoặc model OCR cục bộ chưa sẵn sàng. Văn bản hiện tại được giữ nguyên.",
  "Không thể kết nối Ollama trên máy này; văn bản hiện tại được giữ nguyên.":
    "Không thể kết nối tới Ollama cục bộ. Văn bản hiện tại được giữ nguyên.",
  "AI OCR cục bộ hết thời gian xử lý; văn bản hiện tại được giữ nguyên.":
    "AI OCR cục bộ hết thời gian xử lý. Văn bản hiện tại được giữ nguyên.",
  "AI OCR cục bộ vượt quá thời gian xử lý tối đa; văn bản hiện tại được giữ nguyên.":
    "AI OCR cục bộ vượt thời gian tối đa. Văn bản hiện tại được giữ nguyên.",
  "AI OCR đang xử lý quá nhiều yêu cầu. Hãy đợi tác vụ hiện tại hoàn tất rồi thử lại.":
    "Máy AI cục bộ đang bận. Hãy đợi một lúc rồi thử lại.",
  "AI OCR job not found":
    "Không tìm thấy tác vụ AI OCR hoặc tác vụ đã hết thời gian lưu.",
  "Model OCR cục bộ trả kết quả không đầy đủ hoặc sai cấu trúc; nội dung hiện tại được giữ nguyên.":
    "Model AI OCR trả kết quả không hợp lệ. Nội dung hiện tại được giữ nguyên.",
  "Draft text and OCR word data are inconsistent":
    "Văn bản nháp và danh sách từ OCR không khớp.",
  "Stored image reference is invalid":
    "Tham chiếu ảnh trong DB không hợp lệ với bucket hiện tại (thường là dữ liệu legacy).",
  "Image metadata does not match the admin contract":
    "Metadata ảnh của trang không khớp contract hiện tại.",
  "Page list contract is not available yet":
    "Danh sách trang chưa khớp contract hiện tại.",
  "Revision contract is not available yet":
    "Revision của trang chưa khớp contract hiện tại.",
  "Page contract is not available yet":
    "Dữ liệu revision của trang chưa khớp contract hiện tại.",
  "Page status contract is not available yet":
    "Trạng thái trang chưa khớp contract hiện tại.",
  "Revision number contract is not available yet":
    "Số revision trong DB chưa hợp lệ theo contract hiện tại.",
  "Book contract is not available yet":
    "Dữ liệu sách chưa khớp contract hiện tại.",
  "Catalog contract is not available yet":
    "Dữ liệu catalog chưa khớp contract hiện tại.",
  "The stored image is not a Storage object path":
    "ImagePath đã lưu không phải object path của Supabase Storage.",
  "OCR did not produce any valid word":
    "OCR không tạo ra từ hợp lệ nào. Ảnh có thể thiếu chữ hoặc quá mờ.",
  "OCR engine returned an invalid bounding box":
    "OCR trả về bounding box không hợp lệ.",
  "OCR engine returned a bounding box outside the image":
    "OCR trả về bounding box nằm ngoài phạm vi ảnh.",
  "This page number already exists for the book":
    "Số trang này đã tồn tại trong sách.",
  "Cannot upload pages to a retired book":
    "Không thể upload trang cho sách đã bị RETIRED.",
  "Book not found": "Không tìm thấy sách được yêu cầu.",
  "Only revisions with status NEEDS_REVIEW can be verified":
    "Chỉ revision ở trạng thái NEEDS_REVIEW mới có thể được xác minh.",
  "Only revisions with status NEEDS_REVIEW can be edited":
    "Chỉ revision ở NEEDS_REVIEW mới có thể được chỉnh sửa.",
  "Page has no revision to reprocess":
    "Trang chưa có revision để chạy lại OCR.",
  "Reprocess requires the latest revision; refresh the page history":
    "Chỉ có thể chạy lại OCR từ revision mới nhất. Hãy tải lại lịch sử trang.",
  "page_number is out of range":
    "Số trang vượt ngoài phạm vi hợp lệ (1-32767).",
  "Image decoding failed": "Không đọc được file ảnh gửi lên.",
  "Image dimensions are invalid": "Kích thước ảnh không hợp lệ.",
  "A file is required": "Hãy chọn tệp ảnh hoặc tài liệu để tải lên.",
  "Document exceeds the 50 MB limit":
    "Tệp tài liệu vượt quá giới hạn dung lượng 50 MB.",
  "Image exceeds the 12 MB limit":
    "Ảnh tải lên vượt quá giới hạn dung lượng 12 MB.",
  "Image dimensions must not exceed 6000 by 6000 pixels":
    "Kích thước ảnh vượt quá giới hạn 6000 × 6000 px.",
  "Document exceeds the 30-page limit per upload":
    "Mỗi tệp tài liệu chỉ hỗ trợ quét tối đa 30 trang. Hãy tách nhỏ tệp rồi tải lên lại.",
  "Password-protected PDF files are not supported":
    "Không hỗ trợ tệp PDF đặt mật khẩu. Hãy gỡ mật khẩu trước khi tải lên.",
  "Password-protected documents are not supported":
    "Không hỗ trợ tài liệu đặt mật khẩu. Hãy gỡ mật khẩu trước khi tải lên.",
  "Legacy .doc files are not supported; convert to .docx or .pdf":
    "Chưa hỗ trợ định dạng Word .doc cũ. Hãy lưu sang .docx hoặc .pdf rồi tải lên.",
  "Macro-enabled Word documents are not permitted":
    "Không cho phép tài liệu Word chứa macro (.docm) vì lý do bảo mật.",
  "Archive structure exceeds safe extraction limits":
    "Cấu trúc nén của tệp vượt ngưỡng an toàn.",
  "Document XML contains unsafe declarations":
    "Tệp DOCX chứa khai báo XML không an toàn nên đã bị từ chối.",
  "Unsupported upload format; use JPEG, PNG, WebP, BMP, TIFF, PDF, or DOCX":
    "Định dạng tệp chưa hỗ trợ. Hãy chọn JPEG, PNG, WebP, BMP, TIFF, PDF hoặc DOCX.",
  "File content does not match the declared file type or extension":
    "Nội dung thực tế của tệp không khớp với định dạng hoặc phần mở rộng.",
  "Weights file must end with .pth or .pt":
    "Tệp trọng số phải có định dạng .pth hoặc .pt.",
  "Checkpoint file magic bytes are invalid; expected PyTorch .pth/.pt format":
    "Tệp trọng số không hợp lệ hoặc bị hỏng; yêu cầu đúng định dạng PyTorch .pth/.pt.",
  "Checkpoint shard exceeds 40 MiB": "Mảnh tệp trọng số vượt quá 40 MiB.",
  "Comparison JSON file must be between 1 byte and 2 MiB":
    "Tệp JSON so sánh phải có dung lượng từ 1 byte đến 2 MiB.",
  "Comparison file must be valid UTF-8 JSON":
    "Tệp kết quả so sánh phải là định dạng JSON UTF-8 hợp lệ.",
  "Comparison JSON must be an object":
    "Tệp so sánh JSON phải là một đối tượng JSON hợp lệ.",
  "Comparison JSON missing 'models' object":
    "Tệp JSON thiếu thông tin 'models' đối chiếu.",
  "Comparison JSON must define 'baseline' and at least one fine-tuned model":
    "Tệp JSON phải định nghĩa model baseline và ít nhất một model fine-tuned.",
  "Comparison JSON must contain at least one dataset block with cer_pct and wer_pct":
    "Tệp JSON phải chứa ít nhất một tập kiểm thử có chỉ số CER và WER.",
  "Configuration file must have a .yml or .yaml extension":
    "Tệp cấu hình phải có đuôi .yml hoặc .yaml.",
  "Configuration file exceeds 1 MiB": "Tệp cấu hình vượt quá dung lượng 1 MiB.",
  "Configuration YAML syntax is invalid":
    "Cú pháp tệp YAML cấu hình không hợp lệ.",
  "Configuration YAML must be a non-empty mapping":
    "Tệp YAML cấu hình phải là một đối tượng cấu hình hợp lệ (dict).",
  "Checkpoint shard failed integrity verification":
    "Mảnh tệp trọng số không vượt qua bước kiểm tra toàn vẹn SHA-256.",
  "Checkpoint and configuration are identical to the currently active model":
    "Trọng số và cấu hình này giống hệt model đang hoạt động.",
  "The uploaded document is empty or corrupted":
    "Tệp tải lên bị rỗng hoặc bị hỏng không thể đọc được.",
  "No usable text was detected in the uploaded document":
    "Không phát hiện được chữ trong tài liệu tải lên. Hãy kiểm tra chất lượng bản scan hoặc nội dung tệp.",
  "Document upload failed to produce any valid OCR page":
    "Không tạo được trang OCR hợp lệ nào từ tài liệu này.",
  "Server Unicode font for DOCX rendering is unavailable":
    "Máy chủ thiếu font Unicode tiếng Việt để dựng trang DOCX.",
  "PDF rendering engine is not available on the server":
    "Máy chủ chưa sẵn sàng bộ dựng trang PDF.",
  DIFFICULT_WORD_PRACTICE_STORAGE_UNAVAILABLE:
    "Hệ thống lưu lịch sử luyện từ chưa được khởi tạo bảng dữ liệu trên máy chủ.",
  DIFFICULT_WORD_ATTEMPT_ALREADY_COMPLETED:
    "Lượt luyện từ này đã được ghi nhận trước đó. Con hãy bắt đầu lượt luyện mới nhé.",
  DIFFICULT_WORD_ATTEMPT_NOT_FOUND:
    "Không tìm thấy lượt luyện từ này trong hồ sơ của bé.",
  INVALID_PRACTICE_WORD: "Từ cần luyện chưa hợp lệ.",
  EMPTY_AUDIO: "Chưa nhận được âm thanh ghi âm. Con hãy thử nói lại nhé.",
  AUDIO_TOO_LARGE: "Đoạn ghi âm quá dài. Con hãy ghi âm ngắn gọn một từ nhé.",
  UNSUPPORTED_AUDIO: "Định dạng âm thanh chưa được hỗ trợ trên thiết bị này.",
  "Khóa idempotency không hợp lệ.": "Khóa yêu cầu tải lên không hợp lệ. Vui lòng thử lại.",
  "Loại nguồn sử dụng không hợp lệ.": "Loại nguồn sử dụng không hợp lệ.",
  "Sách riêng đang bị đình chỉ hoặc ngừng hoạt động nên không thể tải thêm trang.":
    "Sách riêng đang bị đình chỉ hoặc ngừng hoạt động nên không thể tải thêm trang.",
  "Sách riêng đang bị đình chỉ hoặc ngừng hoạt động.":
    "Sách riêng đang bị đình chỉ hoặc ngừng hoạt động.",
  "Phiên bản trang đã thay đổi. Hãy tải lại trước khi chấp nhận chính tả.":
    "Phiên bản trang đã thay đổi. Hãy tải lại trước khi chấp nhận chính tả.",
  "Bước rà chính tả chưa hoàn tất.": "Bước rà chính tả chưa hoàn tất.",
  "Không thể chỉnh sửa bản nộp đã hoàn tất hoặc đã hủy.":
    "Không thể chỉnh sửa bản nộp đã hoàn tất hoặc đã hủy.",
  "Phiên bản trang vừa thay đổi. Hãy tải lại.":
    "Phiên bản trang vừa thay đổi. Hãy tải lại dữ liệu.",
  "Khi thay ảnh cho một trang cụ thể, hãy chọn đúng 1 ảnh hoặc tài liệu 1 trang.":
    "Khi thay ảnh cho một trang cụ thể, hãy chọn đúng 1 ảnh hoặc tài liệu 1 trang.",
  "Chỉ có thể thử lại các trang đang ở trạng thái kiểm tra lỗi hoặc cần kiểm tra lại.":
    "Chỉ có thể thử lại các trang đang ở trạng thái kiểm tra lỗi hoặc cần kiểm tra lại.",
  "Không thể hủy trang đã thêm vào sách.": "Không thể hủy trang đã thêm vào sách.",
  "Phiên bản trang không khớp snapshot hiện tại. Hãy tải lại trước khi gửi Admin.":
    "Phiên bản trang đã thay đổi. Hãy tải lại trước khi gửi Admin.",
  "Chỉ trang đang ở trạng thái Cần Admin duyệt mới có thể gửi yêu cầu xem xét.":
    "Chỉ trang đang ở trạng thái Cần Admin duyệt mới có thể gửi yêu cầu xem xét.",
  "Phiên bản hoặc hash của trang không khớp kết quả kiểm tra hiện hành.":
    "Phiên bản trang đã thay đổi so với kết quả kiểm tra hiện hành. Hãy tải lại.",
  "Trang có nội dung vi phạm mức chặn theo chính sách an toàn trẻ em nên không thể thêm vào sách.":
    "Trang có nội dung vi phạm mức chặn theo chính sách an toàn trẻ em nên không thể thêm vào sách.",
  "Trang chưa hoàn tất sạch OCR, rà chính tả và Tool Check cho đúng phiên bản hiện tại.":
    "Trang chưa hoàn tất sạch OCR, rà chính tả và Tool Check cho đúng phiên bản hiện tại.",
  "Vui lòng xem và chấp nhận đề xuất chính tả trước khi thêm trang vào sách.":
    "Vui lòng xem và chấp nhận đề xuất chính tả trước khi thêm trang vào sách.",
  "Phê duyệt của Admin không khớp đúng phiên bản/hash hiện tại của trang.":
    "Phê duyệt của Admin không còn khớp với phiên bản hiện tại của trang.",
  "Không tìm thấy quyết định phê duyệt hợp lệ của Admin cho đúng phiên bản này.":
    "Chưa có quyết định phê duyệt hợp lệ của Admin cho phiên bản này.",
  "Trang đang chờ kiểm tra, bị gắn cờ hoặc chưa được Admin phê duyệt nên không thể thêm vào sách.":
    "Trang đang chờ kiểm tra, bị gắn cờ hoặc chưa được Admin phê duyệt nên không thể thêm vào sách.",
  "Phiên bản trang đã thay đổi hoặc vừa được Admin khác xử lý. Hãy tải lại dữ liệu trước khi quyết định.":
    "Phiên bản trang đã thay đổi hoặc vừa được Admin khác xử lý. Hãy tải lại trước khi quyết định.",
  "Không thể phê duyệt trang của sách đang bị đình chỉ.":
    "Không thể phê duyệt trang của sách đang bị đình chỉ.",
  "Nội dung vi phạm mức chặn theo chính sách an toàn trẻ em không thể duyệt trực tiếp; phải yêu cầu chỉnh sửa hoặc từ chối.":
    "Nội dung vi phạm mức chặn không thể duyệt bỏ qua; phải yêu cầu chỉnh sửa hoặc từ chối.",
  "Trang hiện không ở trạng thái chờ Admin phê duyệt.":
    "Trang hiện không ở trạng thái chờ Admin phê duyệt.",
  "Sách riêng đang bị đình chỉ hoặc không còn khả dụng.":
    "Sách riêng đang bị đình chỉ hoặc không còn khả dụng.",
};

function errorCode(status: number): ServiceErrorCode {
  switch (status) {
    case 401:
      return "AUTH_REQUIRED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "RESOURCE_NOT_FOUND";
    case 409:
      return "CONTENT_INACTIVE";
    case 422:
      return "VALIDATION_ERROR";
    default:
      return "NETWORK_ERROR";
  }
}

function failure(
  status: number,
  requestId = "",
  retryable = false,
  message = safeMessage,
) {
  return new ServiceError({
    code: errorCode(status),
    message,
    status,
    request_id: requestId,
    retryable,
  });
}

async function safeBackendMessage(response: Response): Promise<string> {
  try {
    const payload: unknown = await response.clone().json();
    if (
      typeof payload === "object" &&
      payload !== null &&
      "detail" in payload
    ) {
      if (typeof payload.detail === "string") {
        return safeBackendMessages[payload.detail] ?? safeMessage;
      }
      if (
        typeof payload.detail === "object" &&
        payload.detail !== null &&
        "code" in payload.detail &&
        typeof payload.detail.code === "string"
      ) {
        return safeBackendMessages[payload.detail.code] ?? safeMessage;
      }
    }
  } catch {
    // A non-JSON error body must not be reflected to the browser.
  }
  return safeMessage;
}

/** Only public DTOs validated by the supplied schema can reach a component. */
export interface RequestApiOptions {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly body?: unknown;
}

/**
 * Existing GET callers keep their signature; mutations pass RequestApiOptions as
 * argument four.
 */
export async function requestApi<T>(
  path: string,
  schema: ZodType<T>,
  signal?: AbortSignal,
  requestOptions: RequestApiOptions = {},
): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw failure(0);
  }

  let token: string;
  try {
    const supabase = createBrowserSupabaseClient();
    // Automatic initialization is disabled to let AuthServiceProvider subscribe
    // before initialization. Every API caller must therefore await restoration.
    const { error: initializationError } = await supabase.auth.initialize();
    if (initializationError) throw failure(401);

    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session?.access_token) throw failure(401);
    token = data.session.access_token;
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw failure(401);
  }

  let response: Response;
  const isFormDataBody =
    typeof FormData !== "undefined" && requestOptions.body instanceof FormData;
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
  };
  if (requestOptions.body !== undefined && !isFormDataBody) {
    headers["Content-Type"] = "application/json";
  }
  const body =
    requestOptions.body === undefined
      ? undefined
      : isFormDataBody
        ? requestOptions.body
        : JSON.stringify(requestOptions.body);
  try {
    response = await fetch(`${getApiBaseUrl()}${path}`, {
      method: requestOptions.method ?? "GET",
      headers,
      ...(body !== undefined ? { body: body as BodyInit } : {}),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw failure(0, "", true);
  }

  const requestId = response.headers.get("x-request-id") ?? "";
  if (!response.ok) {
    const backendMessage = await safeBackendMessage(response);
    const correlation =
      response.status >= 500 && requestId ? ` Mã yêu cầu: ${requestId}.` : "";
    throw failure(
      response.status,
      requestId,
      response.status >= 500,
      `${backendMessage}${correlation}`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw failure(response.status, requestId);
  }
  const parsed = schema.safeParse(payload);

  if (!parsed.success) {
    console.error("[API schema validation failed]", {
      issueCount: parsed.error.issues.length,
    });

    throw failure(response.status, requestId);
  }

  return parsed.data;
}

export function apiQuery(
  values: Readonly<Record<string, string | number | undefined>>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) query.set(key, String(value));
  }
  return query.size ? `?${query.toString()}` : "";
}

/**
 * Out-of-scope writes preserve their interface but never report fake success.
 */
export function unavailableOperation(): Promise<never> {
  return Promise.reject(
    new ServiceError({
      code: "NETWORK_ERROR",
      message: "Chức năng này chưa sẵn sàng.",
      status: 501,
      request_id: "",
      retryable: false,
    }),
  );
}

const activePrivateBlobUrls = new Set<string>();

export function isPrivateApiMediaUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return (
    url.includes("/books/my-books/") ||
    url.includes("/books/admin/quality/user-books/")
  );
}

export function clearPrivateMediaMemoryCache(): void {
  if (typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") {
    activePrivateBlobUrls.clear();
    return;
  }
  for (const blobUrl of activePrivateBlobUrls) {
    try {
      URL.revokeObjectURL(blobUrl);
    } catch {
      // Ignore already-revoked object URLs.
    }
  }
  activePrivateBlobUrls.clear();
}

export function revokePrivateBlobUrl(blobUrl: string | null | undefined): void {
  if (!blobUrl) return;
  activePrivateBlobUrls.delete(blobUrl);
  if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    try {
      URL.revokeObjectURL(blobUrl);
    } catch {
      // Ignore already-revoked URLs.
    }
  }
}

/**
 * Fetch an authenticated private image through the FastAPI media proxy using
 * the active Bearer session token and `cache: "no-store"`. Never persists to
 * browser storage or shared caches.
 */
export async function fetchAuthenticatedBlobUrl(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  let token: string;
  try {
    const supabase = createBrowserSupabaseClient();
    const { error: initError } = await supabase.auth.initialize();
    if (initError) throw failure(401);
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session?.access_token) throw failure(401);
    token = data.session.access_token;
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw failure(401);
  }

  const resolvedUrl = url.startsWith("/") ? `${getApiBaseUrl()}${url}` : url;
  const response = await fetch(resolvedUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    signal,
  });

  if (!response.ok) {
    throw failure(response.status);
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  activePrivateBlobUrls.add(objectUrl);
  return objectUrl;
}
