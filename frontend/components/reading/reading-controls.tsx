import {
  Check,
  CircleHelp,
  List,
  Mic,
  Pause,
  Volume2,
  VolumeX,
} from "lucide-react";

import { Button } from "@/components/common/button";

interface ReadingControlsProps {
  disabled?: boolean;
  isListening?: boolean;
  isPlayingSample?: boolean;
  onFinish: () => void;
  onHelp: () => void;
  onManualPage: () => void;
  onPause: () => void;
  onReadSample?: () => void;
  onToggleListening?: () => void;
}

export function ReadingControls({
  disabled = false,
  isListening = false,
  isPlayingSample = false,
  onFinish,
  onHelp,
  onManualPage,
  onPause,
  onReadSample,
  onToggleListening,
}: ReadingControlsProps) {
  return (
    <nav
      aria-label="Điều khiển buổi đọc"
      className="grid w-full grid-cols-5 gap-2 rounded-card bg-white p-2 sm:mx-auto sm:max-w-[1008px] sm:gap-3"
    >
      <Button
        aria-label="Tạm dừng buổi đọc"
        className="h-[68px] min-w-0 flex-col gap-0 px-1 text-label sm:h-16 sm:flex-row sm:gap-2 sm:px-3 sm:text-button"
        disabled={disabled}
        onClick={onPause}
        variant="quiet"
      >
        <Pause aria-hidden="true" className="size-6 shrink-0" />
        <span className="truncate">Tạm dừng</span>
      </Button>

      <Button
        aria-label={
          isPlayingSample ? "Dừng đọc mẫu" : "Đọc mẫu toàn trang bằng TTS"
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
          {isPlayingSample ? "Dừng mẫu" : "Đọc mẫu"}
        </span>
      </Button>

      <Button
        aria-label={
          isListening
            ? "Dừng nhận diện giọng nói"
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
        <span className="truncate">{isListening ? "Đang nghe" : "Bé đọc"}</span>
      </Button>

      <Button
        aria-label="Chọn trang hoặc nhận trợ giúp"
        className="h-[68px] min-w-0 flex-col gap-0 px-1 text-label sm:h-16 sm:flex-row sm:gap-2 sm:px-3 sm:text-button"
        disabled={disabled}
        onClick={onManualPage}
        variant="quiet"
      >
        <span className="relative">
          <CircleHelp aria-hidden="true" className="size-6 sm:hidden" />
          <List aria-hidden="true" className="hidden size-6 sm:block" />
        </span>
        <span className="sm:hidden truncate">Giúp</span>
        <span className="hidden sm:inline truncate">Chọn trang</span>
      </Button>

      <Button
        aria-label="Kết thúc buổi đọc"
        className="h-[68px] min-w-0 flex-col gap-0 px-1 text-label sm:h-16 sm:flex-row sm:gap-2 sm:px-3 sm:text-button"
        disabled={disabled}
        onClick={onFinish}
      >
        <Check aria-hidden="true" className="size-6 shrink-0" />
        <span className="truncate">Xong</span>
      </Button>
    </nav>
  );
}
