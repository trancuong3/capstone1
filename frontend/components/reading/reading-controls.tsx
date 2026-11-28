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

export const READING_DOCK_BUTTON_CLASS =
  "min-h-12 min-w-0 flex-col gap-0.5! px-1 py-1.5 text-[11px] leading-tight sm:px-1.5 sm:text-xs sm:leading-snug @4xl:min-h-14 @4xl:flex-row @4xl:gap-2! @4xl:px-3 @4xl:py-2 @4xl:text-button";

const DOCK_LABEL_CLASS =
  "max-w-full text-center whitespace-normal break-words [overflow-wrap:anywhere] [@media(max-height:520px)]:whitespace-normal! [@media(max-height:520px)]:overflow-visible! [@media(max-height:520px)]:[text-overflow:clip]!";

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
    <div className="@container mx-auto w-full max-w-[1104px]">
      <nav
        aria-label={t("controls.toolbarAria")}
        data-reading-controls
        className={cn(
          "grid items-stretch gap-1 sm:gap-2 lg:gap-3",
          retryMode
            ? voiceSettings
              ? "grid-cols-3 @xs:grid-cols-5 @xl:grid-cols-5"
              : "grid-cols-2 @xs:grid-cols-4 @xl:grid-cols-4"
            : voiceSettings
              ? "grid-cols-3 @xs:grid-cols-5 @xl:grid-cols-6"
              : "grid-cols-3 @xs:grid-cols-5 @xl:grid-cols-5",
        )}
      >
        <Button
          aria-label={t("controls.pauseAria")}
          className={cn(READING_DOCK_BUTTON_CLASS, "order-1 sm:order-none")}
          disabled={pauseDisabled ?? disabled}
          onClick={onPause}
          size="compact"
          variant="quiet"
        >
          <Pause
            aria-hidden="true"
            className="size-4.5 shrink-0 sm:size-5 @4xl:size-6"
          />
          <span className={DOCK_LABEL_CLASS}>{t("controls.pause")}</span>
        </Button>

        <Button
          aria-label={
            isPlayingSample
              ? t("controls.stopSampleAria")
              : retryMode
                ? t("controls.sampleWordAria")
                : t("controls.samplePageAria")
          }
          className={cn(READING_DOCK_BUTTON_CLASS, "order-2 sm:order-none")}
          disabled={disabled}
          onClick={onReadSample}
          size="compact"
          variant="secondary"
        >
          {isPlayingSample ? (
            <VolumeX
              aria-hidden="true"
              className="size-4.5 shrink-0 text-primary sm:size-5 @4xl:size-6"
            />
          ) : (
            <Volume2
              aria-hidden="true"
              className="size-4.5 shrink-0 sm:size-5 @4xl:size-6"
            />
          )}

          <span className={DOCK_LABEL_CLASS}>
            {isPlayingSample
              ? t("controls.stopSample")
              : retryMode
                ? t("controls.sampleWord")
                : t("controls.samplePage")}
          </span>
        </Button>

        {voiceSettings ? (
          <div className="order-4 flex min-w-0 sm:order-none">
            {voiceSettings}
          </div>
        ) : null}

        <Button
          aria-label={
            isListening
              ? t("controls.stopMicAria")
              : retryMode
                ? t("controls.enableMicAria")
                : t("controls.startChildReadAria")
          }
          className={cn(
            READING_DOCK_BUTTON_CLASS,
            "order-3 rounded-xl font-extrabold shadow-sm ring-2 ring-primary/20 sm:order-none sm:rounded-control sm:shadow-none sm:ring-0",
          )}
          disabled={disabled}
          onClick={onToggleListening}
          size="compact"
          variant="primary"
        >
          {isListening ? (
            <span className="relative flex size-6 shrink-0 items-center justify-center @4xl:size-7">
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
                className="relative size-5 text-white @4xl:size-6"
              />
            </span>
          ) : (
            <Mic aria-hidden="true" className="size-5 shrink-0 @4xl:size-6" />
          )}

          <span className={DOCK_LABEL_CLASS}>
            {isListening
              ? t("controls.stopMic")
              : retryMode
                ? t("controls.enableMic")
                : t("controls.childRead")}
          </span>
        </Button>

        {!retryMode && (
          <div
            className={cn(
              "min-w-0",
              voiceSettings
                ? "hidden sm:flex sm:order-none"
                : "order-4 flex sm:order-none",
            )}
          >
            <Button
              aria-label={t("controls.choosePageAria")}
              className={READING_DOCK_BUTTON_CLASS}
              disabled={disabled || !onChoosePage}
              onClick={onChoosePage}
              size="compact"
              variant="quiet"
            >
              <BookOpen
                aria-hidden="true"
                className="size-4.5 shrink-0 sm:size-5 @4xl:size-6"
              />
              <span className={DOCK_LABEL_CLASS}>
                {t("controls.choosePage")}
              </span>
            </Button>
          </div>
        )}

        <Button
          aria-label={
            retryMode
              ? t("controls.finishRetryAria")
              : t("controls.finishSessionAria")
          }
          className={cn(READING_DOCK_BUTTON_CLASS, "order-5 sm:order-none")}
          disabled={finishDisabled}
          onClick={onFinish}
          size="compact"
          variant="secondary"
        >
          <Check
            aria-hidden="true"
            className="size-4.5 shrink-0 sm:size-5 @4xl:size-6"
          />
          <span className={DOCK_LABEL_CLASS}>
            {retryMode ? t("controls.finishRetry") : t("controls.done")}
          </span>
        </Button>
      </nav>
    </div>
  );
}
