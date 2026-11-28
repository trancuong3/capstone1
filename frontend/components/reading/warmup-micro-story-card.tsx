"use client";

import { BookHeart, RefreshCw, Sparkles, Square, Volume2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AiProgressBar } from "@/components/common/ai-progress-bar";
import { Button } from "@/components/common/button";
import { useAiProgress } from "@/hooks/use-ai-progress";
import { useTranslations } from "@/hooks/use-i18n";
import { useSpeechPlayer } from "@/hooks/use-speech-player";
import { createAdaptiveLearningService } from "@/lib/api/adaptive-learning-service";
import type { WarmupMicroStoryDTO } from "@/types/adaptive-learning";

interface WarmupMicroStoryCardProps {
  readonly childId: string;
  readonly bookId?: string;
}

export function WarmupMicroStoryCard({ childId }: WarmupMicroStoryCardProps) {
  const t = useTranslations("reading");
  const tCommon = useTranslations("common");
  const speechPlayer = useSpeechPlayer();
  const service = useMemo(() => createAdaptiveLearningService(), []);

  const [loadedState, setLoadedState] = useState<{
    readonly childId: string;
    readonly story: WarmupMicroStoryDTO | null;
    readonly failed: boolean;
  } | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSynthesizing, setIsSynthesizing] = useState(false);

  const story = loadedState?.childId === childId ? loadedState.story : null;
  const failed = loadedState?.childId === childId ? loadedState.failed : false;
  const isLoading = isRefreshing || loadedState?.childId !== childId;

  const loadProgress = useAiProgress({
    active: isLoading,
    expectedDurationMs: 4_500,
    resetKey: childId,
  });

  const ttsProgress = useAiProgress({
    active: isSynthesizing && !speechPlayer.isPlaying,
    expectedDurationMs: 3_500,
    resetKey: story?.full_text ?? null,
  });

  const refreshStory = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const result = await service.getWarmupStory(childId, { refresh: true });
      setLoadedState({ childId, story: result, failed: false });
      if (result.full_text) {
        void speechPlayer.prefetch?.(result.full_text)?.catch(() => undefined);
      }
    } catch {
      setLoadedState((prev) =>
        prev?.childId === childId
          ? prev
          : { childId, story: null, failed: true },
      );
    } finally {
      setIsRefreshing(false);
    }
  }, [childId, service, speechPlayer]);

  useEffect(() => {
    if (!childId || loadedState?.childId === childId) return;
    let mounted = true;
    service
      .getWarmupStory(childId)
      .then((result) => {
        if (!mounted) return;
        setLoadedState({ childId, story: result, failed: false });
        if (result.full_text) {
          void speechPlayer
            .prefetch?.(result.full_text)
            ?.catch(() => undefined);
        }
      })
      .catch(() => {
        if (mounted) {
          setLoadedState({ childId, story: null, failed: true });
        }
      });
    return () => {
      mounted = false;
    };
  }, [childId, loadedState?.childId, service, speechPlayer]);

  const handleTogglePlay = useCallback(async () => {
    if (!story?.full_text) return;
    if (speechPlayer.isPlaying) {
      speechPlayer.stop();
      setIsSynthesizing(false);
      return;
    }
    setIsSynthesizing(true);
    try {
      await speechPlayer.play(story.full_text, {
        bypassSessionLock: true,
        cacheScope: "PRIVATE",
        isPrivateBook: true,
      });
    } catch {
      // Handled by speechPlayer fallback notice
    } finally {
      setIsSynthesizing(false);
    }
  }, [speechPlayer, story]);

  if (failed && !story) {
    return null;
  }

  return (
    <section
      aria-label={t("preparation.warmupStory.title")}
      className="rounded-card border border-primary/25 bg-gradient-to-br from-cream via-white to-sky/55 p-4 shadow-2xs sm:p-5"
      data-testid="warmup-micro-story-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="inline-flex items-center gap-1.5 text-xs font-extrabold tracking-wide text-primary uppercase">
            <BookHeart aria-hidden="true" className="size-3.5" />
            {story?.has_due_words
              ? t("preparation.warmupStory.spacedEyebrow")
              : t("preparation.warmupStory.starterEyebrow")}
          </div>
          <h2 className="text-base font-extrabold text-ink sm:text-lg">
            {t("preparation.warmupStory.title")}
          </h2>
        </div>

        {story ? (
          <div className="flex items-center gap-2">
            <Button
              onClick={() => void handleTogglePlay()}
              size="compact"
              type="button"
              variant="secondary"
            >
              {speechPlayer.isPlaying ? (
                <>
                  <Square aria-hidden="true" className="size-3.5" />
                  {t("preparation.warmupStory.stopListen")}
                </>
              ) : (
                <>
                  <Volume2 aria-hidden="true" className="size-4" />
                  {t("preparation.warmupStory.listenStory")}
                </>
              )}
            </Button>
            <Button
              aria-label={t("preparation.warmupStory.refreshStory")}
              disabled={isLoading}
              onClick={() => void refreshStory()}
              size="compact"
              type="button"
              variant="quiet"
            >
              <RefreshCw aria-hidden="true" className="size-4" />
            </Button>
          </div>
        ) : null}
      </div>

      {isLoading ? (
        <div className="mt-3">
          <AiProgressBar
            active
            elapsedSeconds={loadProgress.elapsedSeconds}
            label={
              loadProgress.stageLabel ?? tCommon("aiProgress.generatingHint")
            }
            percent={loadProgress.percent}
            size="sm"
            testId="warmup-micro-story-progress"
          />
        </div>
      ) : story ? (
        <div className="mt-3 space-y-3">
          {isSynthesizing && !speechPlayer.isPlaying ? (
            <AiProgressBar
              active
              label={tCommon("aiProgress.synthesizingVoice")}
              percent={ttsProgress.percent}
              size="compact"
              testId="warmup-micro-story-tts-progress"
            />
          ) : null}

          {story.target_words.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-1 text-xs font-bold text-muted">
                <Sparkles
                  aria-hidden="true"
                  className="size-3.5 text-primary"
                />
                {t("preparation.warmupStory.focusWordsLabel")}:
              </span>
              {story.target_words.map((word) => (
                <span
                  className="viread-learning-content rounded-full border border-primary/30 bg-white px-2.5 py-0.5 text-xs font-extrabold text-primary-hover"
                  dir="ltr"
                  key={word}
                  lang="vi"
                >
                  {word}
                </span>
              ))}
            </div>
          ) : null}

          <div
            className="viread-learning-content space-y-1.5 rounded-control border border-border bg-white/95 p-3.5 text-base leading-relaxed font-semibold text-ink"
            dir="ltr"
            lang="vi"
          >
            {story.sentences.map((sentence, index) => (
              <p key={`${index}-${sentence}`}>{sentence}</p>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
