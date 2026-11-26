"use client";

import { Volume2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { useReportServices } from "@/hooks/use-report-services";
import { isServiceError } from "@/lib/api/service-error";
import type {
  DifficultWordDTO,
  DifficultWordPracticeStatus,
} from "@/types/reports";

interface DifficultWordItemProps {
  readonly childId: string;
  readonly word: DifficultWordDTO;
  readonly onPractice?: (word: DifficultWordDTO) => void;
}

const STATUS_BADGE_MAP: Record<
  DifficultWordPracticeStatus,
  { readonly label: string; readonly className: string }
> = {
  NOT_PRACTICED: {
    label: "Chưa luyện",
    className: "border border-border bg-canvas text-muted",
  },
  IN_PROGRESS: {
    label: "Đang luyện",
    className: "border border-border bg-sky text-primary-hover",
  },
  NEEDS_MORE_PRACTICE: {
    label: "Cần luyện thêm",
    className: "border border-border bg-warning-surface text-warning",
  },
  COMPLETED: {
    label: "Đã hoàn thành",
    className: "border border-border bg-success-surface text-success-ink",
  },
};

function formatPracticeDate(
  isoValue: string | null | undefined,
): string | null {
  if (!isoValue) return null;
  const parsed = new Date(isoValue);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Ho_Chi_Minh",
  }).format(parsed);
}

export function DifficultWordItem({
  childId,
  word,
  onPractice,
}: DifficultWordItemProps) {
  const { difficultWordService } = useReportServices();
  const [isPracticing, setIsPracticing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const practiceStatus: DifficultWordPracticeStatus =
    word.practice_status ?? "NOT_PRACTICED";
  const badge = STATUS_BADGE_MAP[practiceStatus];
  const practiceAttempts = word.practice_attempts_count ?? 0;
  const consecutiveCorrect = word.consecutive_correct_count ?? 0;
  const mispronunciationCount = word.mispronunciation_count ?? 0;
  const lastPracticedLabel = formatPracticeDate(word.last_practiced_at);

  async function practice(): Promise<void> {
    if (onPractice) {
      onPractice(word);
      return;
    }
    if (isPracticing) return;
    setIsPracticing(true);
    setMessage(null);
    try {
      const result = await difficultWordService.practice(
        childId,
        word.normalized_word,
        word.display_text,
      );
      setMessage(result.message);
    } catch (error) {
      setMessage(
        isServiceError(error) && (error.status === 501 || error.status === 503)
          ? error.message
          : "Chưa thể mở phần luyện từ. Ba mẹ vui lòng thử lại.",
      );
    } finally {
      setIsPracticing(false);
    }
  }

  return (
    <article className="rounded-card border border-border bg-white p-5 sm:p-6">
      <div className="flex flex-col items-start gap-4">
        <div className="min-w-0 w-full flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-2xl font-extrabold leading-tight text-ink">
              {word.display_text}
            </h2>
            <span
              className={`rounded-full px-3 py-1 text-sm font-bold ${badge.className}`}
            >
              {badge.label}
            </span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="inline-flex min-w-0 rounded-full bg-warning-surface px-3 py-1 text-label font-semibold text-primary sm:min-w-60">
              Điểm bằng chứng {word.difficulty_score}
            </span>
          </div>
          <p className="mt-2 text-label text-muted">
            {word.session_count} buổi · đọc nhầm {mispronunciationCount} · bỏ
            sót {word.omission_count} · lặp {word.repetition_count} · dừng lâu{" "}
            {word.long_pause_count} · đọc mẫu {word.read_example_count}
          </p>
          <p className="mt-1 text-label text-muted">
            {word.evidence_word_ids.length} bằng chứng gắn với từ trong
            revision.
          </p>
          <p className="mt-1 text-sm font-semibold text-muted">
            {practiceAttempts > 0
              ? `Đã luyện ${practiceAttempts} lần · đúng liên tiếp ${consecutiveCorrect}/2${lastPracticedLabel ? ` · Lần luyện gần nhất: ${lastPracticedLabel}` : ""}`
              : "Chưa có lượt luyện từ nào cho từ này."}
          </p>
        </div>
        <Button
          className="sm:w-60"
          isLoading={isPracticing}
          onClick={() => void practice()}
          variant="secondary"
        >
          <Volume2 aria-hidden="true" className="size-5" />
          Luyện từ
        </Button>
      </div>
      {message ? (
        <StatusMessage className="mt-5" title="Gợi ý luyện tập">
          {message}
        </StatusMessage>
      ) : null}
    </article>
  );
}
