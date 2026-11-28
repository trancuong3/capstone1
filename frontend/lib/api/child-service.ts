import { z, type ZodType } from "zod";

import type {
  ChildProfileCreateDTO,
  ChildProfileDTO,
  ChildProfilePatchDTO,
} from "@/types/child";
import {
  getBrowserAccessToken,
  invalidateBrowserTokenCache,
} from "@/lib/api/browser-auth";
import {
  invalidateApiReadCache,
  runCoalescedApiGet,
} from "@/lib/api/read-cache";
import {
  COLD_START_RETRY_DELAY_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_UPLOAD_TIMEOUT_MS,
  cancelResponseBodyQuietly,
  createLinkedAttemptController,
  delayWithSignal,
  getAbortReason,
  isAbortOrTimeoutError,
  raceWithSignal,
  shouldRetryColdStartResponse,
  type LinkedAttemptHandle,
} from "@/lib/api/cold-start-retry";
import { ServiceError, type ServiceErrorCode } from "@/lib/api/service-error";
import { clearUserCache } from "@/lib/cache/user-query-cache";
import { translateRuntime } from "@/lib/i18n/runtime";
import { getApiBaseUrl } from "@/lib/supabase/config";

export interface ChildService {
  list(signal?: AbortSignal): Promise<ChildProfileDTO[]>;
  create(request: ChildProfileCreateDTO): Promise<ChildProfileDTO>;
  get(childId: string, signal?: AbortSignal): Promise<ChildProfileDTO>;
  update(
    childId: string,
    request: ChildProfilePatchDTO,
  ): Promise<ChildProfileDTO>;
  uploadAvatar(childId: string, file: File): Promise<ChildProfileDTO>;
  removeAvatar(childId: string): Promise<ChildProfileDTO>;
  delete(childId: string): Promise<void>;
}

const DEFAULT_CHILD_ERROR_MESSAGE =
  "Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.";

// Only deliberately authored backend codes/details may map to user-facing copy.
const SAFE_CHILD_BACKEND_MESSAGES: Readonly<Record<string, string>> = {
  "Unsupported upload format; use JPEG, PNG, or WebP":
    "Định dạng ảnh chưa hỗ trợ. Ba mẹ hãy chọn ảnh PNG, JPG hoặc WEBP nhé.",
  "Image exceeds the 12 MB limit":
    "Ảnh tải lên vượt quá giới hạn dung lượng cho phép.",
  "Image decoding failed": "Không đọc được tệp ảnh tải lên. Hãy chọn ảnh khác.",
  "Image dimensions are invalid": "Kích thước ảnh đại diện chưa hợp lệ.",
  INVALID_IMAGE:
    "Ảnh tải lên chưa hợp lệ. Ba mẹ hãy chọn ảnh PNG, JPG hoặc WEBP nhé.",
  DATABASE_OPERATION_FAILED:
    "Hệ thống dữ liệu đang gặp sự cố tạm thời. Ba mẹ vui lòng thử lại sau.",
  AUTH_PROVIDER_UNAVAILABLE:
    "Dịch vụ xác thực đang tạm thời gián đoạn. Ba mẹ vui lòng thử lại sau.",
};

const childProfileSchema = z.object({
  id: z.string().min(1),
  parent_id: z.string().min(1),
  alias: z.string(),
  grade: z.number().int(),
  settings: z.record(z.string(), z.unknown()).optional().default({}),
  created_at: z.string(),
  avatar_url: z.string().nullable().optional(),
});

const childProfileListSchema = z.array(childProfileSchema);

function mapErrorCode(status: number): ServiceErrorCode {
  if (status === 401) {
    return "AUTH_REQUIRED";
  }

  if (status === 403) {
    return "FORBIDDEN";
  }

  if (status === 404) {
    return "RESOURCE_NOT_FOUND";
  }

  if (status === 422) {
    return "VALIDATION_ERROR";
  }

  return "NETWORK_ERROR";
}

