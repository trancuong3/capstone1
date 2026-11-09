import { Check, CircleHelp, Mic, Pause, Volume2, VolumeX } from "lucide-react";

import type { ReactNode } from "react";

import { Button } from "@/components/common/button";
import { cn } from "@/lib/utils/cn";

interface ReadingControlsProps {
  disabled?: boolean;
  isListening?: boolean;
  isPlayingSample?: boolean;
  onFinish: () => void;
  onHelp: () => void;
  onPause: () => void;
  onReadSample?: () => void;
  onToggleListening?: () => void;
  retryMode?: boolean;
  /** Extra control (voice settings) placed right after the sample button. */
  voiceSettings?: ReactNode;
}

export function ReadingControls({
  disabled = false,
  isListening = false,
  isPlayingSample = false,
  onFinish,
  onHelp,
  onPause,
  onReadSample,
  onToggleListening,
  retryMode = false,
  voiceSettings,
}: ReadingControlsProps) {
  const finishDisabled = disabled;

  return (
    <nav
      aria-label="Điều khiển buổi đọc"
      className={cn(
        "grid w-full gap-2 rounded-card bg-white p-2 sm:mx-auto sm:max-w-[1008px] sm:gap-3",
        voiceSettings ? "grid-cols-6" : "grid-cols-5",
      )}
    >
      <Button
        aria-label="Tạm dừng buổi đọc"
        className="h-[68px] min-w-0 flex-col gap-0 px-1 text-label sm:h-16 sm:flex-row sm:gap-2 sm:px-3 sm:text-button"
        disabled={disabled || retryMode}
        onClick={onPause}
        variant="quiet"
      >
        <Pause aria-hidden="true" className="size-6 shrink-0" />
        <span className="truncate">Tạm dừng</span>
      </Button>

      <Button
        aria-label={
          isPlayingSample
            ? "Dừng đọc mẫu"
            : retryMode
              ? "Nghe mẫu từ cần đọc lại"
              : "Đọc mẫu toàn trang bằng TTS"
        }
        className="h-[68px] min-w-0 flex-col gap-0 px-1 text-label sm:h-16 sm:flex-row sm:gap-2 sm:px-3 sm:text-button"
        disabled={disabled}
        onClick={onReadSample ?? onHelp}
        variant="secondary"
      >
        {isPlayingSample ? (
          <VolumeX
            aria-hidden="true"
            className="size-6 shrink-0 text-primary animate-pulse"
          />
        ) : (
          <Volume2 aria-hidden="true" className="size-6 shrink-0" />
        )}

        <span className="truncate">
          {isPlayingSample
            ? "Dừng mẫu"
            : retryMode
              ? "Nghe mẫu từ"
              : "Đọc cả đoạn"}
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
        className="h-[68px] min-w-0 flex-col gap-0 px-1 text-label sm:h-16 sm:flex-row sm:gap-2 sm:px-3 sm:text-button"
        disabled={disabled}
        onClick={onToggleListening ?? onPause}
        variant={isListening ? "primary" : "secondary"}
      >
        {isListening ? (
          <span className="relative flex size-6 items-center justify-center shrink-0">
            <span className="absolute inline-flex size-4 animate-ping rounded-full bg-red-400 opacity-75" />
            <Mic aria-hidden="true" className="relative size-6 text-white" />
          </span>
        ) : (
          <Mic aria-hidden="true" className="size-6 shrink-0" />
        )}

        <span className="truncate">
          {isListening ? "Dừng mic" : retryMode ? "Bật mic" : "Bé đọc"}
        </span>
      </Button>

      <Button
        aria-label="Nhờ gia sư giúp đọc"
        className="h-[68px] min-w-0 flex-col gap-0 px-1 text-label sm:h-16 sm:flex-row sm:gap-2 sm:px-3 sm:text-button"
        disabled={disabled || retryMode}
        onClick={onHelp}
        variant="quiet"
      >
        <CircleHelp aria-hidden="true" className="size-6 shrink-0" />
        <span className="truncate">Gia sư</span>
      </Button>

      <Button
        aria-label={retryMode ? "Hoàn thành đọc lại" : "Kết thúc buổi đọc"}
        className="h-[68px] min-w-0 flex-col gap-0 px-1 text-label sm:h-16 sm:flex-row sm:gap-2 sm:px-3 sm:text-button"
        disabled={finishDisabled}
        onClick={onFinish}
      >
        <Check aria-hidden="true" className="size-6 shrink-0" />
        <span className="truncate">{retryMode ? "Hoàn thành" : "Xong"}</span>
      </Button>
    </nav>
  );
}
