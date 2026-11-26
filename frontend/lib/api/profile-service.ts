import type { ChildProfileDTO } from "@/types/child";
import type {
  ContactInfoStatus,
  DashboardLatestSessionDTO,
  DashboardSummaryDTO,
  ParentProfileDTO,
  ParentProfileChildDTO,
  ParentProfileUpdateInput,
} from "@/types/profile";

import {
  getBrowserAccessToken,
  invalidateBrowserTokenCache,
} from "@/lib/api/browser-auth";
import { clearApiReadCache, runCoalescedApiGet } from "@/lib/api/read-cache";
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
  avatar_url?: string | null;
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
      translateRuntime("errors.clientRuntime.genericParentRetry"),
    ),
    status: response.status,
    request_id: response.headers.get("x-request-id") ?? "",
    retryable: response.status >= 500,
  });
}

interface DashboardLatestSessionApiResponse {
  id?: string;
  session_id?: string;
  child_id?: string;
  book_id?: string;
  book_title?: string | null;
  title?: string | null;
  state?: string;
  started_at?: string | null;
  ended_at?: string | null;
  resumable?: boolean;
}

interface DashboardSummaryChildApiResponse {
  id: string;
  parent_id?: string;
  alias: string;
  grade: number;
  settings?: Record<string, unknown>;
  created_at: string;
  avatar_url?: string | null;
}

interface DashboardSummaryApiResponse {
  profile?: ParentProfileApiResponse | null;
  children?: DashboardSummaryChildApiResponse[];
  latest_sessions_by_child?: Record<
    string,
    DashboardLatestSessionApiResponse | null
  >;
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
        message: translateRuntime("errors.clientRuntime.genericParentRetry"),
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
        message: translateRuntime("errors.clientRuntime.genericParentRetry"),
        status: response.status,
        request_id: response.headers.get("x-request-id") ?? "",
        retryable: false,
      });
    }
  };

  if (method !== "GET") {
    clearApiReadCache();
    clearUserCache();
    try {
      return await execute();
    } finally {
      clearApiReadCache();
      clearUserCache();
    }
  }

  return runCoalescedApiGet(path, token, undefined, () => execute());
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
      const response = await request<ParentProfileApiResponse>("/profiles/me");
      return normalizeParentProfile(response);
    },

    async getDashboardSummary(): Promise<DashboardSummaryDTO> {
      try {
        const response = await request<DashboardSummaryApiResponse>(
          "/profiles/dashboard-summary",
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
            request<ParentProfileApiResponse>("/profiles/me")
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
            request<ChildProfileDTO[]>("/profiles/children"),
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

    async updateContactPhone(
      contactPhone: string | null,
    ): Promise<ParentProfileDTO> {
      const normalizedPhone = contactPhone
        ? normalizeVietnamesePhone(contactPhone)
        : null;
      const response = await request<ParentProfileApiResponse>(
        "/profiles/me/contact-phone",
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
      const response = await request<ParentProfileApiResponse>(
        "/profiles/me/avatar",
        { method: "POST", body },
      );
      return normalizeParentProfile(response);
    },

    async removeAvatar(): Promise<ParentProfileDTO> {
      const response = await request<ParentProfileApiResponse>(
        "/profiles/me/avatar",
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