function safeStatusMessage(status: number): string {
  switch (status) {
    case 401:
      return "Phiên đăng nhập đã hết hạn. Ba mẹ vui lòng đăng nhập lại.";
    case 403:
      return "Ba mẹ không có quyền thực hiện thao tác trên hồ sơ bé này.";
    case 404:
      return "Không tìm thấy hồ sơ bé được yêu cầu.";
    case 422:
      return "Thông tin hồ sơ bé chưa hợp lệ. Ba mẹ vui lòng kiểm tra lại.";
    default:
      return DEFAULT_CHILD_ERROR_MESSAGE;
  }
}

async function resolveSafeErrorMessage(
  response: Response,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) {
    throw getAbortReason(signal);
  }
  try {
    const jsonPromise = response.clone().json();
    const payload: unknown = signal
      ? await raceWithSignal(jsonPromise, signal)
      : await jsonPromise;
    if (typeof payload === "object" && payload !== null) {
      if ("detail" in payload) {
        if (typeof payload.detail === "string") {
          const translated = SAFE_CHILD_BACKEND_MESSAGES[payload.detail];
          if (translated) return translated;
        } else if (
          typeof payload.detail === "object" &&
          payload.detail !== null &&
          "code" in payload.detail &&
          typeof payload.detail.code === "string"
        ) {
          const translated = SAFE_CHILD_BACKEND_MESSAGES[payload.detail.code];
          if (translated) return translated;
        }
      }
      if ("code" in payload && typeof payload.code === "string") {
        const translated = SAFE_CHILD_BACKEND_MESSAGES[payload.code];
        if (translated) return translated;
      }
    }
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    // Non-JSON error bodies must never be reflected to the UI.
  }

  return safeStatusMessage(response.status);
}

async function createHttpError(
  response: Response,
  signal?: AbortSignal,
): Promise<ServiceError> {
  const message = await resolveSafeErrorMessage(response, signal);
  return new ServiceError({
    code: mapErrorCode(response.status),
    message,
    status: response.status,
    request_id: response.headers.get("x-request-id") ?? "",
    retryable: response.status >= 500,
  });
}

function unauthorizedError(): ServiceError {
  return new ServiceError({
    code: "AUTH_REQUIRED",
    message: "Authentication required.",
    status: 401,
    request_id: "",
    retryable: false,
  });
}

async function resolveChildAccessToken(signal?: AbortSignal): Promise<string> {
  return getBrowserAccessToken({
    signal,
    onUnauthorized: unauthorizedError,
  });
}

