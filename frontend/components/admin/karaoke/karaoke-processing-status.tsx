"use client";
import { useState } from "react";
import { Button } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
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
const stageLabels = {
  QUEUED: "Bài hát đang chờ đến lượt.",
  VALIDATING_INPUT: "Đang kiểm tra nhạc và lời.",
  PREPARING_AUDIO: "Đang chuẩn bị nhạc nền.",
  ALIGNING_LYRICS: "Đang căn lời theo giọng hát.",
  VALIDATING_RESULT: "Đang kiểm tra kết quả.",
  COMPLETE: "Đã hoàn tất bước xử lý.",
} satisfies Record<ProcessingJob["stage"], string>;
const errorLabels = {
  NO_USABLE_VOCALS:
    "Chưa tìm được giọng hát rõ để căn lời. Hãy dùng bản có giọng hoặc thêm bản hát đối chiếu.",
  REFERENCE_TIMELINE_MISMATCH:
    "Nhạc nền và bản hát đối chiếu chưa khớp nhịp hoặc phần nhạc dạo. Hãy chọn hai bản cùng bản phối và timeline.",
  LYRICS_NOT_MATCHED:
    "Lời đã dán chưa khớp bản thu. Hãy kiểm tra các câu lặp và lời được hát thực tế.",
  PROVIDER_QUOTA_EXCEEDED:
    "Dịch vụ xử lý đã đạt giới hạn. Hãy kiểm tra hạn mức trước khi thử lại.",
  PROVIDER_TIMEOUT:
    "Xử lý đã quá thời gian chờ. Hãy kiểm tra tiến trình trước khi thử lại.",
  PROVIDER_OUTCOME_UNKNOWN:
    "Chưa xác định được kết quả lượt xử lý trước. Thử lại có thể phát sinh thêm phí.",
  INVALID_PROVIDER_RESULT:
    "Kết quả xử lý chưa hợp lệ. Bản nháp của bạn vẫn được giữ nguyên.",
  MEDIA_UNAVAILABLE:
    "Chưa đọc được file nhạc. Hãy kiểm tra bản nhạc đã tải lên.",
  ACTOR_UNAVAILABLE:
    "Tài khoản tạo lượt xử lý không còn đủ quyền. Hãy liên hệ người quản trị.",
  PROCESSING_CONFIGURATION_INVALID:
    "Máy chủ chưa cấu hình xử lý phù hợp. Chỉnh sửa thủ công vẫn dùng được.",
} satisfies Record<NonNullable<ProcessingJob["safe_error_code"]>, string>;
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
    <section aria-label="Tiến trình tạo karaoke" className="grid gap-4">
      <div role="status" aria-live="polite" aria-atomic="true">
        <h2 className="text-xl font-extrabold">
          {processingStatusLabels[job.status]}
        </h2>
        {(job.status === "QUEUED" || job.status === "RUNNING") && (
          <p>{stageLabels[job.stage]}</p>
        )}
      </div>
      {(job.status === "QUEUED" || job.status === "RUNNING") && (
        <p className="text-muted">
          Nhạc đã được máy chủ nhận. Bạn có thể rời trang và mở lại bài hát để
          xem tiến trình.
        </p>
      )}
      {queuedLong && (
        <StatusMessage tone="info">
          Bài hát đang chờ xử lý lâu hơn dự kiến. Bạn có thể xem lại tiến trình
          hoặc hủy; người vận hành cần kiểm tra worker nếu tiếp tục chờ lâu.
        </StatusMessage>
      )}
      {job.safe_error_code && (
        <StatusMessage tone="error">
          {errorLabels[job.safe_error_code]}
        </StatusMessage>
      )}
      {job.status === "STALE" && (
        <p>
          Bản nháp đã đổi nên kết quả cũ không được ghi đè. Hãy đối chiếu nội
          dung trước khi tạo lượt mới.
        </p>
      )}
      {job.status === "NEEDS_REVIEW" && (
        <p>
          Hãy nghe bản xem thử và kiểm tra các chỗ được đánh dấu. Kết quả chưa
          thay bản nháp và chưa được xuất bản.
        </p>
      )}
      {costUnknown && (
        <StatusMessage tone="info">
          Hủy không bảo đảm dịch vụ đã dừng tính phí hoặc hoàn phí cho lượt
          trước.
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
          Tôi hiểu thử lại có thể phát sinh thêm phí.
        </label>
      )}
      <div className="flex flex-wrap gap-3">
        {candidate && onPreview && (
          <Button variant="secondary" disabled={busy} onClick={onPreview}>
            Nghe kết quả chưa áp dụng
          </Button>
        )}
        {candidate && onApply && (
          <Button disabled={busy || !job.can_apply} onClick={onApply}>
            Dùng kết quả
          </Button>
        )}
        {outstanding && onCancel && (
          <Button variant="quiet" disabled={busy} onClick={onCancel}>
            {candidate ? "Bỏ kết quả này" : "Hủy xử lý"}
          </Button>
        )}
        {retry && onRetry && (
          <Button
            variant="secondary"
            disabled={busy || (costUnknown && !costAcknowledged)}
            onClick={() => onRetry(costAcknowledged)}
          >
            Thử xử lý lại
          </Button>
        )}
      </div>
    </section>
  );
}
