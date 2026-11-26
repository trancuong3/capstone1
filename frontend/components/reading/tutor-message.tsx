"use client";

import type { TutorAction } from "@/types/reading";

import { ReadingStatusDialog } from "@/components/reading/reading-status-dialog";
import { useTranslations } from "@/hooks/use-i18n";

interface TutorMessageProps {
  action: TutorAction | null;
  errorMessage?: string | null;
  isPlaying?: boolean;
  isRetrying: boolean;
  onClose: () => void;
  onRetry: () => void;
  ttsFailed?: boolean;
  word: string | null | undefined;
}

export function TutorMessage({
  action,
  errorMessage = null,
  isPlaying = false,
  isRetrying,
  onClose,
  onRetry,
  ttsFailed = false,
  word,
}: TutorMessageProps) {
  const t = useTranslations("reading");
  const normalizedWord = word?.trim() ?? "";

  return (
    <ReadingStatusDialog
      body={
        <div className="space-y-3">
          {normalizedWord ? (
            <p
              className="viread-learning-content text-[32px] font-semibold text-primary"
              dir="ltr"
              lang="vi"
            >
              {normalizedWord}
            </p>
          ) : null}
          <p>
            {ttsFailed
              ? (errorMessage ?? t("tutor.audioUnavailable"))
              : isPlaying
                ? t("tutor.playingSample")
                : t("tutor.listenHint")}
          </p>
          {action?.message_code === "READ_EXAMPLE_REPLAYED" ? (
            <p className="font-semibold text-success-ink" role="status">
              {t("tutor.retriedStatus")}
            </p>
          ) : null}
        </div>
      }
      closeOnEscape
      onClose={onClose}
      primaryAction={{
        disabled: isPlaying,
        isLoading: isRetrying,
        label: isPlaying
          ? t("tutor.playingAction")
          : ttsFailed
            ? t("tutor.retryListenAction")
            : t("tutor.listenAction"),
        onClick: onRetry,
        variant: "secondary",
      }}
      secondaryAction={{ label: t("tutor.continueReading"), onClick: onClose }}
      title={t("tutor.title")}
    />
  );
}
