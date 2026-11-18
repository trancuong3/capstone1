import { Check, BookOpen, Mic, Pause, Volume2, VolumeX } from "lucide-react";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { Button } from "@/components/common/button";

interface ReadingControlsProps {
  pauseDisabled?: boolean;
  disabled?: boolean;
  isListening?: boolean;
  isPlayingSample?: boolean;
  onFinish: () => void;
  onHelp: () => void;
  onPause: () => void;
  onReadSample?: () => void;
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
  onToggleListening,
  retryMode = false,
  onChoosePage,
  voiceSettings,
}: ReadingControlsProps) {
  const finishDisabled = disabled;

  return (
    <div className="mx-auto w-full max-w-[1104px]">
      <nav
        aria-label="Điều khiển buổi đọc"
        data-reading-controls
        className={cn(
          "grid grid-cols-2 gap-2 sm:gap-3",
          voiceSettings ? "sm:grid-cols-6" : "sm:grid-cols-5",
        )}
      >
        <Button
          aria-label="Tạm dừng buổi đọc"
          className="min-h-14 min-w-0"
          disabled={pauseDisabled ?? disabled}
          onClick={onPause}
          variant="quiet"
        >
          <Pause aria-hidden="true" className="size-6 shrink-0" />
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
          className="min-h-14 min-w-0"
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
            <Volume2 aria-hidden="true" className="size-6 shrink-0" />
          )}

          <span className="max-w-full text-center whitespace-normal break-words">
            {isPlayingSample
              ? "Dừng mẫu"
              : retryMode
                ? "Nghe mẫu từ"
                : "Nghe mẫu"}
          </span>
        </Button>
        {voiceSettings}
        <Button
          aria-label={
            isListening
              ? "Dừng nhận diện giọng nói"
              : retryMode
                ? "Bật mic"
                : "Bé đọc với nhận diện giọng nói"
          }
          className="min-h-14 min-w-0"
          disabled={disabled}
          onClick={onToggleListening ?? onPause}
          variant="primary"
        >
          {isListening ? (
            <span className="relative flex size-6 items-center justify-center shrink-0">
              <span className="absolute size-2 rounded-full bg-red-300" />
              <Mic aria-hidden="true" className="relative size-6 text-white" />
            </span>
          ) : (
            <Mic aria-hidden="true" className="size-6 shrink-0" />
          )}

          <span className="max-w-full text-center whitespace-normal break-words">
            {isListening ? "Dừng mic" : retryMode ? "Bật mic" : "Bé đọc"}
          </span>
        </Button>

        <Button
          aria-label="Chọn trang"
          className="min-h-14 min-w-0"
          disabled={disabled || retryMode || !onChoosePage}
          onClick={onChoosePage}
          variant="quiet"
        >
          <BookOpen aria-hidden="true" className="size-6 shrink-0" />
          <span className="max-w-full text-center whitespace-normal break-words">
            Chọn trang
          </span>
        </Button>

        <Button
          aria-label={retryMode ? "Hoàn thành đọc lại" : "Kết thúc buổi đọc"}
          className="min-h-14 min-w-0"
          disabled={finishDisabled}
          onClick={onFinish}
          variant="secondary"
        >
          <Check aria-hidden="true" className="size-6 shrink-0" />
          <span className="max-w-full text-center whitespace-normal break-words">
            {retryMode ? "Hoàn thành" : "Xong"}
          </span>
        </Button>
      </nav>
    </div>
  );
}
