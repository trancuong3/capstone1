"use client";

import { z } from "zod";

import { requestApi } from "@/lib/api/api-client";
import { ServiceError } from "@/lib/api/service-error";
import { translateRuntime } from "@/lib/i18n/runtime";
import type {
  SupportFeedbackRequest,
  SupportFeedbackResponse,
} from "@/types/support";

const supportFeedbackResponseSchema = z.object({
  accepted: z.literal(true),
  delivery_status: z.literal("accepted_by_smtp"),
  detail: z.string(),
});

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
      try {
        return await requestApi(
          "/support/feedback",
          supportFeedbackResponseSchema,
          undefined,
          { method: "POST", body: request },
        );
      } catch (error) {
        if (error instanceof ServiceError) {
          throw new SupportFeedbackError(
            safeMessageForStatus(error.status),
            error.status,
          );
        }
        throw new SupportFeedbackError(safeMessageForStatus(0), 0);
      }
    },
  };
}
