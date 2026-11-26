"use client";

import {
  getBrowserAccessToken,
  invalidateBrowserTokenCache,
} from "@/lib/api/browser-auth";
import { translateRuntime } from "@/lib/i18n/runtime";
import { getApiBaseUrl } from "@/lib/supabase/config";
import type {
  SupportFeedbackRequest,
  SupportFeedbackResponse,
} from "@/types/support";

export class SupportFeedbackError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "SupportFeedbackError";
  }
}

function safeMessageForStatus(status: number): string {
  if (status === 401) {
    return translateRuntime("errors.clientRuntime.sessionExpiredParent");
  }
  if (status === 422) {
    return translateRuntime("errors.clientRuntime.supportInvalidPayload");
  }
  if (status === 503) {
    return translateRuntime("errors.clientRuntime.supportEmailUnavailable");
  }
  return translateRuntime("errors.clientRuntime.supportSubmitFailed");
}

export interface SupportService {
  submitFeedback(
    request: SupportFeedbackRequest,
  ): Promise<SupportFeedbackResponse>;
}

export function createSupportService(): SupportService {
  return {
    async submitFeedback(request) {
      let accessToken: string;
      try {
        accessToken = await getBrowserAccessToken({
          onUnauthorized: () =>
            new SupportFeedbackError(safeMessageForStatus(401), 401),
        });
      } catch (error) {
        if (error instanceof SupportFeedbackError) {
          throw error;
        }
        throw new SupportFeedbackError(safeMessageForStatus(401), 401);
      }

      let response: Response;
      try {
        response = await fetch(getApiBaseUrl() + "/support/feedback", {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: "Bearer " + accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(request),
          cache: "no-store",
        });
      } catch {
        throw new SupportFeedbackError(safeMessageForStatus(0), 0);
      }

      if (!response.ok) {
        if (response.status === 401) {
          invalidateBrowserTokenCache();
        }
        throw new SupportFeedbackError(
          safeMessageForStatus(response.status),
          response.status,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new SupportFeedbackError(safeMessageForStatus(0), 0);
      }

      if (
        typeof payload !== "object" ||
        payload === null ||
        !("accepted" in payload) ||
        payload.accepted !== true ||
        !("delivery_status" in payload) ||
        payload.delivery_status !== "accepted_by_smtp"
      ) {
        throw new SupportFeedbackError(safeMessageForStatus(0), 0);
      }

      return payload as SupportFeedbackResponse;
    },
  };
}
