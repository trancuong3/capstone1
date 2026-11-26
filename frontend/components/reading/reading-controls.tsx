"use client";

import {
  BookOpen,
  Check,
  Mic,
  Pause,
  Sparkles,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/common/button";
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
  "min-h-12 min-w-0 flex-col gap-0.5 px-1.5 py-1.5 text-xs leading-snug lg:min-h-14 lg:flex-row lg:gap-2 lg:px-3 lg:py-2 lg:text-button";

export function ReadingControls({
  pauseDisabled,
  disabled = false,
  isListening = false,
  isPlayingSample = false,
  onFinish,
  onHelp,
  onPause,
  onReadSample,
  onSpellWord,
  onToggleListening,
  retryMode = false,
  onChoosePage,
  voiceSettings,
}: ReadingControlsProps) {
  const finishDisabled = disabled;
  const showMobileSpell = Boolean(onSpellWord) && !retryMode;

  return (
    <div className="mx-auto w-full max-w-[1104px]">
      <nav
        aria-label="Điều khiển buổi đọc"
        data-mobile-dock-cols={showMobileSpell ? "4" : "3"}
        data-reading-controls
        className={cn(
          "grid grid-cols-3 gap-1.5 md:gap-2 lg:gap-3",
          retryMode
            ? voiceSettings
              ? "md:grid-cols-5"
              : "md:grid-cols-4"
            : voiceSettings
              ? "md:grid-cols-6"
              : "md:grid-cols-5",
        )}
      >
        <Button
          aria-label="Tạm dừng buổi đọc"
          className={dockButtonClass}
          data-desktop-only-control="true"
          disabled={pauseDisabled ?? disabled}
          onClick={onPause}
          size="compact"
          variant="quiet"
        >
          <Pause aria-hidden="true" className="size-5 shrink-0 lg:size-6" />
          <span className="max-w-full text-center whitespace-normal break-words">
            Tạm dừng
          </span>
        </Button>

        <Button
          aria-label={
            isPlayingSample
              ? "Dừng đọc mẫu"
              : retryMode
                ? "Nghe mẫu từ cần đọc lại"
                : "Nghe đọc mẫu cả trang"
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
              ? "Dừng mẫu"
              : retryMode
                ? "Nghe mẫu từ"
                : "Nghe mẫu"}
          </span>
        </Button>

        {voiceSettings ? (
          <div className="contents" data-voice-settings-wrap="true">
            {voiceSettings}
          </div>
        ) : null}

        <Button
          aria-label={
            isListening
              ? "Dừng nhận diện giọng nói"
              : retryMode
                ? "Bật mic"
                : "Bé đọc với nhận diện giọng nói"
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
            {isListening ? "Dừng mic" : retryMode ? "Bật mic" : "Bé đọc"}
          </span>
        </Button>

        {showMobileSpell ? (
          <Button
            aria-label="Đánh vần từ này"
            className={cn(dockButtonClass, "md:hidden")}
            disabled={disabled}
            onClick={onSpellWord}
            size="compact"
            variant="quiet"
          >
            <Sparkles
              aria-hidden="true"
              className="size-5 shrink-0 text-primary"
            />
            <span className="max-w-full text-center whitespace-normal break-words">
              Đánh vần
            </span>
          </Button>
        ) : null}

        {!retryMode && (
          <Button
            aria-label="Chọn trang"
            className={dockButtonClass}
            data-desktop-only-control="true"
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
              Chọn trang
            </span>
          </Button>
        )}

        <Button
          aria-label={retryMode ? "Hoàn thành đọc lại" : "Kết thúc buổi đọc"}
          className={cn(
            dockButtonClass,
            (retryMode ? Boolean(voiceSettings) : !voiceSettings) &&
              "col-span-2 md:col-span-1",
          )}
          disabled={finishDisabled}
          onClick={onFinish}
          size="compact"
          variant="secondary"
        >
          <Check aria-hidden="true" className="size-5 shrink-0 lg:size-6" />
          <span className="max-w-full text-center whitespace-normal break-words">
            {retryMode ? "Hoàn thành" : "Xong"}
          </span>
        </Button>
      </nav>
    </div>
  );
}
