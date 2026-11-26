"use client";

import { BookOpen, Check, Mic, Pause, Volume2, VolumeX } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/common/button";
import { useTranslations } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils/cn";

interface ReadingControlsProps {
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
  "min-w-0 flex-col gap-0.5 px-1.5 py-1.5 text-xs leading-snug lg:min-h-14 lg:flex-row lg:gap-2 lg:px-3 lg:py-2 lg:text-button";

export function ReadingControls({
  pauseDisabled,
  disabled = false,
  isListening = false,
  isPlayingSample = false,
  onFinish,
  onHelp,
  onPause,
  onReadSample,
  onToggleListening,
  retryMode = false,
  onChoosePage,
  voiceSettings,
}: ReadingControlsProps) {
  const t = useTranslations("reading");
  const finishDisabled = disabled;

  return (
    <div className="mx-auto w-full max-w-[1104px]">
      <nav
        aria-label={t("controls.toolbarAria")}
        data-reading-controls
        className={cn(
          "grid grid-cols-3 gap-1.5 sm:gap-2 lg:gap-3",
          retryMode
            ? voiceSettings
              ? "sm:grid-cols-5"
              : "sm:grid-cols-4"
            : voiceSettings
              ? "sm:grid-cols-6"
              : "sm:grid-cols-5",
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
          onClick={onReadSample ?? onHelp}
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
          onClick={onToggleListening ?? onPause}
          size="compact"
          variant="primary"
        >
          {isListening ? (
            <span className="relative flex size-5 shrink-0 items-center justify-center lg:size-6">
              <span className="absolute size-2 rounded-full bg-red-300" />
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
          className={cn(
            dockButtonClass,
            (retryMode ? Boolean(voiceSettings) : !voiceSettings) &&
              "col-span-2 sm:col-span-1",
          )}
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
