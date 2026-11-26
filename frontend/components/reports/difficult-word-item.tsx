"use client";

import { Volume2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { useReportServices } from "@/hooks/use-report-services";
import { isServiceError } from "@/lib/api/service-error";
import { REPORT_TIMEZONE } from "@/lib/utils/report-state";
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
  { readonly key: string; readonly className: string }
> = {
  NOT_PRACTICED: {
    key: "item.notPracticed",
    className: "border border-border bg-canvas text-muted",
  },
  IN_PROGRESS: {
    key: "item.inProgress",
    className: "border border-border bg-sky text-primary-hover",
  },
  NEEDS_MORE_PRACTICE: {
    key: "item.needsMorePractice",
    className: "border border-border bg-warning-surface text-warning",
  },
  COMPLETED: {
    key: "item.completed",
    className: "border border-border bg-success-surface text-success-ink",
  },
};

export function DifficultWordItem({
  childId,
  word,
  onPractice,
}: DifficultWordItemProps) {
  const { difficultWordService } = useReportServices();
  const { formatDateTime } = useI18n();
  const t = useTranslations("difficultWords");
  const [isPracticing, setIsPracticing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const practiceStatus: DifficultWordPracticeStatus =
    word.practice_status ?? "NOT_PRACTICED";
  const badge = STATUS_BADGE_MAP[practiceStatus];
  const practiceAttempts = word.practice_attempts_count ?? 0;
  const consecutiveCorrect = word.consecutive_correct_count ?? 0;
  const mispronunciationCount = word.mispronunciation_count ?? 0;
  const lastPracticedLabel = (() => {
    if (!word.last_practiced_at) return null;
    const parsed = new Date(word.last_practiced_at);
    if (Number.isNaN(parsed.getTime())) return null;
    return formatDateTime(parsed, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: REPORT_TIMEZONE,
    });
  })();

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
          : t("item.openPracticeFailed"),
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
            <h2
              className="viread-learning-content text-2xl font-extrabold leading-tight text-ink"
              dir="ltr"
              lang="vi"
            >
              {word.display_text}
            </h2>
            <span
              className={`rounded-full px-3 py-1 text-sm font-bold ${badge.className}`}
            >
              {t(badge.key)}
            </span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="inline-flex min-w-60 rounded-full bg-warning-surface px-3 py-1 text-label font-semibold text-primary">
              {t("item.evidenceScore", { score: word.difficulty_score })}
            </span>
          </div>
          <p className="mt-2 text-label text-muted">
            {t("item.statsLine", {
              sessions: word.session_count,
              mispronounced: mispronunciationCount,
              omitted: word.omission_count,
              repeated: word.repetition_count,
              paused: word.long_pause_count,
              examples: word.read_example_count,
            })}
          </p>
          <p className="mt-1 text-label text-muted">
            {t("item.evidenceCount", { count: word.evidence_word_ids.length })}
          </p>
          <p className="mt-1 text-sm font-semibold text-muted">
            {practiceAttempts > 0
              ? `${t("item.practicedSummary", {
                  attempts: practiceAttempts,
                  consecutive: consecutiveCorrect,
                })}${
                  lastPracticedLabel
                    ? t("item.lastPracticedSuffix", {
                        date: lastPracticedLabel,
                      })
                    : ""
                }`
              : t("item.neverPracticed")}
          </p>
        </div>
        <Button
          className="sm:w-60"
          isLoading={isPracticing}
          onClick={() => void practice()}
          variant="secondary"
        >
          <Volume2 aria-hidden="true" className="size-5" />
          {t("item.practiceAction")}
        </Button>
      </div>
      {message ? (
        <StatusMessage className="mt-5" title={t("item.tipTitle")}>
          {message}
        </StatusMessage>
      ) : null}
    </article>
  );
}
