"use client";

import { Bell, Mail, Send } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";

import { Button } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import {
  createParentNotificationService,
  type ParentEmailDeliveryDTO,
  type ParentEmailPreferencesDTO,
} from "@/lib/api/parent-notification-service";
import { ServiceError } from "@/lib/api/service-error";

const WEEKDAY_OPTIONS = [
  { value: 6, label: "Chủ Nhật" },
  { value: 0, label: "Thứ Hai" },
  { value: 1, label: "Thứ Ba" },
  { value: 2, label: "Thứ Tư" },
  { value: 3, label: "Thứ Năm" },
  { value: 4, label: "Thứ Sáu" },
  { value: 5, label: "Thứ Bảy" },
] as const;

const INACTIVITY_DAY_OPTIONS = [3, 5, 7, 14] as const;
const WEEKLY_CAP_OPTIONS = [1, 2, 4, 6] as const;
const QUIET_HOURS_PRESETS = [
  { value: "21-7", start: 21, end: 7, label: "21:00 – 07:00 (Mặc định)" },
  { value: "20-7", start: 20, end: 7, label: "20:00 – 07:00 (Sớm hơn)" },
  { value: "22-6", start: 22, end: 6, label: "22:00 – 06:00 (Muộn hơn)" },
  { value: "0-0", start: 0, end: 0, label: "Tắt khung giờ yên tĩnh" },
] as const;

const CATEGORY_LABELS: Record<ParentEmailDeliveryDTO["category"], string> = {
  WEEKLY_DIGEST: "Báo cáo tuần",
  INACTIVITY_ALERT: "Nhắc nghỉ đọc",
  MILESTONE: "Cột mốc",
  TEST_EMAIL: "Email thử nghiệm",
};

const STATUS_LABELS: Record<ParentEmailDeliveryDTO["status"], string> = {
  SENT: "Đã gửi",
  PENDING: "Đang chờ",
  SENDING: "Đang gửi",
  RETRY: "Đang thử lại",
  FAILED: "Chưa gửi được",
  SKIPPED: "Đã bỏ qua",
};

const STATUS_BADGE_STYLES: Record<ParentEmailDeliveryDTO["status"], string> = {
  SENT: "bg-emerald-50 text-emerald-700",
  PENDING: "bg-amber-50 text-amber-700",
  SENDING: "bg-sky text-primary",
  RETRY: "bg-amber-50 text-amber-700",
  FAILED: "bg-rose-50 text-rose-700",
  SKIPPED: "bg-slate-100 text-slate-600",
};

function mergeNumericOptions(
  presets: readonly number[],
  current: number,
): number[] {
  return presets.includes(current)
    ? [...presets]
    : [...presets, current].sort((a, b) => a - b);
}

function formatHourRange(start: number, end: number): string {
  if (start === end) return "Tắt khung giờ yên tĩnh";
  return `${String(start).padStart(2, "0")}:00 – ${String(end).padStart(2, "0")}:00`;
}

function formatDeliveryTimestamp(
  iso: string | null | undefined,
): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ready";
      preferences: ParentEmailPreferencesDTO;
      history: ParentEmailDeliveryDTO[];
    };

type Notice = { tone: "success" | "error"; message: string };

function ToggleRow({
  checked,
  description,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  description: string;
  disabled?: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-3 rounded-control border border-border bg-white px-4 py-3">
      <input
        aria-checked={checked}
        aria-describedby={`${id}-desc`}
        checked={checked}
        className="mt-1 size-5 shrink-0 accent-primary"
        disabled={disabled}
        id={id}
        onChange={(event) => onChange(event.target.checked)}
        role="switch"
        type="checkbox"
      />
      <label className="min-w-0 flex-1" htmlFor={id}>
        <span className="block text-body font-bold text-ink">{label}</span>
        <span className="block text-sm text-muted" id={`${id}-desc`}>
          {description}
        </span>
      </label>
    </div>
  );
}

