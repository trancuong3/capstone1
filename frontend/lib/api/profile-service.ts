import type {
  ParentProfileDTO,
  ParentProfileUpdateInput,
} from "@/types/profile";

import {
  ServiceError,
  type ServiceErrorCode,
} from "@/lib/api/service-error";

import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { getApiBaseUrl } from "@/lib/supabase/config";

export interface ProfileService {
  get(): Promise<ParentProfileDTO>;
  update(
    request: ParentProfileUpdateInput,
  ): Promise<ParentProfileDTO>;
}

interface ErrorPayload {
  code?: string;
  message?: string;
  detail?: unknown;
}

interface ParentProfileApiResponse {
  id: string;
  display_name: string | null;
  role: "parent" | "admin";
  created_at: string;
}

interface ProfileUpdateApiResponse {
  Id?: string;
  id?: string;

  Role?: "parent" | "admin";
  role?: "parent" | "admin";

  DisplayName?: string | null;
  display_name?: string | null;

  CreatedAt?: string;
  created_at?: string;
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
    request_id:
      response.headers.get("x-request-id") ?? "",
    retryable: response.status >= 500,
  });
}

async function createHeaders(): Promise<Headers> {
  const supabase = createBrowserSupabaseClient();

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new ServiceError({
      code: "AUTH_REQUIRED",
      message: "Authentication required.",
      status: 401,
      request_id: "",
      retryable: false,
    });
  }

  return new Headers({
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${session.access_token}`,
  });
}

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  let headers: Headers;

  try {
    headers = await createHeaders();
  } catch (error) {
    if (error instanceof ServiceError) {
      throw error;
    }

    throw new ServiceError({
      code: "AUTH_REQUIRED",
      message: "Authentication required.",
      status: 401,
      request_id: "",
      retryable: false,
    });
  }

  let response: Response;

  try {
    response = await fetch(
      `${getApiBaseUrl()}${path}`,
      {
        ...init,
        headers: {
          ...Object.fromEntries(
            headers.entries(),
          ),
          ...(init?.headers ?? {}),
        },
        cache: "no-store",
      },
    );
  } catch {
    throw new ServiceError({
      code: "NETWORK_ERROR",
      message:
        "Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.",
      status: 0,
      request_id: "",
      retryable: true,
    });
  }

  if (!response.ok) {
    const payload =
      await parseErrorPayload(response);

    throw createHttpError(
      response,
      payload,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new ServiceError({
      code: "NETWORK_ERROR",
      message:
        "Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.",
      status: response.status,
      request_id:
        response.headers.get("x-request-id") ?? "",
      retryable: false,
    });
  }
}

function normalizeParentProfile(
  data: ParentProfileApiResponse,
): ParentProfileDTO {
  return {
    id: data.id,
    display_name: data.display_name,
    role: data.role,
    created_at: data.created_at,
  };
}

function normalizeUpdatedProfile(
  data: ProfileUpdateApiResponse,
): ParentProfileDTO {
  const id = data.id ?? data.Id;
  const role = data.role ?? data.Role;
  const displayName =
    data.display_name ?? data.DisplayName ?? null;
  const createdAt =
    data.created_at ?? data.CreatedAt;

  if (!id || !role || !createdAt) {
    throw new ServiceError({
      code: "NETWORK_ERROR",
      message:
        "Dữ liệu hồ sơ trả về từ server không hợp lệ.",
      status: 200,
      request_id: "",
      retryable: false,
    });
  }

  return {
    id,
    display_name: displayName,
    role,
    created_at: createdAt,
  };
}

export function createProfileService(): ProfileService {
  return {
    async get(): Promise<ParentProfileDTO> {
      const response =
        await request<ParentProfileApiResponse>(
          "/profiles/me",
        );

      return normalizeParentProfile(response);
    },

    async update(
      requestBody: ParentProfileUpdateInput,
    ): Promise<ParentProfileDTO> {
      /*
       * Backend PUT /profiles/{profile_id}
       * hiện yêu cầu profile_id.
       *
       * Vì parent_id không được lấy từ Frontend request,
       * trước tiên lấy profile hiện tại từ /profiles/me.
       */
      const currentProfile =
        await request<ParentProfileApiResponse>(
          "/profiles/me",
        );

      /*
       * Backend ProfileUpdate hiện tại có:
       * - Role
       * - displayname
       */
      const response =
        await request<ProfileUpdateApiResponse>(
          `/profiles/${encodeURIComponent(
            currentProfile.id,
          )}`,
          {
            method: "PUT",
            body: JSON.stringify({
              Role: currentProfile.role,
              displayname:
                requestBody.display_name,
            }),
          },
        );

      return normalizeUpdatedProfile(response);
    },
  };
}