"use client";

import { useEffect } from "react";

import type { TutorAction } from "@/types/reading";

import { Button } from "@/components/common/button";
import { ReadingStatusDialog } from "@/components/reading/reading-status-dialog";
import { useTranslations } from "@/hooks/use-i18n";

interface TutorMessageProps {
  action: TutorAction | null;
  errorMessage?: string | null;
  isPlaying?: boolean;
  isRetrying: boolean;
  nonBlocking?: boolean;
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
  nonBlocking = false,
  onClose,
  onRetry,
  ttsFailed = false,
  word,
}: TutorMessageProps) {
  const t = useTranslations("reading");
  const normalizedWord = word?.trim() ?? "";

  useEffect(() => {
    if (!nonBlocking) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [nonBlocking, onClose]);

  if (nonBlocking) {
    return (
      <div
        aria-live="polite"
        className="mx-auto w-full max-w-[1008px]"
        data-testid="tts-error-banner"
        role="status"
      >
        <div className="w-full rounded-card border border-amber-300 bg-paper p-3 shadow-xs sm:p-4">
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-label font-semibold text-ink">
                {t("tutor.title")}
              </p>
              {word ? (
                <span
                  className="viread-learning-content text-sm font-semibold text-primary"
                  dir="ltr"
                  lang="vi"
                >
                  {word}
                </span>
              ) : null}
            </div>
            <p className="text-sm text-muted">
              {ttsFailed
                ? (errorMessage ?? t("tutor.audioUnavailable"))
                : isPlaying
                  ? t("tutor.playingSample")
                  : t("tutor.listenHint")}
            </p>
            {action?.message_code === "READ_EXAMPLE_REPLAYED" ? (
              <p className="text-sm font-semibold text-success-ink">
                {t("tutor.retriedStatus")}
              </p>
            ) : null}
          </div>
          <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2">
            <Button
              disabled={isPlaying}
              fullWidth={false}
              isLoading={isRetrying}
              onClick={onRetry}
              size="touch"
              variant="secondary"
            >
              {isPlaying
                ? t("tutor.playingAction")
                : ttsFailed
                  ? t("tutor.retryListenAction")
                  : t("tutor.listenAction")}
            </Button>
            <Button
              fullWidth={false}
              onClick={onClose}
              size="touch"
              variant="quiet"
            >
              {t("tutor.continueReading")}
            </Button>
          </div>
        </div>
      </div>
    );
  }

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