export function ParentEmailPreferencesCard({
  emailVerified,
}: {
  emailVerified?: boolean | null;
}) {
  const service = useMemo(() => createParentNotificationService(), []);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [draft, setDraft] = useState<ParentEmailPreferencesDTO | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isSendingTest, setIsSendingTest] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    async function load() {
      setState({ status: "loading" });
      try {
        const [preferences, history] = await Promise.all([
          service.getPreferences(controller.signal),
          service.getHistory(5, controller.signal),
        ]);
        if (!active) return;
        setState({ status: "ready", preferences, history });
        setDraft(preferences);
      } catch {
        if (active && !controller.signal.aborted) {
          setState({ status: "error" });
        }
      }
    }

    void load();
    return () => {
      active = false;
      controller.abort();
    };
  }, [service]);

  async function handleSave() {
    if (!draft || isSaving) return;
    setNotice(null);
    setIsSaving(true);
    try {
      const updated = await service.updatePreferences({
        weekly_digest_enabled: draft.weekly_digest_enabled,
        inactivity_alert_enabled: draft.inactivity_alert_enabled,
        inactivity_days: draft.inactivity_days,
        milestone_enabled: draft.milestone_enabled,
        digest_weekday: draft.digest_weekday,
        max_emails_per_week: draft.max_emails_per_week,
        quiet_hours_start: draft.quiet_hours_start,
        quiet_hours_end: draft.quiet_hours_end,
      });
      setDraft(updated);
      setState((prev) =>
        prev.status === "ready" ? { ...prev, preferences: updated } : prev,
      );
      setNotice({
        tone: "success",
        message: "Đã lưu cài đặt thông báo email cho phụ huynh.",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          error instanceof ServiceError
            ? error.message
            : "Chưa lưu được cài đặt thông báo email. Ba mẹ thử lại sau nhé.",
      });
    } finally {
      setIsSaving(false);
    }
  }

  async function handleSendTestEmail() {
    if (isSendingTest) return;
    setNotice(null);
    setIsSendingTest(true);
    try {
      const result = await service.sendTestEmail();
      setNotice({
        tone: result.status === "SENT" ? "success" : "error",
        message: result.message,
      });
      try {
        const history = await service.getHistory(5);
        setState((prev) =>
          prev.status === "ready" ? { ...prev, history } : prev,
        );
      } catch {
        // Keep the test-email delivery status notice if history refresh fails transiently.
      }
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          error instanceof ServiceError
            ? error.message
            : "Chưa gửi được email thử nghiệm lúc này.",
      });
    } finally {
      setIsSendingTest(false);
    }
  }

  return (
    <Card id="email-notifications">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-control bg-sky text-primary">
          <Bell aria-hidden="true" className="size-5" />
        </div>
        <div>
          <h2 className="text-2xl font-extrabold text-ink">
            Thông báo Email cho phụ huynh
          </h2>
          <p className="text-sm text-muted">
            Tự động cập nhật tiến độ học của bé, nhắc nhẹ khi bé nghỉ đọc lâu và
            chúc mừng cột mốc — có giới hạn chống spam.
          </p>
        </div>
      </div>

      {emailVerified === false ? (
        <StatusMessage
          title="Cần xác minh email để nhận thông báo"
          tone="warning"
        >
          Email tài khoản chưa được xác minh nên hệ thống sẽ tạm chưa gửi thông
          báo tự động cho tới khi ba mẹ xác minh email.
        </StatusMessage>
      ) : null}

      {state.status === "loading" ? (
        <div className="space-y-3" aria-busy="true">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : null}

      {state.status === "error" ? (
        <StatusMessage title="Chưa tải được cài đặt thông báo" tone="error">
          Không thể tải cài đặt thông báo email lúc này. Ba mẹ vui lòng tải lại
          trang.
        </StatusMessage>
      ) : null}

      {state.status === "ready" && draft ? (
        <div className="space-y-4">
          {!draft.delivery_configured ? (
            <StatusMessage
              title="Máy chủ chưa bật gửi email ra ngoài"
              tone="warning"
            >
              Cài đặt của ba mẹ vẫn được lưu lại, nhưng máy chủ hiện chưa cấu
              hình nhà cung cấp gửi email (Resend hoặc SMTP) nên email chưa thể
              tự động gửi ra ngoài.
            </StatusMessage>
          ) : null}

          {notice ? (
            <StatusMessage
              title={
                notice.tone === "success"
                  ? "Cập nhật thành công"
                  : "Không thể thực hiện"
              }
              tone={notice.tone}
            >
              {notice.message}
            </StatusMessage>
          ) : null}

          <div className="space-y-3">
            <ToggleRow
              checked={draft.weekly_digest_enabled}
              description="Tổng hợp số buổi đọc, thời lượng, mục tiêu và các từ bé cần luyện trong 7 ngày qua (tối đa 1 email/tuần cho cả gia đình)."
              disabled={isSaving}
              label="Báo cáo tiến độ học hàng tuần"
              onChange={(weekly_digest_enabled) =>
                setDraft({ ...draft, weekly_digest_enabled })
              }
            />

            <ToggleRow
              checked={draft.inactivity_alert_enabled}
              description="Gửi lời nhắc nhẹ khi bé nghỉ đọc quá số ngày đã chọn. Giới hạn tối đa 1 lần/tuần và tự tạm dừng sau 2 lần nhắc chưa có buổi đọc mới."
              disabled={isSaving}
              label="Nhắc nhẹ khi bé nghỉ đọc quá lâu"
              onChange={(inactivity_alert_enabled) =>
                setDraft({ ...draft, inactivity_alert_enabled })
              }
            />

            <ToggleRow
              checked={draft.milestone_enabled}
              description="Chúc mừng khi bé hoàn thành buổi đọc đầu tiên, đạt chuỗi 7/14/30 ngày liên tiếp hoặc hoàn thành mục tiêu đọc."
              disabled={isSaving}
              label="Chúc mừng cột mốc đọc sách"
              onChange={(milestone_enabled) =>
                setDraft({ ...draft, milestone_enabled })
              }
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="flex flex-col gap-1.5 rounded-control border border-border bg-white px-4 py-3">
              <span className="text-label font-semibold text-muted">
                Ngày gửi báo cáo tuần
              </span>
              <select
                className="bg-transparent text-body font-semibold text-ink outline-none"
                disabled={isSaving || !draft.weekly_digest_enabled}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    digest_weekday: Number(event.target.value),
                  })
                }
                value={draft.digest_weekday}
              >
                {WEEKDAY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1.5 rounded-control border border-border bg-white px-4 py-3">
              <span className="text-label font-semibold text-muted">
                Nhắc khi bé nghỉ đọc sau
              </span>
              <select
                className="bg-transparent text-body font-semibold text-ink outline-none"
                disabled={isSaving || !draft.inactivity_alert_enabled}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    inactivity_days: Number(event.target.value),
                  })
                }
                value={draft.inactivity_days}
              >
                {mergeNumericOptions(
                  INACTIVITY_DAY_OPTIONS,
                  draft.inactivity_days,
                ).map((days) => (
                  <option key={days} value={days}>
                    {days} ngày liên tiếp
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1.5 rounded-control border border-border bg-white px-4 py-3">
              <span className="text-label font-semibold text-muted">
                Trần chống spam mỗi tuần
              </span>
              <select
                className="bg-transparent text-body font-semibold text-ink outline-none"
                disabled={isSaving}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    max_emails_per_week: Number(event.target.value),
                  })
                }
                value={draft.max_emails_per_week}
              >
                {mergeNumericOptions(
                  WEEKLY_CAP_OPTIONS,
                  draft.max_emails_per_week,
                ).map((cap) => (
                  <option key={cap} value={cap}>
                    Tối đa {cap} email/tuần
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1.5 rounded-control border border-border bg-white px-4 py-3">
              <span className="text-label font-semibold text-muted">
                Khung giờ yên tĩnh
              </span>
              <select
                className="bg-transparent text-body font-semibold text-ink outline-none"
                disabled={isSaving}
                onChange={(event) => {
                  const [startStr, endStr] = event.target.value.split("-");
                  const quiet_hours_start = Number(startStr);
                  const quiet_hours_end = Number(endStr);
                  if (
                    Number.isInteger(quiet_hours_start) &&
                    Number.isInteger(quiet_hours_end)
                  ) {
                    setDraft({
                      ...draft,
                      quiet_hours_start,
                      quiet_hours_end,
                    });
                  }
                }}
                value={`${draft.quiet_hours_start}-${draft.quiet_hours_end}`}
              >
                {QUIET_HOURS_PRESETS.some(
                  (preset) =>
                    preset.start === draft.quiet_hours_start &&
                    preset.end === draft.quiet_hours_end,
                ) ? null : (
                  <option
                    value={`${draft.quiet_hours_start}-${draft.quiet_hours_end}`}
                  >
                    {formatHourRange(
                      draft.quiet_hours_start,
                      draft.quiet_hours_end,
                    )}{" "}
                    (Tùy chỉnh)
                  </option>
                )}
                {QUIET_HOURS_PRESETS.map((preset) => (
                  <option key={preset.value} value={preset.value}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <p className="text-xs text-muted">
            Khung giờ yên tĩnh hiện tại:{" "}
            <strong>
              {formatHourRange(draft.quiet_hours_start, draft.quiet_hours_end)}
            </strong>{" "}
            ({draft.timezone}). Hệ thống không gửi báo cáo hay nhắc học trong
            khung giờ này.
          </p>

          <div className="flex flex-wrap gap-3">
            <Button
              disabled={isSaving}
              onClick={() => void handleSave()}
              type="button"
            >
              {isSaving ? "Đang lưu..." : "Lưu cài đặt email"}
            </Button>
            <Button
              disabled={
                isSendingTest ||
                !draft.delivery_configured ||
                emailVerified === false
              }
              onClick={() => void handleSendTestEmail()}
              type="button"
              variant="secondary"
            >
              <Send aria-hidden="true" className="size-4" />
              {isSendingTest ? "Đang gửi..." : "Gửi email thử nghiệm"}
            </Button>
          </div>

          {state.history.length > 0 ? (
            <div className="space-y-2 border-t border-border pt-4">
              <h3 className="flex items-center gap-2 text-sm font-bold text-ink">
                <Mail aria-hidden="true" className="size-4 text-primary" />
                Lịch sử gửi email gần đây
              </h3>
              <ul className="space-y-2">
                {state.history.map((item) => {
                  const timestamp = formatDeliveryTimestamp(
                    item.sent_at ?? item.created_at,
                  );
                  return (
                    <li
                      className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-border bg-white px-3 py-2 text-sm"
                      key={item.id}
                    >
                      <div className="min-w-0 flex-1">
                        <div>
                          <span className="font-semibold text-ink">
                            {CATEGORY_LABELS[item.category]}
                          </span>
                          <span className="mx-1.5 text-muted">·</span>
                          <span className="text-muted">{item.subject}</span>
                        </div>
                        {timestamp ? (
                          <div className="text-xs text-muted">{timestamp}</div>
                        ) : null}
                      </div>
                      <span
                        className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_BADGE_STYLES[item.status]}`}
                      >
                        {STATUS_LABELS[item.status]}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
