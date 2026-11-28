/**
 * Frontend client for `window.ViReadNativeReminder` (AndroidX WebViewCompat.addWebMessageListener).
 *
 * Syncs parent-configured `ReadingReminderDTO` schedules to native Android `AlarmManager`
 * local notifications, and wipes scheduled device alarms on sign-out so multi-user shared
 * tablets never leak another parent's child reminder.
 */

import type { ReadingReminderDTO } from "@/types/reading-management";

interface NativeReminderPort {
  postMessage(message: string): void;
  addEventListener?(
    type: "message",
    listener: (event: { data?: string }) => void,
  ): void;
  removeEventListener?(
    type: "message",
    listener: (event: { data?: string }) => void,
  ): void;
  onmessage?: ((event: { data?: string }) => void) | null;
}

export interface NativeReminderAck {
  readonly ok: boolean;
  readonly status: string;
  readonly scheduledCount: number;
  readonly sdkInt?: number;
}

function getNativeReminderPort(): NativeReminderPort | null {
  if (typeof window === "undefined") return null;
  const candidate = (
    window as Window & { ViReadNativeReminder?: NativeReminderPort }
  ).ViReadNativeReminder;
  if (candidate && typeof candidate.postMessage === "function") {
    return candidate;
  }
  return null;
}

export function isAndroidNativeReminderAvailable(): boolean {
  return getNativeReminderPort() !== null;
}

function sendBridgeCommand(
  payload: Record<string, unknown>,
  timeoutMs = 4_000,
): Promise<NativeReminderAck | null> {
  const port = getNativeReminderPort();
  if (!port) return Promise.resolve(null);

  const requestId = `rem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: NativeReminderAck | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (typeof port.removeEventListener === "function") {
        port.removeEventListener("message", onMessage);
      }
      resolve(result);
    };

    const onMessage = (event: { data?: string }) => {
      if (typeof event?.data !== "string") return;
      try {
        const parsed = JSON.parse(event.data) as {
          requestId?: string;
          ok?: boolean;
          status?: string;
          scheduledCount?: number;
          sdkInt?: number;
        };
        if (parsed.requestId !== requestId) return;
        finish({
          ok: Boolean(parsed.ok),
          status: String(parsed.status ?? ""),
          scheduledCount: Number(parsed.scheduledCount ?? 0),
          sdkInt: parsed.sdkInt,
        });
      } catch {
        // Ignore unrelated frames.
      }
    };

    const timer = window.setTimeout(() => finish(null), timeoutMs);
    if (typeof port.addEventListener === "function") {
      port.addEventListener("message", onMessage);
    } else {
      port.onmessage = onMessage;
    }

    try {
      port.postMessage(JSON.stringify({ ...payload, requestId }));
    } catch {
      finish(null);
    }
  });
}

export function requestAndroidReminderPermission(): Promise<NativeReminderAck | null> {
  return sendBridgeCommand({ action: "requestNotificationPermission" }, 15_000);
}

export async function syncRemindersToAndroidShell(input: {
  readonly userId: string;
  readonly childAlias: string;
  readonly reminders: readonly ReadingReminderDTO[];
  readonly titleText: string;
  readonly bodyText: string;
}): Promise<NativeReminderAck | null> {
  if (!isAndroidNativeReminderAvailable() || !input.userId) {
    return null;
  }
  const activePayload = input.reminders
    .filter((rem) => rem.is_active && !rem.deleted_at)
    .map((rem) => ({
      id: rem.id,
      isActive: rem.is_active,
      remindAt: rem.remind_at,
      weekdays: rem.weekdays,
      timezone: rem.timezone || "Asia/Ho_Chi_Minh",
      title: input.titleText,
      body: input.bodyText,
      targetPath: `/dashboard`,
    }));

  return sendBridgeCommand({
    action: "syncReminders",
    userId: input.userId,
    reminders: activePayload,
  });
}

export function clearAndroidScheduledReminders(): Promise<NativeReminderAck | null> {
  if (!isAndroidNativeReminderAvailable()) return Promise.resolve(null);
  return sendBridgeCommand({ action: "clearReminders" }, 2_000);
}
