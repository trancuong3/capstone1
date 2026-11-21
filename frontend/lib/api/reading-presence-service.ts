import { z } from "zod";

import { requestApi } from "@/lib/api/api-client";

const settingsSchema = z.object({ email_enabled: z.boolean() });
const alertSchema = z.object({
  id: z.string().uuid(),
  session_id: z.string().uuid(),
  episode_id: z.string().uuid(),
  status: z.enum([
    "PENDING",
    "SENDING",
    "SENT",
    "CANCELLED",
    "EXPIRED",
    "FAILED",
  ]),
  due_at: z.string(),
  expires_at: z.string(),
  cancel_reason: z.string().nullable().optional(),
});

export type PresenceCancelReason =
  | "RETURNED"
  | "SESSION_ENDED"
  | "APP_BACKGROUND"
  | "OPT_OUT"
  | "PAUSED_BY_PARENT";

export type PresenceAlertDTO = z.infer<typeof alertSchema>;

export interface ReadingPresenceService {
  getSettings(signal?: AbortSignal): Promise<{ emailEnabled: boolean }>;
  setEmailEnabled(enabled: boolean): Promise<{ emailEnabled: boolean }>;
  /** Idempotent per (session, episode). The server picks recipient and timing. */
  armAlert(sessionId: string, episodeId: string): Promise<PresenceAlertDTO>;
  /** Heartbeat: still absent and the app is in the foreground. */
  confirmAlert(alertId: string): Promise<PresenceAlertDTO>;
  cancelAlert(
    alertId: string,
    reason: PresenceCancelReason,
  ): Promise<PresenceAlertDTO>;
}

export function createReadingPresenceService(): ReadingPresenceService {
  return {
    getSettings: async (signal) => {
      const row = await requestApi(
        "/reading-presence/settings",
        settingsSchema,
        signal,
      );
      return { emailEnabled: row.email_enabled };
    },
    setEmailEnabled: async (enabled) => {
      const row = await requestApi(
        "/reading-presence/settings",
        settingsSchema,
        undefined,
        { method: "PUT", body: { email_enabled: enabled } },
      );
      return { emailEnabled: row.email_enabled };
    },
    armAlert: (sessionId, episodeId) =>
      requestApi("/reading-presence/alerts", alertSchema, undefined, {
        method: "POST",
        body: { session_id: sessionId, episode_id: episodeId },
      }),
    confirmAlert: (alertId) =>
      requestApi(
        `/reading-presence/alerts/${encodeURIComponent(alertId)}/confirm`,
        alertSchema,
        undefined,
        { method: "POST" },
      ),
    cancelAlert: (alertId, reason) =>
      requestApi(
        `/reading-presence/alerts/${encodeURIComponent(alertId)}/cancel`,
        alertSchema,
        undefined,
        { method: "POST", body: { reason } },
      ),
  };
}
