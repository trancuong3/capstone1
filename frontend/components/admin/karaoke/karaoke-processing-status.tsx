"use client";
import { useState } from "react";
import { AdminStatusBadge } from "@/components/admin/admin-ui";
import { AiProgressBar } from "@/components/common/ai-progress-bar";
import { Button } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { useAiProgress } from "@/hooks/use-ai-progress";
import { useTranslations } from "@/hooks/use-i18n";
import type { ProcessingJob } from "@/types/karaoke-processing";

const KARAOKE_STAGE_PERCENT_MAP: Record<ProcessingJob["stage"], number> = {
  QUEUED: 8,
  VALIDATING_INPUT: 20,
  PREPARING_AUDIO: 45,
  ALIGNING_LYRICS: 75,
  VALIDATING_RESULT: 92,
  COMPLETE: 100,
};

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
  const tCommon = useTranslations("common");
  const [costAcknowledged, setCostAcknowledged] = useState(false);
  const candidate = job.status === "READY" || job.status === "NEEDS_REVIEW";
  const isProcessingActive =
    job.status === "QUEUED" || job.status === "RUNNING";
  const outstanding = candidate || isProcessingActive;
  const backendProgressPct = (job as { progress_pct?: number | null })
    .progress_pct;
  const stageBasePct =
    typeof backendProgressPct === "number" &&
    Number.isFinite(backendProgressPct)
      ? backendProgressPct
      : (KARAOKE_STAGE_PERCENT_MAP[job.stage] ?? 10);
  const aiProgress = useAiProgress({
    active: isProcessingActive,
    realPercent: stageBasePct,
    progressMode:
      typeof backendProgressPct === "number" &&
      Number.isFinite(backendProgressPct)
        ? "measured"
        : "staged",
    expectedDurationMs: 25_000,
    completed: candidate || job.status === "APPLIED",
    failed: job.status === "FAILED" || job.status === "CANCELLED",
  });
  const costUnknown = job.retry_policy === "EXPLICIT_COST_ACK";
  const retry =
    ["FAILED", "CANCELLED", "STALE"].includes(job.status) &&
    job.retry_policy !== "NEEDS_INPUT_CHANGE";
  const queuedLong =
    job.status === "QUEUED" &&
    nowMs - Date.parse(job.created_at) >= queueWarningAfterSeconds * 1000;

  const badgeTone =
    job.status === "FAILED"
      ? "danger"
      : job.status === "NEEDS_REVIEW" || job.status === "STALE"
        ? "warning"
        : job.status === "READY" || job.status === "APPLIED"
          ? "success"
          : job.status === "CANCELLED"
            ? "neutral"
            : "info";

  return (
    <section
      aria-label={t("karaoke.processing.ariaLabel")}
      className="grid gap-4"
    >
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="space-y-1.5"
      >
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="text-lg font-extrabold text-ink">
            {t(`karaoke.processing.statusLabels.${job.status}`)}
          </h2>
          <AdminStatusBadge
            label={job.status}
            status={job.status}
            tone={badgeTone}
          />
        </div>
        {(job.status === "QUEUED" || job.status === "RUNNING") && (
          <p className="text-sm text-ink">
            {t(`karaoke.processing.stepMessages.${job.stage}`)}
          </p>
        )}
      </div>
      {isProcessingActive && (
        <div className="space-y-2">
          <AiProgressBar
            active
            elapsedSeconds={aiProgress.elapsedSeconds}
            label={tCommon("aiProgress.processingKaraoke")}
            percent={aiProgress.percent}
            size="sm"
            testId="karaoke-processing-progress"
          />
          <p className="text-sm text-muted">
            {t("karaoke.processing.serverReceivedHint")}
          </p>
        </div>
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
      {job.status === "STALE" && (
        <p className="text-sm text-ink">
          {t("karaoke.processing.staleWarning")}
        </p>
      )}
      {job.status === "NEEDS_REVIEW" && (
        <p className="text-sm text-ink">
          {t("karaoke.processing.candidateNote")}
        </p>
      )}
      {costUnknown && (
        <StatusMessage tone="info">
          {t("karaoke.processing.cancelBillingNote")}
        </StatusMessage>
      )}
      {retry && costUnknown && (
        <label className="flex items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={costAcknowledged}
            onChange={(e) => setCostAcknowledged(e.target.checked)}
            className="mt-0.5 size-4 accent-primary"
          />
          {t("karaoke.processing.ackRetryCheckbox")}
        </label>
      )}
      <div className="flex flex-wrap items-center gap-2.5">
        {candidate && onPreview && (
          <Button
            disabled={busy}
            fullWidth={false}
            onClick={onPreview}
            size="admin"
            variant="secondary"
          >
            {t("karaoke.processing.listenStagingBtn")}
          </Button>
        )}
        {candidate && onApply && (
          <Button
            disabled={busy || !job.can_apply}
            fullWidth={false}
            onClick={onApply}
            size="admin"
          >
            {t("karaoke.processing.useResultBtn")}
          </Button>
        )}
        {outstanding && onCancel && (
          <Button
            disabled={busy}
            fullWidth={false}
            onClick={onCancel}
            size="admin"
            variant="outline"
          >
            {candidate
              ? t("karaoke.processing.discardResultBtn")
              : t("karaoke.processing.cancelProcessingBtn")}
          </Button>
        )}
        {retry && onRetry && (
          <Button
            disabled={busy || (costUnknown && !costAcknowledged)}
            fullWidth={false}
            onClick={() => onRetry(costAcknowledged)}
            size="admin"
            variant="secondary"
          >
            {t("karaoke.processing.retryBtn")}
          </Button>
        )}
      </div>
    </section>
  );
}
