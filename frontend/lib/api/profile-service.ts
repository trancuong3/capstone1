import { z, type ZodType } from "zod";

import type { ChildProfileDTO } from "@/types/child";
import type {
  DashboardLatestSessionDTO,
  DashboardSummaryDTO,
  ParentProfileDTO,
  ParentProfileUpdateInput,
} from "@/types/profile";

import {
  getBrowserAccessToken,
  invalidateBrowserTokenCache,
} from "@/lib/api/browser-auth";
import {
  invalidateApiReadCache,
  runCoalescedApiGet,
} from "@/lib/api/read-cache";
import { ServiceError, type ServiceErrorCode } from "@/lib/api/service-error";
import { clearUserCache } from "@/lib/cache/user-query-cache";
import { translateRuntime } from "@/lib/i18n/runtime";

import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { getApiBaseUrl } from "@/lib/supabase/config";

export interface ProfileService {
  get(): Promise<ParentProfileDTO>;
  getDashboardSummary(): Promise<DashboardSummaryDTO>;
  update(request: ParentProfileUpdateInput): Promise<ParentProfileDTO>;
  requestEmailChange(email: string): Promise<void>;
  resendEmailChange(email: string): Promise<void>;
  updateContactPhone(contactPhone: string | null): Promise<ParentProfileDTO>;
  uploadAvatar(file: File): Promise<ParentProfileDTO>;
  removeAvatar(): Promise<ParentProfileDTO>;
}

const DEFAULT_PROFILE_ERROR_MESSAGE =
  "Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.";

// Only explicitly allowlisted backend codes/details may produce specific copy.
const SAFE_PROFILE_BACKEND_MESSAGES: Readonly<Record<string, string>> = {
  "Unsupported upload format; use JPEG, PNG, or WebP":
    "Định dạng ảnh chưa hỗ trợ. Ba mẹ hãy chọn ảnh PNG, JPG hoặc WEBP nhé.",
  "Image exceeds the 12 MB limit":
    "Ảnh tải lên vượt quá giới hạn dung lượng cho phép.",
  "Image decoding failed": "Không đọc được tệp ảnh tải lên. Hãy chọn ảnh khác.",
  "Image dimensions are invalid": "Kích thước ảnh đại diện chưa hợp lệ.",
  INVALID_IMAGE:
    "Ảnh tải lên chưa hợp lệ. Ba mẹ hãy chọn ảnh PNG, JPG hoặc WEBP nhé.",
  PARENT_CONFLICT:
    "Thông tin tài khoản phụ huynh bị xung đột hoặc đã tồn tại. Ba mẹ vui lòng thử lại.",
  AUTH_PROVIDER_UNAVAILABLE:
    "Dịch vụ xác thực đang tạm thời gián đoạn. Ba mẹ vui lòng thử lại sau.",
  DATABASE_OPERATION_FAILED:
    "Hệ thống dữ liệu đang gặp sự cố tạm thời. Ba mẹ vui lòng thử lại sau.",
  PARENT_AUTH_OPERATION_FAILED:
    "Không thể hoàn tất thao tác tài khoản lúc này. Ba mẹ vui lòng thử lại sau.",
};

const parentRoleSchema = z.enum(["parent", "admin"]);
const contactInfoStatusSchema = z.enum([
  "available",
  "not_configured",
  "user_not_found",
  "lookup_failed",
]);

const parentProfileChildSchema = z.object({
  id: z.string().min(1),
  alias: z.string(),
  grade: z.number().int(),
  created_at: z.string(),
  avatar_url: z.string().nullable().optional(),
});

const parentProfileApiSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().nullable(),
  role: parentRoleSchema,
  created_at: z.string(),
  email: z.string().nullable().optional(),
  contact_phone: z.string().nullable().optional(),
  pending_email: z.string().nullable().optional(),
  email_verified: z.boolean().nullable().optional(),
  contact_info_status: contactInfoStatusSchema.optional(),
  children: z.array(parentProfileChildSchema).optional(),
  avatar_url: z.string().nullable().optional(),
});

