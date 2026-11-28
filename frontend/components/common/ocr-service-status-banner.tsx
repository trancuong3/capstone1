"use client";

import { AlertTriangle, CheckCircle2, RefreshCw, X } from "lucide-react";
import type { JSX } from "react";

import { Button } from "@/components/common/button";
import type { OcrWorkerAvailabilityState } from "@/hooks/use-ocr-worker-status";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils/cn";

export interface OcrServiceStatusBannerProps {
  readonly status: OcrWorkerAvailabilityState;
  readonly justRecovered?: boolean;
  readonly queuedCount?: number;
  readonly isChecking?: boolean;
  readonly onRecheck?: () => void;
  readonly onDismissRecovered?: () => void;
  readonly variant?: "parent" | "admin";
  readonly compact?: boolean;
  readonly testId?: string;
  readonly title?: string;
  readonly body?: string;
  readonly recoveredMessage?: string;
  readonly recheckLabel?: string;
  readonly className?: string;
}

export function OcrServiceStatusBanner({
  status,
  justRecovered = false,
  queuedCount = 0,
  isChecking = false,
  onRecheck,
  onDismissRecovered,
  variant = "parent",
  compact = false,
  testId,
  title,
  body,
  recoveredMessage,
  recheckLabel,
  className,
}: OcrServiceStatusBannerProps): JSX.Element | null {
  const { formatNumber } = useI18n();
  const t = useTranslations("ocr");

  const resolvedTestId =
    testId ??
    (variant === "admin"
      ? "admin-ocr-worker-offline-banner"
      : "ocr-worker-offline-banner");

  if (status === "ready") {
    if (!justRecovered) {
      return null;
    }
    const resolvedRecoveredText =
      recoveredMessage ??
      t(
        "serviceStatus.recoveredMessage",
        undefined,
        "Hệ thống nhận diện chữ (OCR) đã hoạt động trở lại — các trang trong hàng chờ sẽ tự động được xử lý.",
      );

    return (
      <div
        aria-live="polite"
        className={cn(
          "flex items-start justify-between gap-3 rounded-card border border-emerald-300 bg-emerald-50/90 text-emerald-950",
          compact ? "px-3.5 py-2.5 text-xs" : "p-4 text-sm",
          className,
        )}
        data-testid={
          variant === "admin"
            ? "admin-ocr-worker-recovered-banner"
            : "ocr-worker-recovered-banner"
        }
        role="status"
      >
        <div className="flex min-w-0 items-start gap-2.5">
          <CheckCircle2
            aria-hidden="true"
            className={cn(
              "shrink-0 text-emerald-700",
              compact ? "mt-0.5 size-4" : "mt-0.5 size-5",
            )}
          />
          <p className="font-semibold">{resolvedRecoveredText}</p>
        </div>
        {onDismissRecovered ? (
          <button
            aria-label={t(
              "serviceStatus.dismissRecoveredAria",
              undefined,
              "Đóng thông báo khôi phục OCR",
            )}
            className="inline-flex min-h-8 min-w-8 shrink-0 items-center justify-center rounded-control text-emerald-800 transition-colors hover:bg-emerald-100 focus-visible:outline-3 focus-visible:outline-primary"
            onClick={onDismissRecovered}
            type="button"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        ) : null}
      </div>
    );
  }

  if (status !== "unavailable" && status !== "unreachable") {
    return null;
  }

  const resolvedTitle =
    title ??
    (variant === "admin"
      ? status === "unavailable"
        ? t(
            "serviceStatus.adminUnavailableTitle",
            undefined,
            "Dịch vụ xử lý OCR hiện đang ngoại tuyến",
          )
        : t(
            "serviceStatus.adminUnreachableTitle",
            undefined,
            "Chưa kiểm tra được trạng thái dịch vụ OCR",
          )
      : status === "unavailable"
        ? t(
            "serviceStatus.parentUnavailableTitle",
            undefined,
            "Chức năng nhận diện chữ (OCR) hiện chưa sẵn sàng",
          )
        : t(
            "serviceStatus.parentUnreachableTitle",
            undefined,
            "Hệ thống nhận diện trang đang khởi động hoặc tạm chưa phản hồi",
          ));

  const resolvedBody =
    body ??
    (variant === "admin"
      ? status === "unavailable"
        ? t(
            "serviceStatus.adminUnavailableBody",
            undefined,
            "Bạn vẫn có thể tải ảnh hoặc PDF/DOCX ngay bây giờ: hệ thống sẽ xếp hàng an toàn và tự động chạy OCR khi dịch vụ xử lý OCR hoạt động.",
          )
        : t(
            "serviceStatus.adminUnreachableBody",
            undefined,
            "Hệ thống đang khởi động hoặc mạng chậm. Bạn vẫn có thể bấm Kiểm tra lại hoặc tải lên để xếp hàng xử lý.",
          )
      : status === "unavailable"
        ? t(
            "serviceStatus.parentUnavailableBody",
            undefined,
            "Hệ thống nhận diện trang đang tạm nghỉ — Ba mẹ vẫn có thể chụp hoặc tải ảnh để lưu sẵn trong hàng chờ; ViRead sẽ tự động nhận diện ngay khi sẵn sàng.",
          )
        : t(
            "serviceStatus.parentUnreachableBody",
            undefined,
            "Chưa kiểm tra được trạng thái hệ thống nhận diện do đang khởi động hoặc mạng chậm. Ba mẹ vẫn có thể tải ảnh để lưu vào hàng chờ hoặc bấm kiểm tra lại sau vài giây.",
          ));

  const resolvedRecheckLabel =
    recheckLabel ??
    t("serviceStatus.recheckNow", undefined, "Kiểm tra lại ngay");

  return (
    <div
      aria-live="polite"
      className={cn(
        "flex flex-col gap-3 rounded-card border border-amber-300 bg-amber-50/90 text-amber-950",
        compact ? "px-3.5 py-3 text-xs" : "p-4 text-sm",
        className,
      )}
      data-ocr-worker-status={status}
      data-testid={resolvedTestId}
      role="status"
    >
      <div className="flex flex-wrap items-start justify-between gap-2.5">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <AlertTriangle
            aria-hidden="true"
            className={cn(
              "shrink-0 text-amber-700",
              compact ? "mt-0.5 size-4" : "mt-0.5 size-5",
            )}
          />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-bold">{resolvedTitle}</p>
              {queuedCount > 0 ? (
                <span
                  className="inline-flex items-center rounded-full border border-amber-300 bg-amber-100 px-2.5 py-0.5 text-[11px] font-bold text-amber-950 tabular-nums"
                  data-testid={`${resolvedTestId}-queue-badge`}
                >
                  {t(
                    "serviceStatus.queuedCountBadge",
                    { count: formatNumber(queuedCount) },
                    "Hàng chờ: {count}",
                  )}
                </span>
              ) : null}
            </div>
            <p
              className={cn(
                "text-amber-900",
                compact
                  ? "text-xs leading-relaxed"
                  : "text-label leading-relaxed",
              )}
            >
              {resolvedBody}
            </p>
          </div>
        </div>

        {onRecheck ? (
          <Button
            className={cn(
              "shrink-0 sm:w-auto",
              compact
                ? "min-h-9 px-3 text-xs"
                : variant === "admin"
                  ? "min-h-10"
                  : "min-h-11",
            )}
            disabled={isChecking}
            onClick={onRecheck}
            size={variant === "admin" ? "admin" : "compact"}
            type="button"
            variant={variant === "admin" ? "outline" : "secondary"}
          >
            <RefreshCw
              aria-hidden="true"
              className={cn("size-4 shrink-0", isChecking && "animate-spin")}
            />
            {resolvedRecheckLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
