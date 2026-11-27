"use client";

import { useEffect } from "react";

import type { TutorAction } from "@/types/reading";

import { AiProgressBar } from "@/components/common/ai-progress-bar";
import { Button } from "@/components/common/button";
import { ReadingStatusDialog } from "@/components/reading/reading-status-dialog";
import { useAiProgress } from "@/hooks/use-ai-progress";
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
  const tCommon = useTranslations("common");
  const normalizedWord = word?.trim() ?? "";
  const voiceSynthProgress = useAiProgress({
    active: isRetrying,
    expectedDurationMs: 4_500,
    stages: [
      { atPct: 0, label: tCommon("aiProgress.connecting") },
      { atPct: 35, label: tCommon("aiProgress.synthesizingVoice") },
      { atPct: 80, label: tCommon("aiProgress.finalizing") },
    ],
  });

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
        className="pointer-events-none fixed inset-x-3 bottom-32 z-40 flex justify-center sm:inset-x-auto sm:right-6 sm:bottom-28 sm:max-w-md"
        data-testid="tts-error-banner"
        role="status"
      >
        <div className="pointer-events-auto w-full rounded-card border border-amber-300 bg-paper/98 p-4 shadow-lg backdrop-blur-xs">
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
            {isRetrying ? (
              <AiProgressBar
                active
                label={
                  voiceSynthProgress.stageLabel ??
                  tCommon("aiProgress.synthesizingVoice")
                }
                percent={voiceSynthProgress.percent}
                size="compact"
                testId="tutor-voice-progress"
              />
            ) : null}
            {action?.message_code === "READ_EXAMPLE_REPLAYED" ? (
              <p className="text-sm font-semibold text-success-ink">
                {t("tutor.retriedStatus")}
              </p>
            ) : null}
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            <Button
              className="w-auto!"
              disabled={isPlaying}
              isLoading={isRetrying}
              onClick={onRetry}
              size="compact"
              variant="secondary"
            >
              {isPlaying
                ? t("tutor.playingAction")
                : ttsFailed
                  ? t("tutor.retryListenAction")
                  : t("tutor.listenAction")}
            </Button>
            <Button
              className="w-auto!"
              onClick={onClose}
              size="compact"
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
          {isRetrying ? (
            <AiProgressBar
              active
              label={
                voiceSynthProgress.stageLabel ??
                tCommon("aiProgress.synthesizingVoice")
              }
              percent={voiceSynthProgress.percent}
              size="compact"
              testId="tutor-voice-dialog-progress"
            />
          ) : null}
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