type ParentProfileApiResponse = z.infer<typeof parentProfileApiSchema>;

const profileUpdateApiSchema = z.object({
  Id: z.string().min(1).optional(),
  id: z.string().min(1).optional(),
  Role: parentRoleSchema.optional(),
  role: parentRoleSchema.optional(),
  DisplayName: z.string().nullable().optional(),
  display_name: z.string().nullable().optional(),
  CreatedAt: z.string().optional(),
  created_at: z.string().optional(),
});

type ProfileUpdateApiResponse = z.infer<typeof profileUpdateApiSchema>;

const dashboardLatestSessionApiSchema = z.object({
  id: z.string().optional(),
  session_id: z.string().optional(),
  child_id: z.string().optional(),
  book_id: z.string().optional(),
  book_title: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  state: z.string().optional(),
  started_at: z.string().nullable().optional(),
  ended_at: z.string().nullable().optional(),
  resumable: z.boolean().optional(),
});

type DashboardLatestSessionApiResponse = z.infer<
  typeof dashboardLatestSessionApiSchema
>;

const dashboardSummaryChildApiSchema = z.object({
  id: z.string().min(1),
  parent_id: z.string().optional(),
  alias: z.string(),
  grade: z.number().int(),
  settings: z.record(z.string(), z.unknown()).optional(),
  created_at: z.string(),
  avatar_url: z.string().nullable().optional(),
});

type DashboardSummaryChildApiResponse = z.infer<
  typeof dashboardSummaryChildApiSchema
>;

const dashboardSummaryApiSchema = z.object({
  profile: parentProfileApiSchema.nullable().optional(),
  children: z.array(dashboardSummaryChildApiSchema).optional(),
  latest_sessions_by_child: z
    .record(z.string(), dashboardLatestSessionApiSchema.nullable())
    .optional(),
});

const fallbackChildProfileListSchema = z.array(
  z.object({
    id: z.string().min(1),
    parent_id: z.string().min(1),
    alias: z.string(),
    grade: z.number().int(),
    settings: z.record(z.string(), z.unknown()).optional().default({}),
    created_at: z.string(),
    avatar_url: z.string().nullable().optional(),
  }),
);

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
      return "Ba mẹ không có quyền truy cập thông tin hồ sơ này.";
    case 404:
      return "Không tìm thấy thông tin hồ sơ được yêu cầu.";
    case 422:
      return "Thông tin hồ sơ chưa hợp lệ. Ba mẹ vui lòng kiểm tra lại.";
    default:
      return DEFAULT_PROFILE_ERROR_MESSAGE;
  }
}

async function resolveSafeErrorMessage(response: Response): Promise<string> {
  try {
    const payload: unknown = await response.clone().json();
    if (typeof payload === "object" && payload !== null) {
      if ("detail" in payload) {
        if (typeof payload.detail === "string") {
          const translated = SAFE_PROFILE_BACKEND_MESSAGES[payload.detail];
          if (translated) return translated;
        } else if (
          typeof payload.detail === "object" &&
          payload.detail !== null &&
          "code" in payload.detail &&
          typeof payload.detail.code === "string"
        ) {
          const translated = SAFE_PROFILE_BACKEND_MESSAGES[payload.detail.code];
          if (translated) return translated;
        }
      }
      if ("code" in payload && typeof payload.code === "string") {
        const translated = SAFE_PROFILE_BACKEND_MESSAGES[payload.code];
        if (translated) return translated;
      }
    }
  } catch {
    // Non-JSON error bodies must never be reflected to the UI.
  }

  return safeStatusMessage(response.status);
}

