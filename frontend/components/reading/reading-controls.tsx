"use client";

import { BookOpen, Check, Mic, Pause, Volume2, VolumeX } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/common/button";
import { useTranslations } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils/cn";

interface ReadingControlsProps {
  audioLevel?: number;
  pauseDisabled?: boolean;
  disabled?: boolean;
  isListening?: boolean;
  isPlayingSample?: boolean;
  onFinish: () => void;
  onHelp: () => void;
  onPause: () => void;
  onReadSample?: () => void;
  onSpellWord?: () => void;
  onToggleListening?: () => void;
  retryMode?: boolean;
  onChoosePage?: () => void;
  voiceSettings?: ReactNode;
}

const dockButtonClass =
  "min-h-11 min-w-0 flex-col gap-0.5 px-1 py-1 text-[10px] leading-tight sm:px-1.5 sm:py-1.5 sm:text-xs sm:leading-snug lg:min-h-14 lg:flex-row lg:gap-2 lg:px-3 lg:py-2 lg:text-button";

export function ReadingControls({
  audioLevel,
  pauseDisabled,
  disabled = false,
  isListening = false,
  isPlayingSample = false,
  onFinish,
  onHelp: _onHelp,
  onPause,
  onReadSample,
  onToggleListening,
  retryMode = false,
  onChoosePage,
  voiceSettings,
}: ReadingControlsProps) {
  void _onHelp;
  const t = useTranslations("reading");
  const finishDisabled = disabled;
  const clampedAudioLevel = Math.min(1, Math.max(0, audioLevel ?? 0));
  const micPulseScale = 1 + clampedAudioLevel * 0.4;

  return (
    <div className="mx-auto w-full max-w-[1104px]">
      <nav
        aria-label={t("controls.toolbarAria")}
        data-reading-controls
        className={cn(
          "grid gap-1 sm:gap-2 lg:gap-3",
          retryMode
            ? voiceSettings
              ? "grid-cols-5"
              : "grid-cols-4"
            : voiceSettings
              ? "grid-cols-6"
              : "grid-cols-5",
        )}
      >
        <Button
          aria-label={t("controls.pauseAria")}
          className={dockButtonClass}
          disabled={pauseDisabled ?? disabled}
          onClick={onPause}
          size="compact"
          variant="quiet"
        >
          <Pause aria-hidden="true" className="size-5 shrink-0 lg:size-6" />
          <span className="max-w-full text-center whitespace-normal break-words">
            {t("controls.pause")}
          </span>
        </Button>

        <Button
          aria-label={
            isPlayingSample
              ? t("controls.stopSampleAria")
              : retryMode
                ? t("controls.sampleWordAria")
                : t("controls.samplePageAria")
          }
          className={dockButtonClass}
          disabled={disabled}
          onClick={onReadSample}
          size="compact"
          variant="secondary"
        >
          {isPlayingSample ? (
            <VolumeX
              aria-hidden="true"
              className="size-5 shrink-0 text-primary lg:size-6"
            />
          ) : (
            <Volume2 aria-hidden="true" className="size-5 shrink-0 lg:size-6" />
          )}

          <span className="max-w-full text-center whitespace-normal break-words">
            {isPlayingSample
              ? t("controls.stopSample")
              : retryMode
                ? t("controls.sampleWord")
                : t("controls.samplePage")}
          </span>
        </Button>

        {voiceSettings}

        <Button
          aria-label={
            isListening
              ? t("controls.stopMicAria")
              : retryMode
                ? t("controls.enableMicAria")
                : t("controls.startChildReadAria")
          }
          className={cn(dockButtonClass, "font-extrabold")}
          disabled={disabled}
          onClick={onToggleListening}
          size="compact"
          variant="primary"
        >
          {isListening ? (
            <span className="relative flex size-6 shrink-0 items-center justify-center lg:size-7">
              <span
                aria-hidden="true"
                className="absolute inset-0 animate-ping rounded-full bg-rose-300/60"
              />
              <span
                aria-hidden="true"
                className="absolute inset-0 rounded-full bg-white/25 transition-transform duration-150"
                style={{ transform: `scale(${micPulseScale})` }}
              />
              <span className="absolute -end-0.5 -top-0.5 size-2.5 rounded-full bg-rose-400 ring-2 ring-primary" />
              <Mic
                aria-hidden="true"
                className="relative size-5 text-white lg:size-6"
              />
            </span>
          ) : (
            <Mic aria-hidden="true" className="size-5 shrink-0 lg:size-6" />
          )}

          <span className="max-w-full text-center whitespace-normal break-words">
            {isListening
              ? t("controls.stopMic")
              : retryMode
                ? t("controls.enableMic")
                : t("controls.childRead")}
          </span>
        </Button>

        {!retryMode && (
          <Button
            aria-label={t("controls.choosePageAria")}
            className={dockButtonClass}
            disabled={disabled || !onChoosePage}
            onClick={onChoosePage}
            size="compact"
            variant="quiet"
          >
            <BookOpen
              aria-hidden="true"
              className="size-5 shrink-0 lg:size-6"
            />
            <span className="max-w-full text-center whitespace-normal break-words">
              {t("controls.choosePage")}
            </span>
          </Button>
        )}

        <Button
          aria-label={
            retryMode
              ? t("controls.finishRetryAria")
              : t("controls.finishSessionAria")
          }
          className={dockButtonClass}
          disabled={finishDisabled}
          onClick={onFinish}
          size="compact"
          variant="secondary"
        >
          <Check aria-hidden="true" className="size-5 shrink-0 lg:size-6" />
          <span className="max-w-full text-center whitespace-normal break-words">
            {retryMode ? t("controls.finishRetry") : t("controls.done")}
          </span>
        </Button>
      </nav>
    </div>
  );
}
