import type {
  ContactInfoStatus,
  ParentProfileDTO,
  ParentProfileChildDTO,
  ParentProfileUpdateInput,
} from "@/types/profile";

import { ServiceError, type ServiceErrorCode } from "@/lib/api/service-error";

import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { getApiBaseUrl } from "@/lib/supabase/config";

export interface ProfileService {
  get(): Promise<ParentProfileDTO>;
  update(request: ParentProfileUpdateInput): Promise<ParentProfileDTO>;
  requestEmailChange(email: string): Promise<void>;
  resendEmailChange(email: string): Promise<void>;
  updateContactPhone(contactPhone: string): Promise<ParentProfileDTO>;
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
  email?: string | null;
  contact_phone?: string | null;
  pending_email?: string | null;
  email_verified?: boolean | null;
  contact_info_status?: ContactInfoStatus;
  children?: ParentProfileChildDTO[];
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
    request_id: response.headers.get("x-request-id") ?? "",
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
}

function normalizeParentProfile(
  data: ParentProfileApiResponse,
): ParentProfileDTO {
  return {
    id: data.id,
    display_name: data.display_name,
    role: data.role,
    created_at: data.created_at,
    email: data.email ?? null,
    contact_phone: data.contact_phone ?? null,
    pending_email: data.pending_email ?? null,
    email_verified: data.email_verified ?? null,
    contact_info_status: data.contact_info_status ?? "lookup_failed",
    children: data.children ?? [],
  };
}

function normalizeUpdatedProfile(
  data: ProfileUpdateApiResponse,
  currentProfile: ParentProfileDTO,
): ParentProfileDTO {
  const id = data.id ?? data.Id;
  const role = data.role ?? data.Role;
  const displayName = data.display_name ?? data.DisplayName ?? null;
  const createdAt = data.created_at ?? data.CreatedAt;

  if (!id || !role || !createdAt) {
    throw new ServiceError({
      code: "NETWORK_ERROR",
      message: "Dữ liệu hồ sơ trả về từ server không hợp lệ.",
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
    email: currentProfile.email,
    contact_phone: currentProfile.contact_phone,
    pending_email: currentProfile.pending_email,
    email_verified: currentProfile.email_verified,
    contact_info_status: currentProfile.contact_info_status,
    children: currentProfile.children,
  };
}

function normalizeVietnamesePhone(value: string): string {
  const compact = value.trim().replace(/[\s().-]/g, "");

  if (/^0\d{9}$/.test(compact)) {
    return `+84${compact.slice(1)}`;
  }

  if (/^84\d{9}$/.test(compact)) {
    return `+${compact}`;
  }

  if (/^\+[1-9]\d{7,14}$/.test(compact)) {
    return compact;
  }

  throw new Error(
    "Số điện thoại chưa đúng định dạng. Ba mẹ vui lòng kiểm tra lại.",
  );
}

function safeAuthChangeError(
  error: unknown,
  operation: "email" | "resend-email",
): Error {
  const info =
    typeof error === "object" && error !== null
      ? (error as { status?: unknown; code?: unknown })
      : {};

  if (
    info.status === 429 ||
    info.code === "over_request_rate_limit" ||
    info.code === "over_email_send_rate_limit"
  ) {
    return new Error("Ba mẹ thao tác quá nhanh. Vui lòng đợi rồi thử lại.");
  }

  if (info.code === "email_exists" || info.code === "user_already_exists") {
    return new Error("Email này đã được tài khoản khác sử dụng.");
  }

  if (operation === "email") {
    return new Error(
      "Chưa gửi được yêu cầu đổi email. Ba mẹ vui lòng kiểm tra cấu hình email và thử lại.",
    );
  }

  return new Error(
    "Chưa gửi lại được email xác minh. Ba mẹ vui lòng thử lại sau.",
  );
}

function getProfileEmailRedirectUrl(): string {
  if (typeof window === "undefined") {
    throw new Error("Email change can only be started in the browser.");
  }
  const redirect = new URL("/auth/callback", window.location.origin);
  redirect.searchParams.set("next", "/profile");
  return redirect.toString();
}

export function createProfileService(): ProfileService {
  return {
    async get(): Promise<ParentProfileDTO> {
      const response = await request<ParentProfileApiResponse>("/profiles/me");
      return normalizeParentProfile(response);
    },

    async update(
      requestBody: ParentProfileUpdateInput,
    ): Promise<ParentProfileDTO> {
      const currentProfileResponse =
        await request<ParentProfileApiResponse>("/profiles/me");
      const currentProfile = normalizeParentProfile(currentProfileResponse);

      const response = await request<ProfileUpdateApiResponse>(
        `/profiles/${encodeURIComponent(currentProfile.id)}`,
        {
          method: "PUT",
          body: JSON.stringify({
            Role: currentProfile.role,
            displayname: requestBody.display_name,
          }),
        },
      );

      return normalizeUpdatedProfile(response, currentProfile);
    },

    async updateContactPhone(contactPhone: string): Promise<ParentProfileDTO> {
      const normalizedPhone = normalizeVietnamesePhone(contactPhone);
      const response = await request<ParentProfileApiResponse>(
        "/profiles/me/contact-phone",
        {
          method: "PATCH",
          body: JSON.stringify({ contact_phone: normalizedPhone }),
        },
      );
      return normalizeParentProfile(response);
    },

    async requestEmailChange(email: string): Promise<void> {
      const normalizedEmail = email.trim().toLowerCase();
      if (
        !normalizedEmail ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
      ) {
        throw new Error("Email chưa đúng định dạng.");
      }

      const supabase = createBrowserSupabaseClient();
      const { data: currentUserData, error: currentUserError } =
        await supabase.auth.getUser();
      if (currentUserError || !currentUserData.user) {
        throw new Error(
          "Phiên đăng nhập đã hết hạn. Ba mẹ vui lòng đăng nhập lại.",
        );
      }
      if (
        currentUserData.user.email?.trim().toLowerCase() === normalizedEmail
      ) {
        throw new Error("Email mới giống email hiện tại.");
      }

      const { error } = await supabase.auth.updateUser(
        { email: normalizedEmail },
        { emailRedirectTo: getProfileEmailRedirectUrl() },
      );
      if (error) throw safeAuthChangeError(error, "email");
    },

    async resendEmailChange(email: string): Promise<void> {
      const normalizedEmail = email.trim().toLowerCase();
      if (!normalizedEmail) {
        throw new Error("Không có email đang chờ xác minh.");
      }

      const supabase = createBrowserSupabaseClient();
      const { error } = await supabase.auth.resend({
        type: "email_change",
        email: normalizedEmail,
        options: { emailRedirectTo: getProfileEmailRedirectUrl() },
      });
      if (error) throw safeAuthChangeError(error, "resend-email");
    },
  };
}
