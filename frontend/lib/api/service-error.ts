export type ServiceErrorCode =
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "RESOURCE_NOT_FOUND"
  | "VALIDATION_ERROR"
  | "CONTENT_INACTIVE"
  | "OCR_REPROCESS_INVALID_STATE"
  | "INVALID_UPLOAD"
  | "SESSION_STATE_INVALID"
  | "SESSION_TOKEN_INVALID"
  | "SESSION_TOKEN_EXPIRED"
  | "PAGE_CONFIDENCE_LOW"
  | "PAGE_NOT_IN_SESSION_BOOK"
  | "PAGE_NOT_VERIFIED"
  | "STT_UNAVAILABLE"
  | "TTS_UNAVAILABLE"
  | "WEBSOCKET_PROTOCOL_ERROR";

export interface ServiceErrorOptions {
  code: ServiceErrorCode;
  message: string;
  status: number;
  request_id: string;
  retryable: boolean;
}

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  readonly status: number;
  readonly request_id: string;
  readonly retryable: boolean;

  constructor(options: ServiceErrorOptions) {
    super(options.message);
    this.name = "ServiceError";
    this.code = options.code;
    this.status = options.status;
    this.request_id = options.request_id;
    this.retryable = options.retryable;
  }
}

export function isServiceError(error: unknown): error is ServiceError {
  return error instanceof ServiceError;
}
