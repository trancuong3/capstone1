import type { ZodType } from "zod";

import { ServiceError, type ServiceErrorCode } from "@/lib/api/service-error";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { getApiBaseUrl } from "@/lib/supabase/config";

const safeMessage = "Có lỗi xảy ra. Vui lòng thử lại sau.";

// Only deliberately authored backend details are shown to users. Unknown server
// messages may contain SQL, tokens, file paths, or other private diagnostic data.
const safeBackendMessages: Record<string, string> = {
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
  "Chức năng sửa OCR bằng Gemini chưa được cấu hình.":
    "Gemini chưa được cấu hình ở Backend. Nội dung trang hiện tại được giữ nguyên.",
  "Cấu hình mô hình Gemini không hợp lệ.":
    "Mô hình Gemini đang cấu hình không hợp lệ. Hãy báo quản trị viên Backend.",
  "Cấu hình thời gian chờ Gemini không hợp lệ.":
    "Thời gian chờ Gemini đang cấu hình không hợp lệ.",
  "Cấu hình số lần thử lại Gemini không hợp lệ.":
    "Số lần thử lại Gemini đang cấu hình không hợp lệ.",
  "Không thể tải ảnh trang để đối chiếu OCR; văn bản hiện tại vẫn được giữ nguyên.":
    "Không thể tải ảnh gốc để đối chiếu. Văn bản và tọa độ hiện tại vẫn được giữ nguyên.",
  "Gemini đã hết hạn mức sử dụng; hãy kiểm tra quota và billing.":
    "Gemini đã hết hạn mức sử dụng. Hãy kiểm tra quota hoặc billing; nội dung hiện tại được giữ nguyên.",
  "Gemini đang giới hạn tốc độ; hãy thử lại sau.":
    "Gemini đang giới hạn tốc độ. Hãy chờ một lúc rồi thử lại.",
  "Gemini đang gặp sự cố tạm thời; hãy thử lại sau.":
    "Gemini đang gặp sự cố tạm thời. Hãy chờ một lúc rồi thử lại.",
  "Gemini từ chối yêu cầu; hãy kiểm tra cấu hình model.":
    "Gemini từ chối yêu cầu. Hãy báo quản trị viên kiểm tra model.",
  "Gemini API key không hợp lệ hoặc chưa được cấp quyền.":
    "Gemini API key không hợp lệ hoặc chưa có quyền sử dụng.",
  "Gemini đã chặn yêu cầu; văn bản OCR hiện tại vẫn được giữ nguyên.":
    "Gemini chặn yêu cầu. Văn bản và tọa độ hiện tại vẫn được giữ nguyên.",
  "Gemini không hoàn tất an toàn đoạn OCR; văn bản hiện tại vẫn được giữ nguyên.":
    "Gemini không hoàn tất việc kiểm tra an toàn. Văn bản và tọa độ hiện tại vẫn được giữ nguyên.",
  "Không thể xác thực một đoạn OCR; toàn bộ kết quả đã bị từ chối.":
    "Gemini trả về một đoạn không hợp lệ. Không có kết quả nào được áp dụng; hãy thử lại.",
  "Không thể kết nối Gemini sau số lần thử cho phép.":
    "Không thể kết nối Gemini sau nhiều lần thử. Nội dung hiện tại được giữ nguyên.",
  "Gemini trả về dữ liệu không hợp lệ; toàn bộ kết quả đã bị từ chối.":
    "Gemini trả về dữ liệu không hợp lệ. Nội dung hiện tại được giữ nguyên.",
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
      "detail" in payload &&
      typeof payload.detail === "string"
    ) {
      return safeBackendMessages[payload.detail] ?? safeMessage;
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
    console.error(
      `[API schema validation failed] ${requestOptions.method ?? "GET"} ${path}`,
      {
        issues: parsed.error.issues,
        response: payload,
      },
    );

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