async function createHttpError(response: Response): Promise<ServiceError> {
  const message = await resolveSafeErrorMessage(response);
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

async function resolveProfileAccessToken(): Promise<string> {
  return getBrowserAccessToken({
    onUnauthorized: unauthorizedError,
  });
}

async function request<T>(
  path: string,
  schema: ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new ServiceError({
      code: "NETWORK_ERROR",
      message: DEFAULT_PROFILE_ERROR_MESSAGE,
      status: 0,
      request_id: "",
      retryable: false,
    });
  }

  let token: string;

  try {
    token = await resolveProfileAccessToken();
  } catch (error) {
    if (error instanceof ServiceError) {
      throw error;
    }

    throw unauthorizedError();
  }

  const method = (init?.method ?? "GET").toUpperCase();
  const execute = async (signal?: AbortSignal): Promise<T> => {
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
        credentials: "omit",
        redirect: "error",
        signal: signal ?? init?.signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ServiceError({
        code: "NETWORK_ERROR",
        message: translateRuntime("errors.clientRuntime.genericParentRetry"),
        status: 0,
        request_id: "",
        retryable: true,
      });
    }

    const requestId = response.headers.get("x-request-id") ?? "";
    if (!response.ok) {
      if (response.status === 401) {
        invalidateBrowserTokenCache();
        invalidateApiReadCache();
      }
      throw await createHttpError(response);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ServiceError({
        code: "NETWORK_ERROR",
        message: translateRuntime("errors.clientRuntime.genericParentRetry"),
        status: response.status,
        request_id: requestId,
        retryable: false,
      });
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new ServiceError({
        code: "NETWORK_ERROR",
        message: DEFAULT_PROFILE_ERROR_MESSAGE,
        status: response.status,
        request_id: requestId,
        retryable: false,
      });
    }

    return parsed.data;
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

  return runCoalescedApiGet(path, token, undefined, (sharedSignal) =>
    execute(sharedSignal),
  );
}

function normalizeSummaryChild(
  child: DashboardSummaryChildApiResponse,
  parentId: string,
): ChildProfileDTO {
  return {
    id: child.id,
    parent_id: child.parent_id ?? parentId,
    alias: child.alias,
    grade: child.grade,
    settings: child.settings ?? {},
    created_at: child.created_at,
    avatar_url: child.avatar_url ?? null,
  };
}

