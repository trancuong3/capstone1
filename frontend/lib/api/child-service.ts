import type {
  ChildProfileCreateDTO,
  ChildProfileDTO,
  ChildProfilePatchDTO,
} from "@/types/child";
import {
  getBrowserAccessToken,
  invalidateBrowserTokenCache,
} from "@/lib/api/browser-auth";
import { clearApiReadCache, runCoalescedApiGet } from "@/lib/api/read-cache";
import { ServiceError, type ServiceErrorCode } from "@/lib/api/service-error";
import { getApiBaseUrl } from "@/lib/supabase/config";

export interface ChildService {
  list(): Promise<ChildProfileDTO[]>;
  create(request: ChildProfileCreateDTO): Promise<ChildProfileDTO>;
  get(childId: string): Promise<ChildProfileDTO>;
  update(
    childId: string,
    request: ChildProfilePatchDTO,
  ): Promise<ChildProfileDTO>;
  uploadAvatar(childId: string, file: File): Promise<ChildProfileDTO>;
  removeAvatar(childId: string): Promise<ChildProfileDTO>;
  delete(childId: string): Promise<void>;
}

interface ErrorPayload {
  code?: string;
  message?: string;
  detail?: unknown;
}

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

async function parseErrorPayload(
  response: Response,
): Promise<ErrorPayload | null> {
  try {
    return (await response.json()) as ErrorPayload;
  } catch {
    return null;
  }
}

function extractErrorMessage(
  payload: ErrorPayload | null,
  fallback: string,
): string {
  if (payload?.message) {
    return payload.message;
  }

  if (typeof payload?.detail === "string") {
    return payload.detail;
  }

  if (
    payload?.detail &&
    typeof payload.detail === "object" &&
    "message" in payload.detail &&
    typeof payload.detail.message === "string"
  ) {
    return payload.detail.message;
  }

  return fallback;
}

function createHttpError(
  response: Response,
  payload: ErrorPayload | null,
): ServiceError {
  return new ServiceError({
    code: mapErrorCode(response.status),
    message: extractErrorMessage(
      payload,
      "Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.",
    ),
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

async function resolveChildAccessToken(): Promise<string> {
  return getBrowserAccessToken({
    onUnauthorized: unauthorizedError,
  });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let token: string;

  try {
    token = await resolveChildAccessToken();
  } catch (error) {
    if (error instanceof ServiceError) {
      throw error;
    }

    throw unauthorizedError();
  }

  const method = (init?.method ?? "GET").toUpperCase();
  const execute = async (): Promise<T> => {
    const headers = new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    });
    if (typeof init?.body === "string") {
      headers.set("Content-Type", "application/json");
    }

    let response: Response;

    try {
      response = await fetch(`${getApiBaseUrl()}${path}`, {
        ...init,
        headers: {
          ...Object.fromEntries(headers.entries()),
          ...(init?.headers ?? {}),
        },
        cache: "no-store",
      });
    } catch {
      throw new ServiceError({
        code: "NETWORK_ERROR",
        message: "Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.",
        status: 0,
        request_id: "",
        retryable: true,
      });
    }

    if (!response.ok) {
      if (response.status === 401) {
        invalidateBrowserTokenCache();
        clearApiReadCache();
      }
      const payload = await parseErrorPayload(response);
      throw createHttpError(response, payload);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw new ServiceError({
        code: "NETWORK_ERROR",
        message: "Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.",
        status: response.status,
        request_id: response.headers.get("x-request-id") ?? "",
        retryable: false,
      });
    }
  };

  if (method !== "GET") {
    clearApiReadCache();
    try {
      return await execute();
    } finally {
      clearApiReadCache();
    }
  }

  return runCoalescedApiGet(path, token, undefined, () => execute());
}

export function createChildService(): ChildService {
  return {
    async list(): Promise<ChildProfileDTO[]> {
      return request<ChildProfileDTO[]>("/profiles/children");
    },

    async create(requestBody: ChildProfileCreateDTO): Promise<ChildProfileDTO> {
      const body: ChildProfileCreateDTO = {
        alias: requestBody.alias,
        grade: requestBody.grade,
      };

      if (requestBody.settings !== undefined) {
        body.settings = requestBody.settings;
      }

      return request<ChildProfileDTO>("/profiles/children", {
        method: "POST",
        body: JSON.stringify(body),
      });
    },

    async get(childId: string): Promise<ChildProfileDTO> {
      return request<ChildProfileDTO>(
        `/profiles/children/${encodeURIComponent(childId)}`,
      );
    },

    async update(
      childId: string,
      requestBody: ChildProfilePatchDTO,
    ): Promise<ChildProfileDTO> {
      return request<ChildProfileDTO>(
        `/profiles/children/${encodeURIComponent(childId)}`,
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
      await request<void>(`/profiles/children/${encodeURIComponent(childId)}`, {
        method: "DELETE",
      });
    },

    async uploadAvatar(childId: string, file: File): Promise<ChildProfileDTO> {
      const body = new FormData();
      body.append("file", file);
      return request<ChildProfileDTO>(
        `/profiles/children/${encodeURIComponent(childId)}/avatar`,
        { method: "POST", body },
      );
    },

    async removeAvatar(childId: string): Promise<ChildProfileDTO> {
      return request<ChildProfileDTO>(
        `/profiles/children/${encodeURIComponent(childId)}/avatar`,
        { method: "DELETE" },
      );
    },
  };
}