async function request<T>(
  path: string,
  schema: ZodType<T> | null,
  init?: RequestInit,
): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new ServiceError({
      code: "NETWORK_ERROR",
      message: DEFAULT_CHILD_ERROR_MESSAGE,
      status: 0,
      request_id: "",
      retryable: false,
    });
  }
  if (init?.signal?.aborted) {
    throw getAbortReason(init.signal);
  }

  const method = (init?.method ?? "GET").toUpperCase();
  const isFormDataBody =
    typeof FormData !== "undefined" && init?.body instanceof FormData;
  const effectiveTimeoutMs = isFormDataBody
    ? DEFAULT_UPLOAD_TIMEOUT_MS
    : DEFAULT_REQUEST_TIMEOUT_MS;
  const deadlineAt = Date.now() + effectiveTimeoutMs;
  const canColdStartRetry = method === "GET";
  const maxAttempts = canColdStartRetry ? 2 : 1;

  let token: string;
  const authHandle = createLinkedAttemptController(
    effectiveTimeoutMs,
    init?.signal ?? undefined,
  );
  try {
    token = await resolveChildAccessToken(authHandle.signal);
  } catch (error) {
    if (init?.signal?.aborted && !authHandle.didTimeout()) {
      throw getAbortReason(init.signal);
    }
    if (authHandle.didTimeout()) {
      throw new ServiceError({
        code: "NETWORK_ERROR",
        message: translateRuntime("errors.clientRuntime.genericParentRetry"),
        status: 0,
        request_id: "",
        retryable: true,
      });
    }
    if (error instanceof ServiceError) {
      throw error;
    }
    if (isAbortOrTimeoutError(error)) {
      throw error;
    }

    throw unauthorizedError();
  } finally {
    authHandle.cleanup();
  }

  const execute = async (signal?: AbortSignal): Promise<T> => {
    const headers = new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    });
    if (typeof init?.body === "string") {
      headers.set("Content-Type", "application/json");
    }

    const parentSignal = signal ?? init?.signal ?? undefined;
    let response!: Response;
    let activeAttemptHandle: LinkedAttemptHandle | null = null;

    try {
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (parentSignal?.aborted) {
          throw getAbortReason(parentSignal);
        }
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) {
          if (parentSignal?.aborted) {
            throw getAbortReason(parentSignal);
          }
          throw new ServiceError({
            code: "NETWORK_ERROR",
            message: translateRuntime(
              "errors.clientRuntime.genericParentRetry",
            ),
            status: 0,
            request_id: "",
            retryable: true,
          });
        }

        const attemptHandle = createLinkedAttemptController(
          remainingMs,
          parentSignal,
        );

        try {
          response = await raceWithSignal(
            fetch(`${getApiBaseUrl()}${path}`, {
              ...init,
              headers: {
                ...Object.fromEntries(headers.entries()),
                ...(init?.headers ?? {}),
              },
              cache: "no-store",
              credentials: "omit",
              redirect: "error",
              signal: attemptHandle.signal,
            }),
            attemptHandle.signal,
          );
        } catch (error) {
          const timedOut = attemptHandle.didTimeout();
          attemptHandle.cleanup();
          if (parentSignal?.aborted && !timedOut) throw error;
          if (
            attempt === 0 &&
            canColdStartRetry &&
            !timedOut &&
            !parentSignal?.aborted &&
            deadlineAt - Date.now() > COLD_START_RETRY_DELAY_MS
          ) {
            await delayWithSignal(COLD_START_RETRY_DELAY_MS, parentSignal);
            continue;
          }
          throw new ServiceError({
            code: "NETWORK_ERROR",
            message: translateRuntime(
              "errors.clientRuntime.genericParentRetry",
            ),
            status: 0,
            request_id: "",
            retryable: true,
          });
        }

        let shouldRetry = false;
        if (attempt === 0 && canColdStartRetry && !parentSignal?.aborted) {
          try {
            shouldRetry =
              (await shouldRetryColdStartResponse(
                response,
                (detail) => Boolean(SAFE_CHILD_BACKEND_MESSAGES[detail]),
                attemptHandle.signal,
              )) && deadlineAt - Date.now() > COLD_START_RETRY_DELAY_MS;
          } catch (error) {
            const timedOut = attemptHandle.didTimeout();
            attemptHandle.cleanup();
            if (parentSignal?.aborted && !timedOut) {
              throw getAbortReason(parentSignal);
            }
            if (timedOut) {
              throw new ServiceError({
                code: "NETWORK_ERROR",
                message: translateRuntime(
                  "errors.clientRuntime.genericParentRetry",
                ),
                status: 0,
                request_id: "",
                retryable: true,
              });
            }
            throw error;
          }
        }

        if (shouldRetry) {
          await cancelResponseBodyQuietly(response, attemptHandle.signal);
          const timedOut = attemptHandle.didTimeout();
          attemptHandle.cleanup();
          if (parentSignal?.aborted && !timedOut) {
            throw getAbortReason(parentSignal);
          }
          if (timedOut) {
            throw new ServiceError({
              code: "NETWORK_ERROR",
              message: translateRuntime(
                "errors.clientRuntime.genericParentRetry",
              ),
              status: 0,
              request_id: "",
              retryable: true,
            });
          }
          await delayWithSignal(COLD_START_RETRY_DELAY_MS, parentSignal);
          continue;
        }

        activeAttemptHandle = attemptHandle;
        break;
      }

      const requestId = response.headers.get("x-request-id") ?? "";
      if (!response.ok) {
        if (response.status === 401) {
          invalidateBrowserTokenCache();
          invalidateApiReadCache();
        }
        let httpError: ServiceError;
        try {
          httpError = await createHttpError(
            response,
            activeAttemptHandle?.signal,
          );
          await cancelResponseBodyQuietly(
            response,
            activeAttemptHandle?.signal,
          );
        } catch (error) {
          const timedOut = activeAttemptHandle?.didTimeout() ?? false;
          if (parentSignal?.aborted && !timedOut) {
            throw getAbortReason(parentSignal);
          }
          if (timedOut) {
            throw new ServiceError({
              code: "NETWORK_ERROR",
              message: translateRuntime(
                "errors.clientRuntime.genericParentRetry",
              ),
              status: 0,
              request_id: requestId,
              retryable: true,
            });
          }
          throw error;
        }
        if (
          parentSignal?.aborted &&
          !(activeAttemptHandle?.didTimeout() ?? false)
        ) {
          throw getAbortReason(parentSignal);
        }
        if (activeAttemptHandle?.didTimeout()) {
          throw new ServiceError({
            code: "NETWORK_ERROR",
            message: translateRuntime(
              "errors.clientRuntime.genericParentRetry",
            ),
            status: 0,
            request_id: requestId,
            retryable: true,
          });
        }
        throw httpError;
      }

      if (response.status === 204 || schema === null) {
        return undefined as T;
      }

      let payload: unknown;
      try {
        payload = activeAttemptHandle
          ? await raceWithSignal(response.json(), activeAttemptHandle.signal)
          : await response.json();
      } catch (error) {
        const timedOut = activeAttemptHandle?.didTimeout() ?? false;
        if (parentSignal?.aborted && !timedOut) {
          throw error;
        }
        throw new ServiceError({
          code: "NETWORK_ERROR",
          message: translateRuntime("errors.clientRuntime.genericParentRetry"),
          status: timedOut ? 0 : response.status,
          request_id: requestId,
          retryable: timedOut,
        });
      }

      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        throw new ServiceError({
          code: "NETWORK_ERROR",
          message: DEFAULT_CHILD_ERROR_MESSAGE,
          status: response.status,
          request_id: requestId,
          retryable: false,
        });
      }

      return parsed.data;
    } finally {
      activeAttemptHandle?.cleanup();
    }
  };

  if (method !== "GET") {
    invalidateApiReadCache();
    clearUserCache();
    try {
      return await execute();
    } finally {
      invalidateApiReadCache();
      clearUserCache();
    }
  }

  return runCoalescedApiGet(
    path,
    token,
    init?.signal ?? undefined,
    (sharedSignal) => execute(sharedSignal),
  );
}

