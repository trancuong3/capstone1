"use client";
import { useState } from "react";
import { Button } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { useTranslations } from "@/hooks/use-i18n";
import type { ProcessingJob } from "@/types/karaoke-processing";

export const processingStatusLabels = {
  QUEUED: "Đang chờ xử lý",
  RUNNING: "Đang tạo karaoke",
  READY: "Đã có kết quả",
  NEEDS_REVIEW: "Có kết quả cần kiểm tra",
  FAILED: "Chưa tạo được karaoke",
  CANCELLED: "Đã hủy lượt xử lý",
  STALE: "Nội dung đã thay đổi",
  APPLIED: "Đã dùng kết quả trong bản nháp",
} satisfies Record<ProcessingJob["status"], string>;
type Props = {
  job: ProcessingJob;
  nowMs: number;
  queueWarningAfterSeconds: number;
  busy?: boolean;
  onCancel?: () => void;
  onRetry?: (acknowledgePossibleCharge: boolean) => void;
  onPreview?: () => void;
  onApply?: () => void;
};
export function KaraokeProcessingStatus(props: Props) {
  // Changing job identity resets cost consent; polling the same job does not.
  return <ProcessingStatusBody key={props.job.id} {...props} />;
}
function ProcessingStatusBody({
  job,
  nowMs,
  queueWarningAfterSeconds,
  busy = false,
  onCancel,
  onRetry,
  onPreview,
  onApply,
}: Props) {
  const t = useTranslations("admin");
  const [costAcknowledged, setCostAcknowledged] = useState(false);
  const candidate = job.status === "READY" || job.status === "NEEDS_REVIEW";
  const outstanding =
    candidate || job.status === "QUEUED" || job.status === "RUNNING";
  const costUnknown = job.retry_policy === "EXPLICIT_COST_ACK";
  const retry =
    ["FAILED", "CANCELLED", "STALE"].includes(job.status) &&
    job.retry_policy !== "NEEDS_INPUT_CHANGE";
  const queuedLong =
    job.status === "QUEUED" &&
    nowMs - Date.parse(job.created_at) >= queueWarningAfterSeconds * 1000;
  return (
    <section
      aria-label={t("karaoke.processing.ariaLabel")}
      className="grid gap-4"
    >
      <div role="status" aria-live="polite" aria-atomic="true">
        <h2 className="text-xl font-extrabold">
          {t(`karaoke.processing.statusLabels.${job.status}`)}
        </h2>
        {(job.status === "QUEUED" || job.status === "RUNNING") && (
          <p>{t(`karaoke.processing.stepMessages.${job.stage}`)}</p>
        )}
      </div>
      {(job.status === "QUEUED" || job.status === "RUNNING") && (
        <p className="text-muted">
          {t("karaoke.processing.serverReceivedHint")}
        </p>
      )}
      {queuedLong && (
        <StatusMessage tone="info">
          {t("karaoke.processing.delayedHint")}
        </StatusMessage>
      )}
      {job.safe_error_code && (
        <StatusMessage tone="error">
          {t(`karaoke.processing.errorHints.${job.safe_error_code}`)}
        </StatusMessage>
      )}
      {job.status === "STALE" && <p>{t("karaoke.processing.staleWarning")}</p>}
      {job.status === "NEEDS_REVIEW" && (
        <p>{t("karaoke.processing.candidateNote")}</p>
      )}
      {costUnknown && (
        <StatusMessage tone="info">
          {t("karaoke.processing.cancelBillingNote")}
        </StatusMessage>
      )}
      {retry && costUnknown && (
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={costAcknowledged}
            onChange={(e) => setCostAcknowledged(e.target.checked)}
            className="mt-1 size-5"
          />
          {t("karaoke.processing.ackRetryCheckbox")}
        </label>
      )}
      <div className="flex flex-wrap gap-3">
        {candidate && onPreview && (
          <Button variant="secondary" disabled={busy} onClick={onPreview}>
            {t("karaoke.processing.listenStagingBtn")}
          </Button>
        )}
        {candidate && onApply && (
          <Button disabled={busy || !job.can_apply} onClick={onApply}>
            {t("karaoke.processing.useResultBtn")}
          </Button>
        )}
        {outstanding && onCancel && (
          <Button variant="quiet" disabled={busy} onClick={onCancel}>
            {candidate
              ? t("karaoke.processing.discardResultBtn")
              : t("karaoke.processing.cancelProcessingBtn")}
          </Button>
        )}
        {retry && onRetry && (
          <Button
            variant="secondary"
            disabled={busy || (costUnknown && !costAcknowledged)}
            onClick={() => onRetry(costAcknowledged)}
          >
            {t("karaoke.processing.retryBtn")}
          </Button>
        )}
      </div>
    </section>
  );
}
