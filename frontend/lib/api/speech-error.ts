import { ServiceError, type ServiceErrorCode } from "@/lib/api/service-error";

export type SpeechCapability = "STT_UNAVAILABLE" | "TTS_UNAVAILABLE";

const DEFAULT_SPEECH_MESSAGE =
  "Chức năng giọng nói đang tạm chưa sẵn sàng qua mạng. Ba mẹ và bé vui lòng thử lại nhé.";

export function isTimeoutError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "TimeoutError"
  );
}

export async function extractSpeechProviderCode(
  response: Response,
): Promise<string | undefined> {
  try {
    const payload: unknown = await response.clone().json();
    if (typeof payload !== "object" || payload === null) {
      return undefined;
    }
    if (
      "detail" in payload &&
      typeof payload.detail === "object" &&
      payload.detail !== null &&
      "code" in payload.detail &&
      typeof payload.detail.code === "string"
    ) {
      return payload.detail.code;
    }
    if ("code" in payload && typeof payload.code === "string") {
      return payload.code;
    }
  } catch {
    // Non-JSON error bodies must not be reflected to the UI.
  }
  return undefined;
}

function appendRequestCorrelation(message: string, requestId: string): string {
  const trimmed = requestId.trim();
  if (!trimmed || message.includes(trimmed)) {
    return message;
  }
  return `${message} Mã yêu cầu: ${trimmed}.`;
}