export function createChildService(): ChildService {
  return {
    async list(signal?: AbortSignal): Promise<ChildProfileDTO[]> {
      return request("/profiles/children", childProfileListSchema, { signal });
    },

    async create(requestBody: ChildProfileCreateDTO): Promise<ChildProfileDTO> {
      const body: ChildProfileCreateDTO = {
        alias: requestBody.alias,
        grade: requestBody.grade,
      };

      if (requestBody.settings !== undefined) {
        body.settings = requestBody.settings;
      }

      return request("/profiles/children", childProfileSchema, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },

    async get(childId: string, signal?: AbortSignal): Promise<ChildProfileDTO> {
      return request(
        `/profiles/children/${encodeURIComponent(childId)}`,
        childProfileSchema,
        { signal },
      );
    },

    async update(
      childId: string,
      requestBody: ChildProfilePatchDTO,
    ): Promise<ChildProfileDTO> {
      return request(
        `/profiles/children/${encodeURIComponent(childId)}`,
        childProfileSchema,
        {
          method: "PUT",
          body: JSON.stringify({
            alias: requestBody.alias,
            grade: requestBody.grade,
          }),
        },
      );
    },

    async delete(childId: string): Promise<void> {
      await request<void>(
        `/profiles/children/${encodeURIComponent(childId)}`,
        null,
        {
          method: "DELETE",
        },
      );
    },

    async uploadAvatar(childId: string, file: File): Promise<ChildProfileDTO> {
      const body = new FormData();
      body.append("file", file);
      return request(
        `/profiles/children/${encodeURIComponent(childId)}/avatar`,
        childProfileSchema,
        { method: "POST", body },
      );
    },

    async removeAvatar(childId: string): Promise<ChildProfileDTO> {
      return request(
        `/profiles/children/${encodeURIComponent(childId)}/avatar`,
        childProfileSchema,
        { method: "DELETE" },
      );
    },
  };
}
