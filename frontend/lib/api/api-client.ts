import type { ZodType } from "zod";

import { ServiceError, type ServiceErrorCode } from "@/lib/api/service-error";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { getApiBaseUrl } from "@/lib/supabase/config";

const safeMessage = "Có lỗi xảy ra. Vui lòng thử lại sau.";

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

function failure(status: number, requestId = "", retryable = false) {
  return new ServiceError({
    code: errorCode(status),
    message: safeMessage,
    status,
    request_id: requestId,
    retryable,
  });
}

/** Only public DTOs validated by the supplied schema can reach a component. */
export async function requestApi<T>(
  path: string,
  schema: ZodType<T>,
  signal?: AbortSignal,
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
  try {
    response = await fetch(`${getApiBaseUrl()}${path}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
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
    // Do not reflect server details: SQL, tokens and account data are private.
    throw failure(response.status, requestId, response.status >= 500);
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
  return Promise.reject(new ServiceError({
    code: "NETWORK_ERROR", message: "Chức năng này chưa sẵn sàng.",
    status: 501, request_id: "", retryable: false,
  }));
}
