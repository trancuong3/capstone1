"use client";

import {
  BookOpen,
  Check,
  Mic,
  MoreHorizontal,
  Pause,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useState, type ReactNode } from "react";

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
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);

  return (
    <div className="mx-auto w-full max-w-[1104px]">
      <nav
        aria-label="Điều khiển buổi đọc"
        data-reading-controls
        className={cn(
          "flex items-stretch gap-1.5 sm:grid sm:gap-3",
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
          aria-label="Tạm dừng buổi đọc"
          className="hidden min-h-14 min-w-0 px-2.5 py-1.5 text-sm sm:inline-flex sm:px-4 sm:py-2 sm:text-button"
          disabled={pauseDisabled ?? disabled}
          onClick={onPause}
          variant="quiet"
        >
          <Pause aria-hidden="true" className="size-5 shrink-0 sm:size-6" />
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
          className="order-2 min-h-14 min-w-0 flex-1 flex-col gap-0.5 px-1.5 py-1.5 text-[11px] leading-tight sm:order-none sm:flex-none sm:flex-row sm:gap-2 sm:px-4 sm:py-2 sm:text-button"
          disabled={disabled}
          onClick={onReadSample ?? onHelp}
          variant="secondary"
        >
          {isPlayingSample ? (
            <VolumeX
              aria-hidden="true"
              className="size-5 shrink-0 text-primary"
            />
          ) : (
            <Volume2 aria-hidden="true" className="size-5 shrink-0 sm:size-6" />
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
          <div className="hidden sm:contents">{voiceSettings}</div>
        ) : null}

        <Button
          aria-label={
            isListening
              ? "Dừng nhận diện giọng nói"
              : retryMode
                ? "Bật mic"
                : "Bé đọc với nhận diện giọng nói"
          }
          className="order-1 min-h-14 min-w-0 flex-[1.55] gap-1.5 px-2.5 py-1.5 text-sm font-extrabold sm:order-none sm:flex-none sm:gap-2 sm:px-4 sm:py-2 sm:text-button"
          disabled={disabled}
          onClick={onToggleListening ?? onPause}
          variant="primary"
        >
          {isListening ? (
            <span className="relative flex size-5 shrink-0 items-center justify-center sm:size-6">
              <span className="absolute size-2 rounded-full bg-red-300" />
              <Mic
                aria-hidden="true"
                className="relative size-5 text-white sm:size-6"
              />
            </span>
          ) : (
            <Mic aria-hidden="true" className="size-5 shrink-0 sm:size-6" />
          )}

          <span className="max-w-full text-center whitespace-normal break-words">
            {isListening ? "Dừng mic" : retryMode ? "Bật mic" : "Bé đọc"}
          </span>
        </Button>

        {!retryMode && (
          <Button
            aria-label="Chọn trang"
            className="order-3 min-h-14 min-w-0 flex-1 flex-col gap-0.5 px-1.5 py-1.5 text-[11px] leading-tight sm:order-none sm:flex-none sm:flex-row sm:gap-2 sm:px-4 sm:py-2 sm:text-button"
            disabled={disabled || !onChoosePage}
            onClick={onChoosePage}
            variant="quiet"
          >
            <BookOpen
              aria-hidden="true"
              className="size-5 shrink-0 sm:size-6"
            />
            <span className="max-w-full text-center whitespace-normal break-words">
              Chọn trang
            </span>
          </Button>
        )}

        <Button
          aria-label={retryMode ? "Hoàn thành đọc lại" : "Kết thúc buổi đọc"}
          className={cn(
            "order-4 min-h-14 min-w-0 flex-1 flex-col gap-0.5 px-1.5 py-1.5 text-[11px] leading-tight sm:order-none sm:flex-none sm:flex-row sm:gap-2 sm:px-4 sm:py-2 sm:text-button",
            (retryMode ? Boolean(voiceSettings) : !voiceSettings) &&
              "col-span-2 sm:col-span-1",
          )}
          disabled={finishDisabled}
          onClick={onFinish}
          variant="secondary"
        >
          <Check aria-hidden="true" className="size-5 shrink-0 sm:size-6" />
          <span className="max-w-full text-center whitespace-normal break-words">
            {retryMode ? "Hoàn thành" : "Xong"}
          </span>
        </Button>

        <Button
          aria-expanded={mobileMoreOpen}
          aria-haspopup="dialog"
          aria-label="Mở thêm tùy chọn buổi đọc"
          className="order-5 min-h-14 min-w-12 shrink-0 flex-col gap-0.5 px-2 py-1.5 text-[11px] leading-tight sm:hidden"
          disabled={disabled}
          onClick={() => setMobileMoreOpen(true)}
          variant="quiet"
        >
          <MoreHorizontal aria-hidden="true" className="size-5 shrink-0" />
          <span>Thêm</span>
        </Button>
      </nav>

      {mobileMoreOpen ? (
        <div
          aria-label="Tùy chọn buổi đọc"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-end bg-ink/40 sm:hidden"
          data-testid="reading-mobile-more-sheet"
          onClick={() => setMobileMoreOpen(false)}
          role="dialog"
        >
          <div
            className="flex w-full flex-col gap-3 rounded-t-3xl border-t border-border bg-white px-4 pt-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2 border-b border-border pb-3">
              <h2 className="text-base font-extrabold text-ink">
                Tùy chọn buổi đọc
              </h2>
              <button
                aria-label="Đóng tùy chọn buổi đọc"
                className="inline-flex size-12 items-center justify-center rounded-control text-ink hover:bg-sky"
                onClick={() => setMobileMoreOpen(false)}
                type="button"
              >
                <X aria-hidden="true" className="size-5" />
              </button>
            </div>

            <div className="grid grid-cols-1 gap-2.5">
              <Button
                className="min-h-12 w-full justify-start px-4"
                disabled={pauseDisabled ?? disabled}
                onClick={() => {
                  setMobileMoreOpen(false);
                  onPause();
                }}
                variant="secondary"
              >
                <Pause aria-hidden="true" className="size-5 shrink-0" />
                <span>Tạm dừng buổi đọc</span>
              </Button>

              {onSpellWord ? (
                <Button
                  className="min-h-12 w-full justify-start px-4"
                  disabled={disabled}
                  onClick={() => {
                    setMobileMoreOpen(false);
                    onSpellWord();
                  }}
                  variant="secondary"
                >
                  <Volume2 aria-hidden="true" className="size-5 shrink-0" />
                  <span>Đánh vần từ hiện tại</span>
                </Button>
              ) : null}

              {voiceSettings ? (
                <div className="[&>button]:min-h-12 [&>button]:w-full [&>button]:justify-start [&>button]:px-4">
                  {voiceSettings}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
