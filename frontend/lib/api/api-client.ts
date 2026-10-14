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

/** Existing GET callers keep their signature; mutations pass RequestApiOptions as argument four. */
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
    const { data, error } =
      await createBrowserSupabaseClient().auth.getSession();
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
  if (!parsed.success) throw failure(response.status, requestId);
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

/** Out-of-scope writes preserve their interface but never report fake success. */
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