export function buildSpeechServiceError(params: {
  capability: SpeechCapability;
  status: number;
  requestId?: string;
  retryable?: boolean;
  providerCode?: string;
}): ServiceError {
  const { capability, status, requestId = "", providerCode } = params;
  let code: ServiceErrorCode = capability;
  let message = DEFAULT_SPEECH_MESSAGE;
  let retryable = params.retryable ?? (status === 0 || status === 429 || status >= 500);

  if (capability === "STT_UNAVAILABLE") {
    switch (providerCode) {
      case "STT_QUOTA_EXCEEDED":
      case "GOOGLE_STT_QUOTA_EXCEEDED":
        code = "STT_QUOTA_EXCEEDED";
        message =
          "Dịch vụ nhận diện dự phòng tạm hết hạn mức. Ba mẹ vui lòng thử lại sau nhé.";
        retryable = false;
        break;
      case "STT_AUTH_FAILED":
      case "GOOGLE_STT_AUTH_ERROR":
        code = "STT_AUTH_FAILED";
        message =
          "Không xác thực được dịch vụ nghe đọc lúc này. Ba mẹ vui lòng thử lại sau nhé.";
        retryable = false;
        break;
      case "STT_PERMISSION_DENIED":
        code = "STT_PERMISSION_DENIED";
        message =
          "Dịch vụ nghe đọc chưa được cấp quyền truy cập lúc này.";
        retryable = false;
        break;
      case "STT_TERMS_NOT_ACCEPTED":
        code = "STT_TERMS_NOT_ACCEPTED";
        message =
          "Dịch vụ nhận diện giọng nói cần được kích hoạt điều khoản trước khi sử dụng.";
        retryable = false;
        break;
      case "STT_CONCURRENCY_LIMITED":
      case "LOCAL_STT_BUSY":
        code = "STT_CONCURRENCY_LIMITED";
        message =
          "Máy chủ giọng nói đang bận xử lý. Bé chờ ít giây rồi đọc lại nhé.";
        retryable = true;
        break;
      case "STT_TEMPORARILY_UNAVAILABLE":
      case "LOCAL_STT_UNAVAILABLE":
        code = "STT_TEMPORARILY_UNAVAILABLE";
        message =
          "Dịch vụ nghe đọc đang tạm dừng hoặc khởi động. Bé bấm Thử lại hoặc tiếp tục sau nhé.";
        retryable = true;
        break;
      case "GOOGLE_STT_UNAVAILABLE":
        code = "STT_TEMPORARILY_UNAVAILABLE";
        message =
          "Dịch vụ nghe đọc dự phòng tạm chưa sẵn sàng. Bé bấm Thử lại sau ít giây nhé.";
        retryable = true;
        break;
      case "STT_TIMEOUT":
      case "LOCAL_STT_TIMEOUT":
      case "GOOGLE_STT_TIMEOUT":
        code = "STT_TIMEOUT";
        message =
          "Nghe giọng bé quá thời gian chờ do mạng chậm. Bé bấm Thử lại và đọc rõ từng từ nhé.";
        retryable = true;
        break;
      case "STT_NETWORK_ERROR":
        code = "STT_NETWORK_ERROR";
        message =
          "Mất kết nối khi gửi giọng đọc của bé. Ba mẹ kiểm tra mạng rồi bấm Thử lại nhé.";
        retryable = true;
        break;
      case "STT_RATE_LIMITED":
      case "GOOGLE_STT_COOLDOWN":
        code = "STT_RATE_LIMITED";
        message =
          "Dịch vụ nghe đọc đang tạm giới hạn tần suất. Bé chờ vài giây rồi thử lại nhé.";
        retryable = true;
        break;
      case "STT_INVALID_AUDIO":
      case "INVALID_AUDIO":
        code = "STT_INVALID_AUDIO";
        message =
          "Chưa thu rõ âm thanh vừa rồi. Bé ghé gần micro và đọc lại nhé.";
        retryable = false;
        break;
      case "STT_PROVIDER_REJECTED":
      case "GOOGLE_STT_REJECTED":
        code = "STT_PROVIDER_REJECTED";
        message =
          "Chưa nhận diện rõ đoạn âm thanh vừa thu. Bé đọc chậm và rõ hơn một chút nhé.";
        retryable = false;
        break;
      default:
        if (status === 401) {
          code = "AUTH_REQUIRED";
          message = "Phiên đăng nhập đã hết hạn. Ba mẹ vui lòng đăng nhập lại nhé.";
          retryable = false;
        } else if (status === 403) {
          code = "FORBIDDEN";
          message = "Tài khoản chưa có quyền dùng tính năng nghe đọc lúc này.";
          retryable = false;
        } else if (status === 422) {
          code = "VALIDATION_ERROR";
          message = "Dữ liệu âm thanh chưa hợp lệ. Bé thử đọc lại nhé.";
          retryable = false;
        } else if (status === 0) {
          code = "STT_NETWORK_ERROR";
          message =
            "Không kết nối được tới dịch vụ nghe đọc qua mạng. Bé giữ nguyên vị trí và bấm Thử lại nhé.";
          retryable = true;
        }
    }
  } else {
    switch (providerCode) {
      case "LOCAL_TTS_UNAVAILABLE":
        code = "TTS_UNAVAILABLE";
        message =
          "Giọng đọc mẫu đang tạm dừng hoặc đang khởi động. Bé có thể bấm Thử lại hoặc tự đọc tiếp nhé.";
        retryable = true;
        break;
      case "LOCAL_TTS_TIMEOUT":
      case "TTS_TIMEOUT":
      case "GOOGLE_TTS_TIMEOUT":
        code = "TTS_UNAVAILABLE";
        message =
          "Tải giọng đọc mẫu quá thời gian chờ do mạng chậm. Bé bấm Thử lại hoặc tự đọc tiếp nhé.";
        retryable = true;
        break;
      case "LOCAL_TTS_BUSY":
      case "TTS_CONCURRENCY_LIMITED":
        code = "TTS_UNAVAILABLE";
        message =
          "Giọng đọc mẫu đang bận phục vụ nhiều yêu cầu. Bé chờ ít giây rồi thử lại nhé.";
        retryable = true;
        break;
      case "GOOGLE_TTS_UNAVAILABLE":
      case "GOOGLE_TTS_COOLDOWN":
      case "GOOGLE_TTS_RATE_LIMITED":
        code = "TTS_UNAVAILABLE";
        message =
          "Giọng đọc mẫu dự phòng đang tạm bận. Bé thử lại sau ít giây hoặc tự đọc tiếp nhé.";
        retryable = true;
        break;
      case "GOOGLE_TTS_QUOTA_EXCEEDED":
      case "GOOGLE_TTS_AUTH_ERROR":
      case "GOOGLE_TTS_REJECTED":
        code = "TTS_UNAVAILABLE";
        message =
          "Dịch vụ đọc mẫu đang tạm gián đoạn. Bé có thể tự đọc tiếp nhé.";
        retryable = false;
        break;
      default:
        if (status === 401) {
          code = "AUTH_REQUIRED";
          message = "Phiên đăng nhập đã hết hạn. Ba mẹ vui lòng đăng nhập lại nhé.";
          retryable = false;
        } else if (status === 403) {
          code = "FORBIDDEN";
          message = "Tài khoản chưa có quyền dùng giọng đọc mẫu lúc này.";
          retryable = false;
        } else if (status === 422) {
          code = "VALIDATION_ERROR";
          message = "Nội dung cần đọc mẫu chưa hợp lệ.";
          retryable = false;
        } else if (status === 0) {
          message =
            "Không kết nối được tới giọng đọc mẫu qua mạng. Bé bấm Thử lại hoặc tự đọc tiếp nhé.";
          retryable = true;
        } else {
          message =
            "Giọng đọc mẫu đang tạm chưa sẵn sàng. Bé bấm Thử lại hoặc tự đọc tiếp nhé.";
        }
    }
  }

  return new ServiceError({
    code,
    message: appendRequestCorrelation(message, requestId),
    status,
    request_id: requestId,
    retryable,
  });
}
