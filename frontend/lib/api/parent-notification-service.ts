import { z } from "zod";

import { requestApi } from "@/lib/api/api-client";

const preferencesSchema = z.object({
  weekly_digest_enabled: z.boolean(),
  inactivity_alert_enabled: z.boolean(),
  inactivity_days: z.number().int().min(2).max(30),
  milestone_enabled: z.boolean(),
  digest_weekday: z.number().int().min(0).max(6),
  timezone: z.string(),
  quiet_hours_start: z.number().int().min(0).max(23),
  quiet_hours_end: z.number().int().min(0).max(23),
  max_emails_per_week: z.number().int().min(1).max(14),
  delivery_configured: z.boolean(),
  delivery_provider: z.string(),
  updated_at: z.string().nullable().optional(),
});

const deliveryItemSchema = z.object({
  id: z.string().uuid(),
  category: z.enum([
    "WEEKLY_DIGEST",
    "INACTIVITY_ALERT",
    "MILESTONE",
    "TEST_EMAIL",
  ]),
  status: z.enum(["PENDING", "SENDING", "SENT", "RETRY", "FAILED", "SKIPPED"]),
  subject: z.string(),
  sent_at: z.string().nullable().optional(),
  created_at: z.string(),
  error_code: z.string().nullable().optional(),
});

const testEmailResponseSchema = z.object({
  status: z.enum(["SENT", "FAILED"]),
  delivery_id: z.string().uuid().nullable().optional(),
  provider: z.string(),
  error_code: z.string().nullable().optional(),
  message: z.string(),
});

export type ParentEmailPreferencesDTO = z.infer<typeof preferencesSchema>;
export type ParentEmailDeliveryDTO = z.infer<typeof deliveryItemSchema>;
export type ParentEmailTestResponseDTO = z.infer<
  typeof testEmailResponseSchema
>;

export interface ParentEmailPreferencesPatch {
  weekly_digest_enabled?: boolean;
  inactivity_alert_enabled?: boolean;
  inactivity_days?: number;
  milestone_enabled?: boolean;
  digest_weekday?: number;
  timezone?: string;
  quiet_hours_start?: number;
  quiet_hours_end?: number;
  max_emails_per_week?: number;
}

export interface ParentNotificationService {
  getPreferences(signal?: AbortSignal): Promise<ParentEmailPreferencesDTO>;
  updatePreferences(
    patch: ParentEmailPreferencesPatch,
  ): Promise<ParentEmailPreferencesDTO>;
  getHistory(
    limit?: number,
    signal?: AbortSignal,
  ): Promise<ParentEmailDeliveryDTO[]>;
  sendTestEmail(): Promise<ParentEmailTestResponseDTO>;
}

export function createParentNotificationService(): ParentNotificationService {
  return {
    getPreferences: (signal) =>
      requestApi(
        "/parent-notifications/preferences",
        preferencesSchema,
        signal,
      ),
    updatePreferences: (patch) =>
      requestApi(
        "/parent-notifications/preferences",
        preferencesSchema,
        undefined,
        { method: "PUT", body: patch },
      ),
    getHistory: (limit = 5, signal) =>
      requestApi(
        `/parent-notifications/history?limit=${encodeURIComponent(String(limit))}`,
        z.array(deliveryItemSchema),
        signal,
      ),
    sendTestEmail: () =>
      requestApi(
        "/parent-notifications/test-email",
        testEmailResponseSchema,
        undefined,
        { method: "POST" },
      ),
  };
}
