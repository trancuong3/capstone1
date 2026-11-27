import { getBrowserAccessToken } from "@/lib/api/browser-auth";
import { ServiceError } from "@/lib/api/service-error";
import { translateRuntime } from "@/lib/i18n/runtime";
import { getApiBaseUrl } from "@/lib/supabase/config";
import type {
  EntertainmentRecommendationsDTO,
  ParentEntertainmentAnalyticsDTO,
} from "@/types/adaptive-learning";

function unauthorizedError(): ServiceError {
  return new ServiceError({
    code: "AUTH_REQUIRED",
    message: "Authentication required.",
    status: 401,
    request_id: "",
    retryable: false,
  });
}

async function fetchJson<T>(path: string): Promise<T> {
  const token = await getBrowserAccessToken({
    onUnauthorized: unauthorizedError,
  });
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new ServiceError({
      code: response.status === 404 ? "RESOURCE_NOT_FOUND" : "NETWORK_ERROR",
      message: translateRuntime("entertainment.hub.recommendationLoadError"),
      status: response.status,
      request_id: response.headers.get("x-request-id") ?? "",
      retryable: response.status >= 500,
    });
  }
  return (await response.json()) as T;
}

export interface AdaptiveLearningService {
  getRecommendations(
    childId: string,
    teacherGender?: "female" | "male",
  ): Promise<EntertainmentRecommendationsDTO>;
  getParentAnalytics(
    childId: string,
    windowDays?: number,
  ): Promise<ParentEntertainmentAnalyticsDTO>;
}

export function createAdaptiveLearningService(): AdaptiveLearningService {
  return {
    getRecommendations(childId: string, teacherGender?: "female" | "male") {
      const suffix = teacherGender
        ? `?teacher_gender=${encodeURIComponent(teacherGender)}`
        : "";
      return fetchJson<EntertainmentRecommendationsDTO>(
        `/learning/children/${encodeURIComponent(childId)}/recommendations${suffix}`,
      );
    },
    getParentAnalytics(childId: string, windowDays = 30) {
      return fetchJson<ParentEntertainmentAnalyticsDTO>(
        `/learning/children/${encodeURIComponent(childId)}/parent-analytics?window_days=${windowDays}`,
      );
    },
  };
}