function normalizeLatestSessionsMap(
  raw: Record<string, DashboardLatestSessionApiResponse | null> | undefined,
): Record<string, DashboardLatestSessionDTO | null> {
  if (!raw || typeof raw !== "object") return {};
  const result: Record<string, DashboardLatestSessionDTO | null> = {};
  for (const [childId, entry] of Object.entries(raw)) {
    if (!entry) {
      result[childId] = null;
      continue;
    }
    const id = entry.id ?? entry.session_id;
    const bookId = entry.book_id;
    if (!id || !bookId) {
      result[childId] = null;
      continue;
    }
    const state = entry.state ?? "IN_PROGRESS";
    const endedAt = entry.ended_at ?? null;
    const resumable =
      typeof entry.resumable === "boolean"
        ? entry.resumable
        : !endedAt && !["FINISHED", "ABORTED"].includes(state);
    result[childId] = {
      id,
      child_id: entry.child_id ?? childId,
      book_id: bookId,
      book_title: entry.book_title ?? entry.title ?? null,
      state,
      started_at: entry.started_at ?? null,
      ended_at: endedAt,
      resumable,
    };
  }
  return result;
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
    avatar_url: data.avatar_url ?? null,
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
      message: translateRuntime("errors.clientRuntime.invalidProfilePayload"),
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
    avatar_url: currentProfile.avatar_url ?? null,
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

  throw new Error(translateRuntime("errors.clientRuntime.invalidPhoneFormat"));
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
    return new Error(translateRuntime("errors.clientRuntime.rateLimitedWait"));
  }

  if (info.code === "email_exists" || info.code === "user_already_exists") {
    return new Error(
      translateRuntime("errors.clientRuntime.emailAlreadyInUse"),
    );
  }

  if (operation === "email") {
    return new Error(
      translateRuntime("errors.clientRuntime.emailChangeRequestFailed"),
    );
  }

  return new Error(
    translateRuntime("errors.clientRuntime.resendVerificationFailed"),
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
      const response = await request("/profiles/me", parentProfileApiSchema);
      return normalizeParentProfile(response);
    },

    async getDashboardSummary(): Promise<DashboardSummaryDTO> {
      try {
        const response = await request(
          "/profiles/dashboard-summary",
          dashboardSummaryApiSchema,
        );
        const normalizedProfile = response.profile
          ? normalizeParentProfile(response.profile)
          : null;
        const parentId = normalizedProfile?.id ?? "";
        const rawChildren = Array.isArray(response.children)
          ? response.children
          : (normalizedProfile?.children ?? []);
        const children = rawChildren.map((child) =>
          normalizeSummaryChild(child, parentId),
        );
        return {
          profile: normalizedProfile,
          children,
          latest_sessions_by_child: normalizeLatestSessionsMap(
            response.latest_sessions_by_child,
          ),
          source: "dashboard-summary",
        };
      } catch (error) {
        if (
          error instanceof ServiceError &&
          (error.status === 404 || error.code === "RESOURCE_NOT_FOUND")
        ) {
          const [profileResult, children] = await Promise.all([
            request("/profiles/me", parentProfileApiSchema)
              .then((res) => normalizeParentProfile(res))
              .catch((profileError: unknown) => {
                if (
                  profileError instanceof ServiceError &&
                  (profileError.code === "AUTH_REQUIRED" ||
                    profileError.code === "FORBIDDEN")
                ) {
                  throw profileError;
                }
                return null;
              }),
            request("/profiles/children", fallbackChildProfileListSchema),
          ]);
          return {
            profile: profileResult,
            children,
            latest_sessions_by_child: {},
            source: "fallback",
          };
        }
        throw error;
      }
    },

    async update(
      requestBody: ParentProfileUpdateInput,
    ): Promise<ParentProfileDTO> {
      const currentProfileResponse = await request(
        "/profiles/me",
        parentProfileApiSchema,
      );
      const currentProfile = normalizeParentProfile(currentProfileResponse);

      const response = await request(
        `/profiles/${encodeURIComponent(currentProfile.id)}`,
        profileUpdateApiSchema,
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

    async updateContactPhone(
      contactPhone: string | null,
    ): Promise<ParentProfileDTO> {
      const normalizedPhone = contactPhone
        ? normalizeVietnamesePhone(contactPhone)
        : null;
      const response = await request(
        "/profiles/me/contact-phone",
        parentProfileApiSchema,
        {
          method: "PATCH",
          body: JSON.stringify({ contact_phone: normalizedPhone }),
        },
      );
      return normalizeParentProfile(response);
    },

    async uploadAvatar(file: File): Promise<ParentProfileDTO> {
      const body = new FormData();
      body.append("file", file);
      const response = await request(
        "/profiles/me/avatar",
        parentProfileApiSchema,
        { method: "POST", body },
      );
      return normalizeParentProfile(response);
    },

    async removeAvatar(): Promise<ParentProfileDTO> {
      const response = await request(
        "/profiles/me/avatar",
        parentProfileApiSchema,
        { method: "DELETE" },
      );
      return normalizeParentProfile(response);
    },

    async requestEmailChange(email: string): Promise<void> {
      const normalizedEmail = email.trim().toLowerCase();
      if (
        !normalizedEmail ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
      ) {
        throw new Error(
          translateRuntime("errors.clientRuntime.invalidEmailFormat"),
        );
      }

      const supabase = createBrowserSupabaseClient();
      const { data: currentUserData, error: currentUserError } =
        await supabase.auth.getUser();
      if (currentUserError || !currentUserData.user) {
        throw new Error(
          translateRuntime("errors.clientRuntime.sessionExpiredParent"),
        );
      }
      if (
        currentUserData.user.email?.trim().toLowerCase() === normalizedEmail
      ) {
        throw new Error(
          translateRuntime("errors.clientRuntime.newEmailSameAsCurrent"),
        );
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
        throw new Error(
          translateRuntime("errors.clientRuntime.noPendingEmailChange"),
        );
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
