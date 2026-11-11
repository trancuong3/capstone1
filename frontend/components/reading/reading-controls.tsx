import { Check, CircleHelp, Mic, Pause, Volume2, VolumeX } from "lucide-react";

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
  onToggleListening?: () => void;
  retryMode?: boolean;
  /** Extra control (voice settings) placed right after the sample button. */
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
  voiceSettings,
}: ReadingControlsProps) {
  const finishDisabled = disabled;

  return (
    <div className="@container sticky top-0 z-20 mx-auto w-full max-w-[1008px]">
      <nav
        aria-label="Điều khiển buổi đọc"
        data-reading-controls
        className={cn(
          "grid w-full grid-cols-2 gap-2 rounded-card border border-border bg-white p-2 shadow-sm @min-[320px]:grid-cols-3 @min-[900px]:gap-3",
          voiceSettings
            ? "@min-[900px]:grid-cols-6"
            : "@min-[900px]:grid-cols-5",
        )}
      >
        <Button
          aria-label="Tạm dừng buổi đọc"
          className="h-auto! min-h-[68px]! min-w-0 flex-col gap-0! px-1! py-1! text-label! font-bold! @min-[900px]:h-16! @min-[900px]:min-h-16! @min-[900px]:flex-row @min-[900px]:gap-2! @min-[900px]:px-3! @min-[900px]:py-2! @min-[900px]:text-button!"
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
          className="h-auto! min-h-[68px]! min-w-0 flex-col gap-0! px-1! py-1! text-label! font-bold! @min-[900px]:h-16! @min-[900px]:min-h-16! @min-[900px]:flex-row @min-[900px]:gap-2! @min-[900px]:px-3! @min-[900px]:py-2! @min-[900px]:text-button!"
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
          className="order-first h-auto! min-h-[68px]! min-w-0 flex-col gap-0! px-1! py-1! text-label! font-bold! @min-[900px]:h-16! @min-[900px]:min-h-16! @min-[900px]:flex-row @min-[900px]:gap-2! @min-[900px]:px-3! @min-[900px]:py-2! @min-[900px]:text-button!"
          disabled={disabled}
          onClick={onToggleListening ?? onPause}
          variant="primary"
        >
          {isListening ? (
            <span className="relative flex size-6 items-center justify-center shrink-0">
              <span className="absolute inline-flex size-4 animate-ping rounded-full bg-red-400 opacity-75" />
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
          aria-label="Nhờ gia sư giúp đọc"
          className="h-auto! min-h-[68px]! min-w-0 flex-col gap-0! px-1! py-1! text-label! font-bold! @min-[900px]:h-16! @min-[900px]:min-h-16! @min-[900px]:flex-row @min-[900px]:gap-2! @min-[900px]:px-3! @min-[900px]:py-2! @min-[900px]:text-button!"
          disabled={disabled || retryMode}
          onClick={onHelp}
          variant="quiet"
        >
          <CircleHelp aria-hidden="true" className="size-6 shrink-0" />
          <span className="max-w-full text-center whitespace-normal break-words">
            Gia sư
          </span>
        </Button>

        <Button
          aria-label={retryMode ? "Hoàn thành đọc lại" : "Kết thúc buổi đọc"}
          className="h-auto! min-h-[68px]! min-w-0 flex-col gap-0! px-1! py-1! text-label! font-bold! @min-[900px]:h-16! @min-[900px]:min-h-16! @min-[900px]:flex-row @min-[900px]:gap-2! @min-[900px]:px-3! @min-[900px]:py-2! @min-[900px]:text-button!"
          disabled={finishDisabled}
          onClick={onFinish}
          variant="quiet"
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
